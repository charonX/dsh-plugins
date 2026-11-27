import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistryPlugin, { type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmPlugin, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionPlugin, { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SubprocessLocalPlugin from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import TokenMeterPlugin from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'
import ToolsPlugin from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExternalAgentAdapter, ExternalAsyncEvent, ExternalTurnEvent } from '../src/adapters/base.ts'
import type { ExternalAgentId } from '../src/types.ts'
import { ExternalSessionStore } from '../src/session-store.ts'
import { installExternalTurnDriver } from '../src/turn-driver.ts'

/**
 * Enforces the native V4 session format lifecycle invariants from
 * `session-format-v3-to-v4/src/relationships.ts` (so cold-loading a persisted
 * session log never throws `SessionFormatError`).
 */
function assertV4ToolStepLifecycle(events: readonly SessionEvent[]): void {
  let openTurn: number | null = null
  let openStep: number | null = null
  let nextTurn = 1
  let nextStep = 1
  const tools = new Map<string, { name: unknown; arguments: unknown; started: boolean }>()

  for (const event of events) {
    if (event.type === 'turn/start') {
      expect(openTurn, `turn/start seq=${event.seq} while turn ${openTurn} still open`).toBeNull()
      expect(event.data.turn).toBe(nextTurn)
      openTurn = event.data.turn
      nextStep = 1
      tools.clear()
      continue
    }
    if (event.type === 'turn/end') {
      expect(event.data.turn).toBe(openTurn)
      expect(openStep, `turn/end while step ${openStep} still open`).toBeNull()
      expect([...tools.keys()], 'turn/end leaves unresolved tool calls').toEqual([])
      openTurn = null
      nextTurn += 1
      continue
    }
    if (event.type === 'step/start') {
      expect(event.data.turn).toBe(openTurn)
      expect(openStep, `step/start while step ${openStep} still open`).toBeNull()
      expect(event.data.step).toBe(nextStep)
      openStep = nextStep
      continue
    }
    if (event.type === 'step/end') {
      expect(event.data.turn, `step/end seq=${event.seq} turn mismatch`).toBe(openTurn)
      expect(event.data.step, `step/end seq=${event.seq} step mismatch`).toBe(openStep)
      expect([...tools.keys()], `step/end turn=${event.data.turn} step=${event.data.step} leaves unresolved tool calls`).toEqual([])
      openStep = null
      nextStep += 1
      continue
    }
    if (event.type === 'assistant/message') {
      expect(event.data.turn).toBe(openTurn)
      expect(event.data.step).toBe(openStep)
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call') continue
        expect(tools.has(block.id), `assistant/message repeats advertised tool call ${block.id}`).toBe(false)
        tools.set(block.id, { name: block.name, arguments: block.arguments, started: false })
      }
      continue
    }
    if (event.type === 'tool/call') {
      expect(event.data.turn).toBe(openTurn)
      expect(event.data.step).toBe(openStep)
      const pending = tools.get(event.data.callId)
      expect(pending, `tool/call ${event.data.callId} has no advertised tool lifecycle`).toBeDefined()
      expect(pending!.started, `tool/call ${event.data.callId} started twice`).toBe(false)
      expect(pending!.name).toBe(event.data.name)
      expect(pending!.arguments).toBe(event.data.arguments)
      pending!.started = true
      continue
    }
    if (event.type === 'tool/result') {
      expect(event.data.turn, `tool/result seq=${event.seq} turn mismatch`).toBe(openTurn)
      expect(event.data.step, `tool/result seq=${event.seq} step mismatch (step already closed?)`).toBe(openStep)
      const callId = event.data.message.source.callId
      expect(event.data.message.toolCallId, `tool/result seq=${event.seq} toolCallId mismatch`).toBe(callId)
      const pending = tools.get(callId)
      expect(pending, `tool/result ${callId} has no advertised tool lifecycle`).toBeDefined()
      if (!pending!.started) {
        expect(event.data.error?.code, `unstarted tool/result ${callId} lacks TOOL_NOT_STARTED repair`).toBe('TOOL_NOT_STARTED')
      }
      tools.delete(callId)
    }
  }
  expect(openTurn).toBeNull()
  expect(openStep).toBeNull()
  expect([...tools.keys()]).toEqual([])
}

describe('external turn driver', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn()
    }
  })

  it('intercepts pre-step, emits live frames, projects tool cards, and completes turn without double-running tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-turn-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-ext-1', 'agy')

    const seenToolExecs: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      seenToolExecs.push(exec.name)
      return next()
    }, { global: true })

    const fakeAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'session', externalSessionId: 'agy-remote-77' })
        await request.onEvent({ type: 'thinking_delta', delta: 'Inspecting files' })
        await request.onEvent({ type: 'tool_start', callId: 'call-1', name: 'bash', arguments: '{"cmd":"pwd"}' })
        await request.onEvent({ type: 'tool_result', callId: 'call-1', content: dir, isError: false })
        await request.onEvent({ type: 'text_delta', delta: 'Current directory is ' + dir })
        return { externalSessionId: 'agy-remote-77', finalText: 'Current directory is ' + dir }
      },
    }

    const disposeDriver = installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', fakeAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    })
    cleanups.push(disposeDriver)

    const frames: AssistantStreamFrame[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => {
      frames.push(frame)
    }, { global: true })

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => {
      events.push(event)
    }, { global: true })

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => {
      errors.push(error)
    }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-ext-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    const agent: Agent = handle.agent
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Where am I?' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(seenToolExecs).toEqual([])
    expect(store.get('sess-ext-1')?.externalSessionId).toBe('agy-remote-77')

    const eventTypes = events.map(e => e.type)
    expect(eventTypes).toContain('turn/start')
    expect(eventTypes).toContain('user/message')
    expect(eventTypes).toContain('tool/call')
    expect(eventTypes).toContain('tool/result')
    expect(eventTypes).toContain('assistant/message')
    expect(eventTypes).toContain('turn/end')

    expect(frames.some(f => f.type === 'start')).toBe(true)
    expect(frames.some(f => f.type === 'chunk' && f.chunk.type === 'reasoning-delta')).toBe(true)
    expect(frames.some(f => f.type === 'chunk' && f.chunk.type === 'text-delta')).toBe(true)
    expect(frames.some(f => f.type === 'end' && f.outcome.kind === 'committed')).toBe(true)

    const turnEnd = events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe('completed')
    assertV4ToolStepLifecycle(events)
  })

  it('rejects mismatched external model provider on a locked session and allows switching models within the same agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-model-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-ext-2', 'claude-code')

    const seenModels: Array<string | undefined> = []
    const fakeClaude: ExternalAgentAdapter = {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'claude',
        models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }],
        defaultModel: 'sonnet',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        seenModels.push(request.model)
        await request.onEvent({ type: 'text_delta', delta: `ok:${request.model}` })
        return { finalText: `ok:${request.model}` }
      },
    }

    const disposeDriver = installExternalTurnDriver({
      ctx,
      adapters: new Map([['claude-code', fakeClaude]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    })
    cleanups.push(disposeDriver)

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => {
      errors.push(error)
    }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-ext-2'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-claude-code', model: 'sonnet' },
    })
    cleanups.push(() => handle.dispose())

    // Switch model within the same agent -> allowed and passed through.
    handle.agent.model.select({ provider: 'ext-claude-code', model: 'opus' })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'check opus' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(seenModels).toEqual(['opus'])
    expect(errors).toEqual([])

    // Switch model to a different agent provider -> rejected loudly.
    handle.agent.model.select({ provider: 'ext-pi', model: 'default' })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'wrong agent model' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(errors.length).toBe(1)
    expect(String(errors[0])).toContain('locked to "claude-code"')
  })

  it('auto-routes unpresetted task sessions (e.g. dsh-manager) selecting an ext-* model and passes /commands verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-task-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    const seenPrompts: string[] = []
    const fakeClaude: ExternalAgentAdapter = {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'claude',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        seenPrompts.push(request.prompt)
        await request.onEvent({ type: 'text_delta', delta: 'reviewed' })
        return { finalText: 'reviewed' }
      },
    }

    const disposeDriver = installExternalTurnDriver({
      ctx,
      adapters: new Map([['claude-code', fakeClaude]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    })
    cleanups.push(disposeDriver)

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) }, { global: true })

    // No store pre-binding and no agentPreset — mirrors dsh-manager creating a task with an ext-* model.
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('manager-task-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-claude-code', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '/code-review --fix' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(errors).toEqual([])
    expect(seenPrompts).toEqual(['/code-review --fix'])
    expect(store.get('manager-task-1')?.agentId).toBe('claude-code')
  })

  it('forwards image bytes to external adapters, feeds native ContextMeter + UsagePill projections, and tracks subagent tasks across concurrent steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-rich-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(TokenMeterPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const fakeRef: ImageAttachmentRef = {
      attachmentId: AttachmentId('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
      name: 'shot.png',
    }
    const mockAttachments = {
      readImage: async () => ({
        ref: fakeRef,
        data: new Uint8Array([1, 2, 3]),
      }),
      imageHostPath: () => join(dir, 'shot.png'),
      fileHostPath: () => undefined,
    } as unknown as AttachmentStore
    ctx.provide('attachments')
    ctx.set('attachments', mockAttachments)

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-rich-1', 'claude-code')

    let seenImagesCount = 0
    let seenImageBase64 = ''
    let seenTasksDuringRun = 0
    let seenLastToolDuringRun: string | undefined

    const fakeClaude: ExternalAgentAdapter = {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'claude',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        seenImagesCount = request.images?.length ?? 0
        seenImageBase64 = request.images?.[0]?.base64 ?? ''

        await request.onEvent({
          type: 'tool_start',
          callId: 'tu-sub-1',
          name: 'Agent',
          arguments: '{"description":"Inspect auth","subagent_type":"Explore"}',
        })
        await request.onEvent({
          type: 'task_started',
          taskId: 'sub-1',
          toolUseId: 'tu-sub-1',
          description: 'Inspect auth',
          subagentType: 'Explore',
        })
        await request.onEvent({
          type: 'task_progress',
          taskId: 'sub-1',
          toolUseId: 'tu-sub-1',
          lastToolName: 'Grep',
          summary: 'Scanning handlers',
        })
        const activeSnapshot = store.getTasks('sess-rich-1')
        seenTasksDuringRun = activeSnapshot.length
        seenLastToolDuringRun = activeSnapshot[0]?.lastToolName

        // Intermediate text while tool is still open must open a fresh step instead of writing to an ended attempt.
        await request.onEvent({ type: 'text_delta', delta: 'Checking subagent progress...' })
        await request.onEvent({
          type: 'task_completed',
          taskId: 'sub-1',
          toolUseId: 'tu-sub-1',
          status: 'completed',
          summary: 'Inspected 2 files',
        })
        await request.onEvent({
          type: 'tool_result',
          callId: 'tu-sub-1',
          content: 'Inspected 2 files',
          isError: false,
        })
        await request.onEvent({
          type: 'usage',
          inputTokens: 1_200,
          outputTokens: 350,
          cacheReadTokens: 800,
          contextWindow: 200_000,
          isTurnTotal: true,
        })
        await request.onEvent({ type: 'text_delta', delta: 'All good.' })
        return { finalText: 'Checking subagent progress...All good.' }
      },
    }

    const disposeDriver = installExternalTurnDriver({
      ctx,
      adapters: new Map([['claude-code', fakeClaude]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    })
    cleanups.push(disposeDriver)

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-rich-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-claude-code', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    const richEvents: SessionEvent[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id === 'sess-rich-1') richEvents.push(event)
    }, { global: true })

    handle.agent.followup(createUserMessage({
      content: [
        { type: 'text', text: 'Check this screenshot' },
        { type: 'image', attachment: fakeRef },
      ],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    assertV4ToolStepLifecycle(richEvents)

    expect(seenImagesCount).toBe(1)
    expect(seenImageBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    expect(seenTasksDuringRun).toBe(1)
    expect(seenLastToolDuringRun).toBe('Grep')

    const projections = ctx.sessionProjections.snapshot(handle.agent.session).values
    expect(projections.contextPressure?.contextWindow).toBe(200_000)
    expect(projections.contextPressure?.pressureTokens).toBe(2_000)
    expect(projections.tokenUsage).toEqual({
      uncachedInputTokens: 1_200,
      outputTokens: 350,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    })
  })

  it('opens a new step cleanly for sequential tool batches and preserves chronological step ordering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-seq-steps-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-seq-1', 'agy')

    const fakeAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'text_delta', delta: 'Step 1 plan.' })
        await request.onEvent({ type: 'tool_start', callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' })
        await request.onEvent({ type: 'tool_result', callId: 'call-1', content: 'ok-1', isError: false })
        await request.onEvent({ type: 'tool_start', callId: 'call-2', name: 'edit', arguments: '{"path":"a.ts"}' })
        await request.onEvent({ type: 'tool_result', callId: 'call-2', content: 'ok-2', isError: false })
        await request.onEvent({ type: 'text_delta', delta: 'Final answer.' })
        return { finalText: 'Step 1 plan.Final answer.' }
      },
    }

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', fakeAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-seq-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run sequential steps' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const assistantMsgs = events.filter((e): e is Extract<SessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message')
    expect(assistantMsgs.map(m => m.data.step)).toEqual([1, 2, 3])
    expect(assistantMsgs[0]?.data.message.content.map(b => b.type)).toEqual(['text', 'tool-call'])
    expect(assistantMsgs[1]?.data.message.content.map(b => b.type)).toEqual(['tool-call'])
    expect(assistantMsgs[2]?.data.message.content).toEqual([{ type: 'text', text: 'Final answer.' }])

    const toolCalls = events.filter((e): e is Extract<SessionEvent, { type: 'tool/call' }> => e.type === 'tool/call')
    const toolResults = events.filter((e): e is Extract<SessionEvent, { type: 'tool/result' }> => e.type === 'tool/result')
    expect(toolCalls.map(t => t.data.step)).toEqual([1, 2])
    expect(toolResults.map(t => t.data.step)).toEqual([1, 2])
    assertV4ToolStepLifecycle(events)
  })

  it('continues background tasks into a wakeup turn cleanly and closes session pool on agent/disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-bg-wakeup-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-bg-1', 'agy')

    const asyncListeners = new Set<(event: ExternalAsyncEvent) => void>()
    const bufferedWakeup: ExternalTurnEvent[] = []
    const closedSessions: string[] = []

    const fakePersistentAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      subscribeBackground: (_sid, listener) => {
        asyncListeners.add(listener)
        return () => { asyncListeners.delete(listener) }
      },
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'session', externalSessionId: 'acp-bg-99' })
        await request.onEvent({
          type: 'tool_start',
          callId: 'bg-cmd-1',
          name: 'pnpm test',
          toolName: 'run_command',
          title: 'pnpm test',
          arguments: '{"CommandLine":"pnpm test","WaitMsBeforeAsync":500}',
        })
        await request.onEvent({ type: 'text_delta', delta: 'Running tests in background.' })
        return {
          externalSessionId: 'acp-bg-99',
          finalText: 'Running tests in background.',
          pendingToolCallIds: ['bg-cmd-1'],
        }
      },
      drainWakeupTurn: async (_sid, _signal, onEvent) => {
        for (const evt of bufferedWakeup.splice(0)) {
          await onEvent(evt)
        }
        return {
          externalSessionId: 'acp-bg-99',
          finalText: 'All 24 tests passed!',
        }
      },
      closeSession: async (sid) => {
        closedSessions.push(sid)
      },
    }

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', fakePersistentAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-bg-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })

    // Turn 1 starts background run_command and yields cleanly.
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run tests' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(store.isBackgroundActive('sess-bg-1')).toBe(true)
    expect(store.getTasks('sess-bg-1')).toEqual([
      expect.objectContaining({ taskId: 'bg-cmd-1', label: 'Command', status: 'running' }),
    ])

    // Background completion + reactive wakeup arrives after Turn 1 ended.
    const completionEvt: ExternalTurnEvent = {
      type: 'tool_result',
      callId: 'bg-cmd-1',
      content: '24 passed',
      isError: false,
    }
    const proseEvt: ExternalTurnEvent = {
      type: 'text_delta',
      delta: 'All 24 tests passed!',
    }
    bufferedWakeup.push(completionEvt, proseEvt)
    for (const l of asyncListeners) l(completionEvt)
    expect(store.getTasks('sess-bg-1')[0]?.status).toBe('completed')

    for (const l of asyncListeners) l({ type: 'wakeup_ready' })
    await handle.agent.whenIdle()

    expect(store.isBackgroundActive('sess-bg-1')).toBe(false)
    expect(store.getTasks('sess-bg-1')).toEqual([])

    const turnStarts = events.filter((e): e is Extract<SessionEvent, { type: 'turn/start' }> => e.type === 'turn/start')
    expect(turnStarts.map(e => e.data.turn)).toEqual([1, 2])

    // Turn 2 must NOT synthesize a fake user chat bubble.
    const userMsgs = events.filter((e): e is Extract<SessionEvent, { type: 'user/message' }> => e.type === 'user/message')
    expect(userMsgs).toHaveLength(1)

    const assistantMsgs = events.filter((e): e is Extract<SessionEvent, { type: 'assistant/message' }> => e.type === 'assistant/message')
    expect(assistantMsgs.some(m => m.data.turn === 2 && m.data.message.content.some(b => b.type === 'text' && b.text === 'All 24 tests passed!'))).toBe(true)

    const toolResults = events.filter((e): e is Extract<SessionEvent, { type: 'tool/result' }> => e.type === 'tool/result')
    expect(toolResults.some(r => r.data.turn === 2 && r.data.message.content.some(b => b.type === 'text' && b.text === '24 passed'))).toBe(true)

    await handle.dispose()
    expect(closedSessions).toEqual([]) // handle.dispose triggers agent/disposed on adapter via index.ts; coordinator unsubscribes here.
    expect(asyncListeners.size).toBe(0)
    assertV4ToolStepLifecycle(events)
  })

  it('maintains valid V4 step/tool lifecycle when text/thinking follows open tool calls, parallel tools overlap, or synthetic tasks settle across steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-v4-lifecycle-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-v4-1', 'agy')

    const fakeAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        // Scenario 1: parallel tools A & B in same step, plus text_delta while A/B remain open before late results settle
        await request.onEvent({ type: 'thinking_delta', delta: 'Inspecting workspace' })
        await request.onEvent({ type: 'tool_start', callId: 'call-par-1', name: 'read_file', arguments: '{"path":"a.ts"}' })
        await request.onEvent({ type: 'tool_start', callId: 'call-par-2', name: 'read_file', arguments: '{"path":"b.ts"}' })
        await request.onEvent({ type: 'text_delta', delta: 'Reading files in parallel...' })
        await request.onEvent({ type: 'tool_result', callId: 'call-par-1', content: 'contents-a', isError: false })
        await request.onEvent({ type: 'tool_result', callId: 'call-par-2', content: 'contents-b', isError: false })

        // Scenario 2: parallel tool_start while a backgrounded call result settles alongside it, plus duplicate start guard
        await request.onEvent({ type: 'text_delta', delta: 'Checking question next' })
        await request.onEvent({ type: 'tool_start', callId: 'call-ask-1', name: 'Run ask_question', arguments: '{}' })
        await request.onEvent({ type: 'tool_start', callId: 'call-ask-1', name: 'Run ask_question', arguments: '{}' })
        await request.onEvent({ type: 'thinking_delta', delta: 'Waiting for answer' })
        await request.onEvent({ type: 'text_delta', delta: 'Please confirm an option.' })
        // Tool result arrives later in the same turn (after narrative step split!)
        await request.onEvent({ type: 'tool_result', callId: 'call-ask-1', content: 'User answered Yes', isError: false })

        // Scenario 3: synthetic task_started followed by text_delta then task_completed later in same turn
        await request.onEvent({ type: 'task_started', taskId: 'sub-9', description: 'Run audit' })
        await request.onEvent({ type: 'text_delta', delta: 'Subagent running in parallel.' })
        await request.onEvent({ type: 'task_completed', taskId: 'sub-9', status: 'completed', summary: 'Audit clean' })

        return { finalText: 'Audit clean' }
      },
    }

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', fakeAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-v4-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Run complex multi-tool workflow' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(errors).toEqual([])
    assertV4ToolStepLifecycle(events)
    const toolResults = events.filter((e): e is Extract<SessionEvent, { type: 'tool/result' }> => e.type === 'tool/result')
    expect(toolResults.some(r => r.data.message.content.some(b => b.type === 'text' && b.text === 'User answered Yes'))).toBe(true)
    expect(toolResults.some(r => r.data.message.content.some(b => b.type === 'text' && b.text === 'Audit clean'))).toBe(true)
  })

  it('ignores context injections appended by preset prepended pre-step hooks (e.g. time-context) after an external turn finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-time-ctx-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-ext-preset-1', 'agy')

    const fakeAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }],
        defaultModel: 'gemini-4-hydrogen',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'text_delta', delta: 'Done via Antigravity.' })
        return { externalSessionId: 'agy-session-1', finalText: 'Done via Antigravity.' }
      },
    }

    const adapters = new Map<ExternalAgentId, ExternalAgentAdapter>([['agy', fakeAgy]])
    store.setModelSelection('sess-ext-preset-1', 'agy', { model: 'gemini-4-hydrogen', reasoningEffort: 'high' })

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters,
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => 'standard',
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) }, { global: true })

    // Simulate a preset plugin like `@deepseek-ai/dsh-time-context` that mounts in
    // `setup()` with `{ prepend: true }` and appends a message after `await next()`.
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-ext-preset-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      setup: (agentCtx) => {
        agentCtx.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          if (decision.kind === 'reject') return decision
          return {
            ...decision,
            messages: [
              ...decision.messages,
              createUserMessage({
                content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1' }],
                source: { kind: 'user' },
              }),
            ],
          }
        }, { prepend: true })
      },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Create ticket' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(errors).toEqual([])
    const turnEnd = events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe('completed')
    const userTexts = events
      .filter((e): e is Extract<SessionEvent, { type: 'user/message' }> => e.type === 'user/message')
      .map(e => e.data.content.map(b => b.type === 'text' ? b.text : '').join(''))
    expect(userTexts).toEqual(['Create ticket'])
    assertV4ToolStepLifecycle(events)
  })

  it('closes unresolved parallel tool calls cleanly with error tool/result before step/end if an external turn throws mid-step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-err-tools-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-err-1', 'agy')

    const failingAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'tool_start', callId: 'call-fail-1', name: 'bash', arguments: '{"cmd":"a"}' })
        await request.onEvent({ type: 'tool_start', callId: 'call-fail-2', name: 'bash', arguments: '{"cmd":"b"}' })
        throw new Error('ACP transport crashed mid-step')
      },
    }

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', failingAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-err-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Trigger failure' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(errors).toHaveLength(1)
    assertV4ToolStepLifecycle(events)
    const turnEnd = events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe('error')
  })

  it('closes pending tool calls with interrupted errors before step/end when turn abort fires mid-tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-abort-tools-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const store = new ExternalSessionStore(join(dir, 'sessions.json'))
    store.setAgent('sess-abort-1', 'agy')

    let resolveStarted!: () => void
    const startedPromise = new Promise<void>((r) => { resolveStarted = r })

    const abortableAgy: ExternalAgentAdapter = {
      id: 'agy',
      label: 'Antigravity',
      command: 'agy',
      permissionModes: [],
      probe: async () => ({
        available: true,
        command: 'agy',
        models: [{ id: 'default', name: 'Default' }],
        defaultModel: 'default',
        permissionModes: [],
      }),
      runTurn: async (_subprocess, request) => {
        await request.onEvent({ type: 'tool_start', callId: 'call-abort-1', name: 'Run ask_question', arguments: '{}' })
        resolveStarted()
        await new Promise<void>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return { finalText: '' }
      },
    }

    cleanups.push(installExternalTurnDriver({
      ctx,
      adapters: new Map([['agy', abortableAgy]]),
      store,
      getSubprocess: () => ctx.get('subprocess') as SubprocessRuntime | undefined,
      getPermissionPolicy: () => 'allow',
      resolvePresetForSession: () => null,
    }))

    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) }, { global: true })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-abort-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Abort me mid tool' }],
      source: { kind: 'user' },
    }))
    await startedPromise
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()

    assertV4ToolStepLifecycle(events)
    const turnEnd = events.findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe('aborted')
  })
})
