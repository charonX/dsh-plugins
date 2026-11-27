import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  AgyAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  CursorAdapter,
  ExternalResumeRejectedError,
  PiAdapter,
  buildAcpPromptBlocks,
  buildClaudeRunArgs,
  buildClaudeStreamUserMessage,
  buildCodexRunArgs,
  buildExternalSubprocessEnv,
  buildGuiFallbackPath,
  buildPiRunArgs,
  explainExecFormatError,
  extractAcpAvailableCommands,
  extractAcpUsageEvent,
  extractReasoningFromSessionResponse,
  isExecFormatError,
  isInternalClaudeCodeEnvKey,
  isResumeRejectedError,
  normalizeModelList,
  npmPackagePostinstallRepair,
  parseClaudeInitResponse,
  parseClaudeLine,
  parseCodexLine,
  parseCursorAuthStatus,
  parseCursorListModelsOutput,
  parseCursorModelId,
  parsePiCommandsResponse,
  parsePiLine,
  parsePiListModelsOutput,
  parsePiListModelsWithContext,
  resolveAgentExecutable,
  resolveCursorModelAndEffort,
  sanitizeExternalCliEnv,
} from '../src/adapters/index.ts'
import {
  AcpUsageAccumulator,
  classifyAcpMcpPermission,
  isAcpResumeRejectedError,
} from '../src/adapters/acp-base.ts'
import { resolveClaudeAllowedMcpTools, type ClaudeParseState } from '../src/adapters/claude.ts'
import type { PiParseState } from '../src/adapters/pi.ts'
import type { CodexParseState } from '../src/adapters/codex.ts'

describe('external agent stream parsers and probes', () => {
  it('parses claude stream-json deltas, tool use, tool result, and terminal result', () => {
    const state: ClaudeParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parseClaudeLine(JSON.stringify({ type: 'system', session_id: 'cl-1' }), state)).toEqual([
      { type: 'session', externalSessionId: 'cl-1' },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan...' } },
    }), state)).toEqual([{ type: 'thinking_delta', delta: 'plan...' }])
    expect(parseClaudeLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }],
      },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'tc-1', name: 'Bash', arguments: '{"command":"ls"}' },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'ok', is_error: false }],
      },
    }), state)).toEqual([
      { type: 'tool_result', callId: 'tc-1', content: 'ok', isError: false },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done!' } },
    }), state)).toEqual([{ type: 'text_delta', delta: 'Done!' }])
    expect(state.lastText).toBe('Done!')
  })

  it('parses pi --list-models and --mode json events', () => {
    const models = parsePiListModelsOutput([
      'provider  model                          context  max-out  thinking  images',
      'magpie    deepseek/deepseek-flash        1.0M     393.2K   yes       yes',
      'workbuddy deepseek-v4.1-flash            1M       128K     yes       yes',
    ].join('\n'))
    expect(models).toEqual([
      { id: 'magpie/deepseek/deepseek-flash', name: 'magpie/deepseek/deepseek-flash' },
      { id: 'workbuddy/deepseek-v4.1-flash', name: 'workbuddy/deepseek-v4.1-flash' },
    ])

    const state: PiParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parsePiLine(JSON.stringify({ type: 'session', id: 'pi-42' }), state)).toEqual([
      { type: 'session', externalSessionId: 'pi-42' },
    ])
    expect(parsePiLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }), state)).toEqual([{ type: 'text_delta', delta: 'hello' }])
    expect(parsePiLine(JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 'p1',
      toolName: 'read',
      args: { path: 'README.md' },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'p1', name: 'read', arguments: '{"path":"README.md"}' },
    ])
    expect(parsePiLine(JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'p1',
      result: 'file body',
      isError: false,
    }), state)).toEqual([
      { type: 'tool_result', callId: 'p1', content: 'file body', isError: false },
    ])
  })

  it('parses codex --json records and reports missing CLI gracefully', async () => {
    const state: CodexParseState = { lastText: '' }
    expect(parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'cdx-9' }), state)).toEqual([
      { type: 'session', externalSessionId: 'cdx-9' },
    ])
    expect(parseCodexLine(JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test' },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'cmd-1', name: 'command_execution', arguments: '{"command":"pnpm test"}' },
    ])
    expect(parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'cmd-1', type: 'command_execution', aggregated_output: 'pass', exit_code: 0 },
    }), state)).toEqual([
      { type: 'tool_result', callId: 'cmd-1', content: 'pass', isError: false },
    ])

    const fakeSubprocess = {
      resolveExecutable: async () => {
        throw new Error('ENOENT: codex not found')
      },
    } as unknown as SubprocessRuntime
    const codex = new CodexAdapter()
    const probed = await codex.probe(fakeSubprocess)
    expect(probed.available).toBe(false)
    expect(probed.reason).toContain('ENOENT')
    expect(probed.models.some(m => m.id === 'default')).toBe(true)
    expect(probed.reasoning?.efforts.map(effort => effort.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(probed.commands).toEqual([])
  })

  it('extracts ACP thought levels and forwards reasoning effort to each CLI', () => {
    expect(extractReasoningFromSessionResponse({
      configOptions: [
        { id: 'model', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
        {
          id: 'thought_level',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High', description: 'Deepest reasoning' },
          ],
        },
      ],
    })).toEqual({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High', description: 'Deepest reasoning' },
      ],
    })
    expect(extractReasoningFromSessionResponse({ configOptions: [] })).toBeUndefined()
    expect(extractReasoningFromSessionResponse({})).toBeUndefined()

    expect(buildClaudeRunArgs({ model: 'sonnet', reasoningEffort: 'high' }, 'acceptEdits')).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--model', 'sonnet',
      '--effort', 'high',
    ])
    expect(buildPiRunArgs({ model: 'magpie/deepseek/deepseek-flash', reasoningEffort: 'xhigh' })).toEqual([
      '--mode', 'json', '--print',
      '--model', 'magpie/deepseek/deepseek-flash',
      '--thinking', 'xhigh',
    ])
    expect(buildCodexRunArgs({ reasoningEffort: 'medium' }, 'workspace-write')).toEqual([
      'exec', '--json',
      '-c', 'model_reasoning_effort=medium',
      '--sandbox', 'workspace-write',
      '-',
    ])
    expect(buildCodexRunArgs({ externalSessionId: 'thread-1' }, 'read-only')).toEqual([
      'exec', 'resume', 'thread-1', '--json',
      '--sandbox', 'read-only',
      '-',
    ])
  })

  it('extracts slash commands from Antigravity ACP, Claude initialize, and Pi RPC responses', () => {
    expect(extractAcpAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: '/plan', description: 'Plan carefully before coding' },
        { name: 'boost', description: 'Invoke boost orchestrator', input: { hint: '<task>' } },
      ],
    })).toEqual([
      { name: 'plan', description: 'Plan carefully before coding', source: 'acp' },
      { name: 'boost', description: 'Invoke boost orchestrator', argumentHint: '<task>', source: 'acp' },
    ])

    expect(parseClaudeInitResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          commands: [
            { name: 'code-review', description: 'Review diff', argumentHint: '[--fix]', builtin: true },
            { name: 'code-review', description: 'duplicate ignored', builtin: true },
          ],
          models: [
            { value: 'default', displayName: 'Default (recommended)' },
            { value: 'sonnet', displayName: 'Claude Sonnet 4.6' },
          ],
        },
      },
    })).toEqual({
      commands: [
        { name: 'code-review', description: 'Review diff', argumentHint: '[--fix]', source: 'builtin' },
      ],
      models: [
        { id: 'default', name: 'Default (recommended)' },
        { id: 'sonnet', name: 'Claude Sonnet 4.6' },
      ],
    })

    expect(parsePiCommandsResponse({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: {
        commands: [
          { name: 'mcp', description: 'Manage MCP servers', source: 'extension' },
          { name: 'skill:code-review', description: 'Review changes', source: 'skill' },
        ],
      },
    })).toEqual([
      { name: 'mcp', description: 'Manage MCP servers', source: 'extension' },
      { name: 'skill:code-review', description: 'Review changes', source: 'skill' },
    ])
  })

  it('disambiguates duplicate model display names while keeping unique ids', () => {
    const models = normalizeModelList([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'group/group[1m]' },
      { id: 'sonnet', name: 'group/group[1m]' },
      { id: 'haiku', name: 'group/group[1m]' },
      { id: 'group/group[1m]', name: 'group/group[1m]' },
    ])
    expect(models).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'group/group[1m] (opus)' },
      { id: 'sonnet', name: 'group/group[1m] (sonnet)' },
      { id: 'haiku', name: 'group/group[1m] (haiku)' },
      { id: 'group/group[1m]', name: 'group/group[1m]' },
    ])
  })

  it('parses claude subagent task lifecycle, isolates child text, and parses usage + contextWindow', () => {
    const state: ClaudeParseState = { sawStreamDeltas: false, lastText: '' }

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      description: 'Explore codebase',
      subagent_type: 'Explore',
      is_backgrounded: false,
    }), state)).toEqual([
      {
        type: 'task_started',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        description: 'Explore codebase',
        subagentType: 'Explore',
        isBackgrounded: false,
      },
    ])

    // Child assistant frames with parent_tool_use_id must not pollute main lastText,
    // and child tool_use surfaces as task_progress.
    expect(parseClaudeLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'tu-agent-1',
      message: {
        content: [
          { type: 'text', text: 'internal child prose' },
          { type: 'tool_use', id: 'child-tu-1', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    }), state)).toEqual([
      {
        type: 'task_progress',
        taskId: 'tu-agent-1',
        toolUseId: 'tu-agent-1',
        lastToolName: 'Grep',
      },
    ])
    expect(state.lastText).toBe('')

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      description: 'Explore codebase',
      last_tool_name: 'Read',
      summary: 'Reading adapter files',
      usage: { total_tokens: 1500, tool_uses: 3, duration_ms: 4200 },
    }), state)).toEqual([
      {
        type: 'task_progress',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        description: 'Explore codebase',
        lastToolName: 'Read',
        summary: 'Reading adapter files',
        totalTokens: 1500,
        toolUses: 3,
        durationMs: 4200,
      },
    ])

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      status: 'completed',
      summary: 'Found 3 files',
      usage: { total_tokens: 2100, tool_uses: 4, duration_ms: 5100 },
    }), state)).toEqual([
      {
        type: 'task_completed',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        status: 'completed',
        summary: 'Found 3 files',
        totalTokens: 2100,
        toolUses: 4,
        durationMs: 5100,
      },
    ])

    expect(parseClaudeLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Final summary',
      usage: {
        input_tokens: 420,
        output_tokens: 180,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 420,
          outputTokens: 180,
          cacheReadInputTokens: 1200,
          cacheCreationInputTokens: 300,
          contextWindow: 200_000,
        },
      },
    }), state)).toEqual([
      {
        type: 'usage',
        inputTokens: 420,
        outputTokens: 180,
        cacheReadTokens: 1200,
        cacheWriteTokens: 300,
        contextWindow: 200_000,
        isTurnTotal: true,
      },
    ])

    expect(buildClaudeRunArgs({ model: 'sonnet' }, 'acceptEdits', true)).toContain('--input-format')
    const streamMsg = JSON.parse(buildClaudeStreamUserMessage('Inspect this UI', [{
      mediaType: 'image/png',
      base64: 'AQID',
    }])) as { type: string; message: { content: Array<{ type: string }> } }
    expect(streamMsg.type).toBe('user')
    expect(streamMsg.message.content.map(c => c.type)).toEqual(['text', 'image'])
  })

  it('parses ACP usage updates, Codex turn.completed usage, Pi context windows, and image inputs', () => {
    expect(extractAcpUsageEvent({ sessionUpdate: 'usage_update', used: 12_500, size: 1_000_000 })).toEqual({
      type: 'usage',
      inputTokens: 12_500,
      outputTokens: 0,
      contextUsedTokens: 12_500,
      contextWindow: 1_000_000,
    })

    expect(buildAcpPromptBlocks('See screenshot', [{
      mediaType: 'image/jpeg',
      base64: 'AAAA',
      hostPath: '/tmp/shot.jpg',
    }], true)).toEqual([
      { type: 'text', text: 'See screenshot' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg', uri: 'file:///tmp/shot.jpg' },
    ])

    const codexState: CodexParseState = { lastText: '' }
    expect(parseCodexLine(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 150 },
    }), codexState)).toEqual([
      {
        type: 'usage',
        inputTokens: 600,
        cacheReadTokens: 400,
        outputTokens: 150,
        isTurnTotal: true,
      },
    ])
    expect(buildCodexRunArgs({}, 'workspace-write', ['/tmp/a.png'])).toContain('--image')

    const piModels = parsePiListModelsWithContext([
      'provider  model                    context  max-out  thinking  images',
      'magpie    deepseek/deepseek-flash  1.0M     393.2K   yes       yes',
      'workbuddy hy3                      192K     128K     yes       yes',
    ].join('\n'))
    expect(piModels.modelContextWindows).toEqual({
      'magpie/deepseek/deepseek-flash': 1_000_000,
      'workbuddy/hy3': 192_000,
    })

    const piState: PiParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parsePiLine(JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input: 310, output: 90, cacheRead: 500, cacheWrite: 0 },
      },
    }), piState)).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'usage', inputTokens: 310, outputTokens: 90, cacheReadTokens: 500, cacheWriteTokens: 0 },
    ])
  })

  it('ignores historical ACP session/update notifications replayed during session/load', async () => {
    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })

    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } },
            })}\n`)
          } else if (msg.method === 'session/load') {
            // Per ACP spec, session/load replays prior turns via session/update before returning.
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Previous turn answer' } },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'tool_call', toolCallId: 'old-call-1', title: 'Old read_file', kind: 'read' },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh turn answer' } },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })

    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })

    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter()
    const observed: Array<{ type: string; delta?: string; callId?: string }> = []
    const outcome = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Latest question',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-sess-1',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: (event) => {
        observed.push(event as { type: string; delta?: string; callId?: string })
      },
    })

    expect(outcome.finalText).toBe('Fresh turn answer')
    expect(observed.filter(e => e.type === 'tool_start')).toEqual([])
    expect(observed.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('Fresh turn answer')
  })

  it('keeps pooled agy ACP subprocesses alive for background run_command tasks, drains reactive wakeup, and auto-destroys on idle', async () => {
    const spawns: Array<{ terminated: boolean; stdinEnded: boolean; prompts: string[]; sessionCount: number }> = []
    let notifyControl!: { emitUpdate: (sid: string, update: Record<string, unknown>) => void }

    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => {
        const clientToAgent = new PassThrough()
        const agentToClient = new PassThrough()
        let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
          doneResolve = r
        })
        const tracker = { terminated: false, stdinEnded: false, prompts: [] as string[], sessionCount: 0 }
        spawns.push(tracker)
        const currentSid = `acp-pooled-${spawns.length}`

        notifyControl = {
          emitUpdate: (sid, update) => {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: sid, update },
            })}\n`)
          },
        }

        let buf = ''
        clientToAgent.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          let nl = buf.indexOf('\n')
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line !== '') {
              const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: { prompt?: Array<{ text?: string }> } }
              if (msg.method === 'initialize') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
              } else if (msg.method === 'session/new') {
                tracker.sessionCount += 1
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: currentSid } })}\n`)
              } else if (msg.method === 'session/set_mode') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              } else if (msg.method === 'session/prompt') {
                const promptText = msg.params?.prompt?.[0]?.text ?? ''
                tracker.prompts.push(promptText)
                if (tracker.prompts.length === 1) {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                      sessionId: currentSid,
                      update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: 'bg-call-1',
                        name: 'run_command',
                        args: { CommandLine: 'pnpm test', WaitMsBeforeAsync: 500 },
                        status: 'in_progress',
                        kind: 'execute',
                        title: 'pnpm test',
                        rawInput: { CommandLine: 'pnpm test', WaitMsBeforeAsync: 500 },
                      },
                    },
                  })}\n`)
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { sessionId: currentSid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED_BG' } } },
                  })}\n`)
                } else {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { sessionId: currentSid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOLLOWUP_OK' } } },
                  })}\n`)
                }
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
              }
            }
            nl = buf.indexOf('\n')
          }
        })

        clientToAgent.once('finish', () => {
          tracker.stdinEnded = true
          agentToClient.end()
          doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        })

        return {
          stdin: clientToAgent,
          stdout: agentToClient,
          done,
          terminate: async () => {
            tracker.terminated = true
            agentToClient.end()
            doneResolve({ exitCode: 0, signal: 'SIGTERM', stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter([], {
      idleTtlMs: 80,
      postBgIdleTtlMs: 60,
      wakeupGraceMs: 80,
      wakeupQuiescenceMs: 40,
    })

    const asyncSeen: string[] = []
    const unsub = adapter.subscribeBackground('dsh-sess-1', (evt) => {
      asyncSeen.push(evt.type)
    })

    const turn1Events: Array<{ type: string; toolName?: string }> = []
    const out1 = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Run tests',
      cwd: '/tmp',
      dshSessionId: 'dsh-sess-1',
      model: 'default',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: (e) => {
        turn1Events.push(e as { type: string; toolName?: string })
      },
    })

    expect(out1.finalText).toBe('STARTED_BG')
    expect(out1.pendingToolCallIds).toEqual(['bg-call-1'])
    expect(turn1Events.find(e => e.type === 'tool_start')?.toolName).toBe('run_command')
    // Pooled subprocess MUST stay alive because bg-call-1 is still in_progress.
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.stdinEnded).toBe(false)

    // Warm follow-up reuses the exact same pooled subprocess without respawning.
    const outFollow = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Quick status?',
      cwd: '/tmp',
      dshSessionId: 'dsh-sess-1',
      model: 'default',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(outFollow.finalText).toBe('FOLLOWUP_OK')
    expect(outFollow.pendingToolCallIds).toEqual(['bg-call-1'])
    expect(spawns).toHaveLength(1)

    // Background command finishes post-PromptResponse, followed by reactive wakeup prose.
    notifyControl.emitUpdate('acp-pooled-1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-call-1',
      name: 'run_command',
      status: 'completed',
      kind: 'execute',
      title: 'pnpm test',
      rawOutput: { output: '24 passed', exit_code: 0 },
    })
    notifyControl.emitUpdate('acp-pooled-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All tests passed (24 passed).' },
    })

    await new Promise(r => setTimeout(r, 20))
    expect(asyncSeen).toContain('tool_result')
    expect(asyncSeen).toContain('wakeup_ready')

    const wakeupEvents: Array<{ type: string; content?: string; delta?: string }> = []
    const outWakeup = await adapter.drainWakeupTurn('dsh-sess-1', new AbortController().signal, (e) => {
      wakeupEvents.push(e as { type: string; content?: string; delta?: string })
    })
    expect(outWakeup.finalText).toBe('All tests passed (24 passed).')
    expect(outWakeup.pendingToolCallIds).toBeUndefined()
    expect(wakeupEvents.some(e => e.type === 'tool_result' && e.content?.includes('24 passed'))).toBe(true)

    // Once background work and reactive wakeup settle, postBgIdleTtlMs auto-closes the ACP child.
    await new Promise(r => setTimeout(r, 120))
    expect(spawns[0]!.stdinEnded || spawns[0]!.terminated).toBe(true)
    unsub()
    await adapter.dispose()
  })

  it('forwards bridged MCP server config to ACP, Claude, Pi, and Codex and approves dsh-manager MCP permissions', async () => {
    const serverCfg = {
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer tok-1', 'X-Dsh-Session-Id': 's-1' },
      tools: [{
        name: 'dsh_manager_create_ticket',
        description: 'Create ticket',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      }],
    } as const

    expect(buildClaudeRunArgs({ model: 'sonnet' }, 'acceptEdits', false, '/tmp/mcp.json', ['mcp__dsh-manager__*'])).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--mcp-config', '/tmp/mcp.json',
      '--allowedTools', 'mcp__dsh-manager__*',
      '--model', 'sonnet',
    ])
    expect(buildPiRunArgs({ model: 'default' }, false, ['/tmp/ext.mjs'])).toEqual([
      '--mode', 'json', '--print', '-e', '/tmp/ext.mjs',
    ])
    expect(buildCodexRunArgs({}, 'workspace-write', [], [serverCfg])).toEqual([
      'exec', '--json',
      '-c', 'mcp_servers.dsh_manager.url="http://127.0.0.1:41234/mcp"',
      '-c', 'mcp_servers.dsh_manager.http_headers={ "Authorization" = "Bearer tok-1", "X-Dsh-Session-Id" = "s-1" }',
      '--sandbox', 'workspace-write',
      '-',
    ])

    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })
    let receivedMcpServers: unknown
    let permissionOutcome: unknown
    let promptReqId: number | string | undefined

    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
          } else if (msg.method === 'session/load') {
            receivedMcpServers = msg.params?.mcpServers
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            promptReqId = msg.id
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 901,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-mcp-1',
                toolCall: {
                  toolCallId: 'tc-mgr-1',
                  kind: 'other',
                  title: 'mcp_dsh-manager_dsh_manager_create_ticket',
                },
                options: [
                  { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
                  { optionId: 'deny-1', kind: 'reject_once', name: 'Deny' },
                ],
              },
            })}\n`)
          } else if (msg.id === 901) {
            permissionOutcome = (msg.result as { outcome?: unknown })?.outcome
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })

    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter()
    await adapter.runTurn(fakeSubprocess, {
      prompt: 'Create a manager ticket',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-mcp-1',
      permissionMode: 'accept-edits',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(receivedMcpServers).toEqual([{
      type: 'http',
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: [
        { name: 'Authorization', value: 'Bearer tok-1' },
        { name: 'X-Dsh-Session-Id', value: 's-1' },
      ],
    }])
    expect(permissionOutcome).toEqual({ outcome: 'selected', optionId: 'allow-1' })

    // Claude plan mode restricts MCP to read-only manager tools including team_config_get.
    expect(resolveClaudeAllowedMcpTools('plan', 'allow', [serverCfg])).toEqual([
      'mcp__dsh-manager__dsh_manager_board_summary',
      'mcp__dsh-manager__dsh_manager_team_config_get',
    ])
    expect(resolveClaudeAllowedMcpTools('acceptEdits', 'allow', [serverCfg])).toEqual([
      'mcp__dsh-manager__*',
    ])
    expect(resolveClaudeAllowedMcpTools('plan', 'reject', [serverCfg])).toBeUndefined()
  })

  it('allows read-only team_config_get and denies mutating manager tools in Agy plan mode', async () => {
    const serverCfg = {
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer tok-1' },
      tools: [],
    } as const
    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })
    const outcomes: Record<string, unknown> = {}
    let promptReqId: number | string | undefined
    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string; result?: unknown }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
          } else if (msg.method === 'session/load' || msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            promptReqId = msg.id
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 910,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-plan-1',
                toolCall: { toolCallId: 'tc-read', kind: 'other', title: 'mcp_dsh-manager_dsh_manager_team_config_get' },
                options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 911,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-plan-1',
                toolCall: { toolCallId: 'tc-write', kind: 'other', title: 'mcp_dsh-manager_dsh_manager_team_member_upsert' },
                options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
              },
            })}\n`)
          } else if (msg.id === 910) {
            outcomes.read = (msg.result as { outcome?: unknown })?.outcome
          } else if (msg.id === 911) {
            outcomes.write = (msg.result as { outcome?: unknown })?.outcome
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })
    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    await new AgyAdapter().runTurn(fakeSubprocess, {
      prompt: 'Inspect team config in plan mode',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-plan-1',
      permissionMode: 'plan',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(outcomes.read).toEqual({ outcome: 'selected', optionId: 'allow-1' })
    expect(outcomes.write).toEqual({ outcome: 'cancelled' })
  })

  it('probes slash commands using the caller-supplied workspace cwd for Agy, Claude Code, and Pi', async () => {
    const projectDir = '/tmp/project-with-skills'

    // 1. Agy ACP probeCommands forwards cwd to both subprocess.spawn and ACP session/new
    const agySpawnCwds: string[] = []
    let agySessionNewCwd: unknown
    const agyClientToAgent = new PassThrough()
    const agyAgentToClient = new PassThrough()
    let agyDoneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const agyDone = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      agyDoneResolve = r
    })
    let agyBuf = ''
    agyClientToAgent.on('data', (chunk: Buffer) => {
      agyBuf += chunk.toString('utf8')
      let nl = agyBuf.indexOf('\n')
      while (nl !== -1) {
        const line = agyBuf.slice(0, nl).trim()
        agyBuf = agyBuf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> }
          if (msg.method === 'initialize') {
            agyAgentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
          } else if (msg.method === 'session/new') {
            agySessionNewCwd = msg.params?.cwd
            agyAgentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-probe-1',
                update: {
                  sessionUpdate: 'available_commands_update',
                  availableCommands: [
                    { name: 'align', description: 'Project alignment skill' },
                  ],
                },
              },
            })}\n`)
            agyAgentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-probe-1' } })}\n`)
          } else if (msg.method === 'session/close') {
            agyAgentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          }
        }
        nl = agyBuf.indexOf('\n')
      }
    })
    agyClientToAgent.once('finish', () => {
      agyAgentToClient.end()
      agyDoneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })
    const agySubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: (opts: { cwd?: string }) => {
        if (opts.cwd !== undefined) agySpawnCwds.push(opts.cwd)
        return {
          stdin: agyClientToAgent,
          stdout: agyAgentToClient,
          done: agyDone,
          terminate: async () => {
            agyAgentToClient.end()
            agyDoneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const agyCmds = await new AgyAdapter().probeCommands(agySubprocess, projectDir)
    expect(agySpawnCwds).toEqual([projectDir])
    expect(agySessionNewCwd).toBe(projectDir)
    expect(agyCmds).toEqual([{ name: 'align', description: 'Project alignment skill', source: 'acp' }])

    // 2. ClaudeCodeAdapter probeCommands spawns in projectDir
    const claudeSpawnCwds: string[] = []
    const claudeStdout = new PassThrough()
    const claudeStdin = new PassThrough()
    let claudeDoneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const claudeDone = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      claudeDoneResolve = r
    })
    claudeStdin.on('data', () => {
      claudeStdout.write(`${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          response: {
            commands: [{ name: 'align', description: 'Project skill', builtin: false }],
            models: [],
          },
        },
      })}\n`)
    })
    const claudeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/claude',
      spawn: (opts: { cwd?: string }) => {
        if (opts.cwd !== undefined) claudeSpawnCwds.push(opts.cwd)
        return {
          stdin: claudeStdin,
          stdout: claudeStdout,
          done: claudeDone,
          terminate: async () => {
            claudeStdout.end()
            claudeDoneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const claudeCmds = await new ClaudeCodeAdapter().probeCommands(claudeSubprocess, projectDir)
    expect(claudeSpawnCwds).toEqual([projectDir])
    expect(claudeCmds).toEqual([{ name: 'align', description: 'Project skill', source: 'custom' }])

    // 3. PiAdapter probeCommands spawns in projectDir
    const piSpawnCwds: string[] = []
    const piStdout = new PassThrough()
    let piDoneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const piDone = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      piDoneResolve = r
    })
    const piSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/pi',
      spawn: (opts: { cwd?: string }) => {
        if (opts.cwd !== undefined) piSpawnCwds.push(opts.cwd)
        queueMicrotask(() => {
          piStdout.write(`${JSON.stringify({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: { commands: [{ name: 'skill:align', description: 'Pi project skill', source: 'skill' }] },
          })}\n`)
        })
        return {
          stdout: piStdout,
          done: piDone,
          terminate: async () => {
            piStdout.end()
            piDoneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const piCmds = await new PiAdapter().probeCommands(piSubprocess, projectDir)
    expect(piSpawnCwds).toEqual([projectDir])
    expect(piCmds).toEqual([{ name: 'skill:align', description: 'Pi project skill', source: 'skill' }])
  })

  it('parses Claude Code rate_limit_event into rate_limit turn events', () => {
    const state = { sawStreamDeltas: false, lastText: '' }
    const events = parseClaudeLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.82,
        resetsAt: 1_800_000_000,
        unifiedWindows: {
          seven_day: { utilization: 0.45, resetsAt: 1_800_500_000 },
        },
      },
    }), state)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('rate_limit')
    if (events[0]?.type === 'rate_limit') {
      expect(events[0].snapshot.status).toBe('ok')
      expect(events[0].snapshot.source).toBe('passive_stream')
      const buckets = events[0].snapshot.groups?.[0]?.buckets ?? []
      expect(buckets.find(b => b.id === 'claude-5h')).toMatchObject({
        remainingPercent: 18,
        usedPercent: 82,
        status: 'warning',
      })
      expect(buckets.find(b => b.id === 'claude-weekly')).toMatchObject({
        remainingPercent: 55,
        usedPercent: 45,
      })
    }
  })

  it('strips internal CLAUDECODE* nesting markers while preserving user CLAUDE_CODE_* config and enriches GUI PATH with ~/.cursor/bin', async () => {
    expect(isInternalClaudeCodeEnvKey('CLAUDECODE')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('claudecode')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('CLAUDECODE_CUSTOM_FLAG')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_ENTRYPOINT')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_EXECPATH')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_SESSION_ID')).toBe(true)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_SSE_PORT')).toBe(true)

    expect(isInternalClaudeCodeEnvKey('CLAUDECODEX')).toBe(false)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_GIT_BASH_PATH')).toBe(false)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_USE_BEDROCK')).toBe(false)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_TMPDIR')).toBe(false)
    expect(isInternalClaudeCodeEnvKey('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe(false)

    const sampleEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      CLAUDECODE: '1',
      CLAUDECODE_SUBAGENT: 'yes',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_CODE_SESSION_ID: 'sess-123',
      CLAUDE_CODE_SSE_PORT: '9999',
      CLAUDECODEX: 'keep',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_TMPDIR: '/tmp/claude-user',
    }
    const sanitized = sanitizeExternalCliEnv(sampleEnv, undefined, { home: '/Users/tester', platform: 'darwin' })
    expect(sanitized.CLAUDECODE).toBeUndefined()
    expect(sanitized.CLAUDECODE_SUBAGENT).toBeUndefined()
    expect(sanitized.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(sanitized.CLAUDE_CODE_EXECPATH).toBeUndefined()
    expect(sanitized.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(sanitized.CLAUDE_CODE_SSE_PORT).toBeUndefined()
    expect(sanitized.CLAUDECODEX).toBe('keep')
    expect(sanitized.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(sanitized.CLAUDE_CODE_TMPDIR).toBe('/tmp/claude-user')
    expect(sanitized.PATH?.startsWith('/usr/bin:/bin')).toBe(true)
    expect(sanitized.PATH).toContain('/Users/tester/.cursor/bin')
    expect(sanitized.PATH).toContain('/Users/tester/.local/bin')

    const overlay = buildExternalSubprocessEnv({ CUSTOM_KEY: 'v1' }, sampleEnv, { home: '/Users/tester', platform: 'darwin' })
    expect('CLAUDECODE' in overlay && overlay.CLAUDECODE === undefined).toBe(true)
    expect('CLAUDECODE_SUBAGENT' in overlay && overlay.CLAUDECODE_SUBAGENT === undefined).toBe(true)
    expect(overlay.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(overlay.CLAUDE_CODE_EXECPATH).toBeUndefined()
    expect(overlay.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(overlay.CLAUDE_CODE_SSE_PORT).toBeUndefined()
    expect(overlay.CUSTOM_KEY).toBe('v1')
    expect(overlay.PATH).toContain('/Users/tester/.cursor/bin')

    const guiPath = buildGuiFallbackPath('/usr/bin', { home: '/Users/tester', platform: 'darwin', env: {} })
    expect(guiPath.split(':').slice(0, 3)).toEqual([
      '/usr/bin',
      '/Users/tester/.local/bin',
      '/Users/tester/.cursor/bin',
    ])

    // resolveAgentExecutable falls back via GUI PATH when primary lookup misses
    const seenLookups: Array<{ cmd: string; pathEnv?: string | undefined }> = []
    const fakeSubprocess = {
      resolveExecutable: async (cmd: string, env?: Readonly<Record<string, string>>) => {
        seenLookups.push({ cmd, pathEnv: env?.PATH })
        if (env?.PATH?.includes('.cursor/bin')) {
          return '/Users/tester/.cursor/bin/agent'
        }
        throw new Error('not found')
      },
    } as unknown as SubprocessRuntime
    const resolved = await resolveAgentExecutable(fakeSubprocess, 'agent')
    expect(resolved).toBe('/Users/tester/.cursor/bin/agent')
    expect(seenLookups.length).toBeGreaterThanOrEqual(2)
  })

  it('diagnoses ENOEXEC stub binaries with package postinstall repair instructions idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-enoexec-'))
    try {
      const pkgDir = join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
      const binDir = join(pkgDir, 'bin')
      mkdirSync(binDir, { recursive: true })
      const stubPath = join(binDir, 'claude.exe')
      writeFileSync(stubPath, 'placeholder stub', 'utf8')
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@anthropic-ai/claude-code',
        scripts: { postinstall: 'node install.cjs' },
      }), 'utf8')

      const repair = npmPackagePostinstallRepair(stubPath, 'darwin')
      expect(repair).toEqual({
        packageName: '@anthropic-ai/claude-code',
        rootDir: pkgDir,
        command: `cd '${pkgDir}' && node install.cjs`,
        shell: 'bash',
      })

      const rawErr = Object.assign(new Error(`spawn ${stubPath} ENOEXEC`), { code: 'ENOEXEC', path: stubPath })
      expect(isExecFormatError(rawErr)).toBe(true)
      const explained = explainExecFormatError(rawErr, stubPath)
      expect(explained.message).toContain('@anthropic-ai/claude-code')
      expect(explained.message).toContain('node install.cjs')
      expect(explained.message).toContain('postinstall')
      // Calling twice is idempotent
      expect(explainExecFormatError(explained, stubPath)).toBe(explained)

      const normalErr = new Error('network timeout')
      expect(isExecFormatError(normalErr)).toBe(false)
      expect(explainExecFormatError(normalErr)).toBe(normalErr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('propagates ACP setMode/setConfigOption errors, routes dynamic MCP permissions without hardcoded prefixes, and isolates narration / empty completion', async () => {
    const runMockAcpTurn = async (options: {
      readonly failSetMode?: boolean
      readonly failSetConfig?: boolean
      readonly advertiseModels?: readonly string[]
      readonly promptMode?: 'empty' | 'pre-tool-narration' | 'unknown-block' | 'permission-check' | 'load-rejected' | 'load-transient'
      readonly permissionMode?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly externalSessionId?: string
      readonly mcpServers?: ReadonlyArray<{
        readonly name: string
        readonly url: string
        readonly headers: Readonly<Record<string, string>>
        readonly tools?: ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown>; readonly readOnly?: boolean }>
      }>
    }) => {
      const clientToAgent = new PassThrough()
      const agentToClient = new PassThrough()
      let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
        doneResolve = r
      })
      const outcomes: Record<string, unknown> = {}
      let promptReqId: number | string | undefined
      let buf = ''
      clientToAgent.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line !== '') {
            const msg = JSON.parse(line) as { id?: number | string; method?: string; result?: unknown }
            if (msg.method === 'initialize') {
              agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
            } else if (msg.method === 'session/load') {
              if (options.promptMode === 'load-rejected') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: { code: -32602, message: 'Invalid session identifier "dead-sess"' },
                })}\n`)
              } else if (options.promptMode === 'load-transient') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: { code: -32000, message: 'Invalid session parameters: cwd must be absolute' },
                })}\n`)
              } else {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              }
            } else if (msg.method === 'session/new') {
              const result: Record<string, unknown> = { sessionId: 'acp-test-1' }
              if (options.advertiseModels !== undefined) {
                result.models = { availableModels: options.advertiseModels.map(m => ({ modelId: m, name: m })) }
              }
              agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
            } else if (msg.method === 'session/set_mode') {
              if (options.failSetMode) {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: { code: -32602, message: 'unsupported mode' },
                })}\n`)
              } else {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              }
            } else if (msg.method === 'session/set_config_option') {
              if (options.failSetConfig) {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: { code: -32602, message: 'invalid config option' },
                })}\n`)
              } else {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              }
            } else if (msg.method === 'session/prompt') {
              promptReqId = msg.id
              if (options.promptMode === 'empty') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
              } else if (options.promptMode === 'pre-tool-narration') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: 'acp-test-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me check first.' } } },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: 'acp-test-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read', title: 'read_file' } },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: 'acp-test-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'ok' } },
                })}\n`)
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
              } else if (options.promptMode === 'unknown-block') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: 'acp-test-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Stale chatter' } } },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'acp-test-1',
                    update: {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'resource_link', uri: 'file:///tmp/out.txt', name: 'out.txt' },
                    },
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: { sessionId: 'acp-test-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Real final answer' } } },
                })}\n`)
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
              } else if (options.promptMode === 'permission-check') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: 801,
                  method: 'session/request_permission',
                  params: {
                    sessionId: 'acp-test-1',
                    toolCall: { toolCallId: 'p-1', kind: 'other', title: 'mcp_custom-tools_read_items' },
                    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: 802,
                  method: 'session/request_permission',
                  params: {
                    sessionId: 'acp-test-1',
                    toolCall: { toolCallId: 'p-2', kind: 'other', title: 'mcp_custom-tools_delete_item' },
                    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: 803,
                  method: 'session/request_permission',
                  params: {
                    sessionId: 'acp-test-1',
                    toolCall: { toolCallId: 'p-3', kind: 'other', title: 'mcp_dsh-manager_dsh_manager_board_summary' },
                    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
                  },
                })}\n`)
              }
            } else if (msg.id === 801) {
              outcomes.readCustom = (msg.result as { outcome?: unknown })?.outcome
            } else if (msg.id === 802) {
              outcomes.deleteCustom = (msg.result as { outcome?: unknown })?.outcome
            } else if (msg.id === 803) {
              outcomes.unconfiguredMgr = (msg.result as { outcome?: unknown })?.outcome
              agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
            }
          }
          nl = buf.indexOf('\n')
        }
      })
      clientToAgent.once('finish', () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      })
      const fakeHandle = {
        stdin: clientToAgent,
        stdout: agentToClient,
        done,
        terminate: async () => {
          agentToClient.end()
          doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        },
      } as unknown as SubprocessHandle
      const fakeSubprocess = {
        resolveExecutable: async () => '/usr/local/bin/agy',
        spawn: () => fakeHandle,
      } as unknown as SubprocessRuntime
      const adapter = new AgyAdapter()
      try {
        const res = await adapter.runTurn(fakeSubprocess, {
          prompt: 'test',
          cwd: '/tmp',
          model: options.model ?? 'default',
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
          ...(options.externalSessionId === undefined ? {} : { externalSessionId: options.externalSessionId }),
          permissionMode: options.permissionMode ?? 'plan',
          permissionPolicy: 'allow',
          ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
          signal: new AbortController().signal,
          onEvent: () => {},
        })
        return { res, outcomes }
      } finally {
        await adapter.dispose()
      }
    }

    // 1. setMode & setConfigOption errors are NOT swallowed
    await expect(runMockAcpTurn({ failSetMode: true, permissionMode: 'plan' })).rejects.toThrow(/session\/set_mode/)
    await expect(runMockAcpTurn({ failSetConfig: true, model: 'gemini-4-neon' })).rejects.toThrow(/session\/set_config_option/)

    // 2. Unknown advertised model fails loudly
    await expect(runMockAcpTurn({
      advertiseModels: ['gemini-4-neon', 'gemini-4-argon'],
      model: 'typo-model',
    })).rejects.toThrow(/Unknown model "typo-model"/)

    // 3. Empty completion guard rejects zero-activity empty turns
    await expect(runMockAcpTurn({ promptMode: 'empty' })).rejects.toThrow(/empty output/)

    // 4. Pre-tool narration is isolated and not returned as finalText
    const preTool = await runMockAcpTurn({ promptMode: 'pre-tool-narration' })
    expect(preTool.res.finalText).toBe('')
    expect(preTool.res.terminalConfirmed).toBe(true)

    // 5. Unknown intermediate update clears stale narration buffer
    const unknownBlock = await runMockAcpTurn({ promptMode: 'unknown-block' })
    expect(unknownBlock.res.finalText).toBe('Real final answer')

    // 6. Dynamic MCP permission routing (custom-tools allowed by spec/readOnly; unconfigured dsh-manager denied)
    const perm = await runMockAcpTurn({
      promptMode: 'permission-check',
      permissionMode: 'plan',
      mcpServers: [{
        name: 'custom-tools',
        url: 'http://127.0.0.1:49999/mcp',
        headers: {},
        tools: [
          { name: 'read_items', description: 'Read items', inputSchema: {}, readOnly: true },
          { name: 'delete_item', description: 'Delete item', inputSchema: {}, readOnly: false },
        ],
      }],
    })
    expect(perm.outcomes.readCustom).toEqual({ outcome: 'selected', optionId: 'allow-1' })
    expect(perm.outcomes.deleteCustom).toEqual({ outcome: 'cancelled' })
    expect(perm.outcomes.unconfiguredMgr).toEqual({ outcome: 'cancelled' })

    // 7. session/load rejection vs request complaint
    await expect(runMockAcpTurn({
      promptMode: 'load-rejected',
      externalSessionId: 'dead-sess',
    })).rejects.toBeInstanceOf(ExternalResumeRejectedError)

    const transientPromise = runMockAcpTurn({
      promptMode: 'load-transient',
      externalSessionId: 'good-sess',
    })
    await expect(transientPromise).rejects.toThrow(/session\/load/)
    await transientPromise.catch((err) => {
      expect(isResumeRejectedError(err)).toBe(false)
    })

    // 8. Pure helpers: isAcpResumeRejectedError, classifyAcpMcpPermission, AcpUsageAccumulator
    expect(isAcpResumeRejectedError({ code: -32602, message: 'Unknown session ses_1' })).toBe(true)
    expect(isAcpResumeRejectedError({ code: -32000, message: 'Invalid token for session abc' })).toBe(false)
    expect(isAcpResumeRejectedError({ code: -32602, message: 'Unknown session capability requested' })).toBe(false)
    expect(classifyAcpMcpPermission(
      { toolCallId: 'c1', kind: 'other', title: 'mcp__my-srv__my_srv_get' },
      [{ name: 'my-srv', url: 'http://127.0.0.1:1/mcp', headers: {} }],
    )).toEqual({ isBridgedMcp: true, isReadOnlyBridgedMcp: true, matchedServer: 'my-srv' })

    const acc = new AcpUsageAccumulator()
    const u1 = extractAcpUsageEvent({
      _meta: { usage: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 400, totalTokens: 1200 } },
    })
    expect(u1).toBeDefined()
    expect(acc.merge(u1!)).toMatchObject({ inputTokens: 600, outputTokens: 200, cacheReadTokens: 400 })
    const u2 = acc.merge({ inputTokens: 600, outputTokens: 250, cacheReadTokens: 400, isTurnTotal: true })
    expect(u2).toMatchObject({ inputTokens: 600, outputTokens: 250, cacheReadTokens: 400 })
  })

  it('supports CursorAdapter probe (agent/cursor-agent fallback, status, --list-models, parameterized ACP models), permissions, MCP, and session/load', async () => {
    expect(parseCursorAuthStatus('\u001b[32m✓\u001b[39m Logged in as private@example.com\n', 0)).toEqual({
      authenticated: true,
      method: 'cursor_login',
      summary: 'Logged in',
    })
    expect(parseCursorAuthStatus("Not logged in. Run 'agent login' first.\n", 1)).toEqual({
      authenticated: false,
      method: 'cursor_login',
      summary: 'Not logged in',
    })

    expect(parseCursorModelId('claude-opus-5-5[context=300k,effort=medium,fast=false]')).toEqual({
      rawId: 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
      baseId: 'claude-opus-5-5',
      params: { context: '300k', effort: 'medium', fast: 'false' },
      effort: 'medium',
      contextWindow: 300_000,
      fast: false,
    })
    expect(parseCursorModelId('gemini-4-neon[context=300k,reasoning_effort=high]')).toMatchObject({
      baseId: 'gemini-4-neon',
      effort: 'high',
      contextWindow: 300_000,
    })

    expect(parseCursorListModelsOutput(
      'Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex-high - Codex 5.3 High\ngrok-4.7-low - Grok 4.7 Low Fast\u200b\u200b\n',
    )).toEqual([
      { id: 'default', name: 'Auto (Cursor default)' },
      { id: 'gpt-5.3-codex-high', name: 'Codex 5.3 High' },
      { id: 'grok-4.7-low', name: 'Grok 4.7 Low Fast' },
    ])

    const advertisedSet = new Set([
      'default[]',
      'claude-opus-5-5[context=300k,effort=medium,fast=false]',
      'gpt-5.3-codex[reasoning=medium,fast=false]',
      'gemini-4-hydrogen[context=300k,reasoning_effort=high]',
    ])
    expect(resolveCursorModelAndEffort('default', undefined, advertisedSet)).toEqual({ targetModelId: 'default[]' })
    expect(resolveCursorModelAndEffort('claude-opus-5-5', 'medium', advertisedSet)).toEqual({
      targetModelId: 'claude-opus-5-5[context=300k,effort=medium,fast=false]',
    })
    expect(resolveCursorModelAndEffort('gpt-5.3-codex-medium', undefined, advertisedSet)).toEqual({
      targetModelId: 'gpt-5.3-codex[reasoning=medium,fast=false]',
    })
    expect(resolveCursorModelAndEffort('nonexistent-model', undefined, advertisedSet)).toEqual({
      unknownModel: 'nonexistent-model',
    })

    // Unavailable when neither `agent` nor `cursor-agent` exists
    const missingSubprocess = {
      resolveExecutable: async (cmd: string) => {
        throw new Error(`ENOENT: ${cmd} not found`)
      },
      spawn: () => {
        throw new Error('should not spawn')
      },
    } as unknown as SubprocessRuntime
    const cursorMissing = await new CursorAdapter().probe(missingSubprocess)
    expect(cursorMissing.available).toBe(false)
    expect(cursorMissing.command).toBe('agent')
    expect(cursorMissing.permissionModes.map(m => m.id)).toEqual(['agent', 'plan', 'ask'])

    // Falls back to `cursor-agent`, probes version + status + --list-models + ACP catalog, and runs turns
    const seenConfigSets: Array<{ configId: string; value: string }> = []
    const seenModes: string[] = []
    const seenMcpServers: unknown[] = []
    const planOutcomes: Record<string, unknown> = {}
    const agentOutcomes: Record<string, unknown> = {}
    const serverCfg = {
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer tok-cursor' },
      tools: [],
    } as const

    const fakeSubprocess = {
      resolveExecutable: async (cmd: string) => {
        if (cmd === 'cursor-agent') return '/Users/test/.local/bin/cursor-agent'
        throw new Error('ENOENT: agent not found')
      },
      spawn: (opts: { argv: readonly string[]; cwd?: string }) => {
        const args = opts.argv.slice(1)
        const clientToAgent = new PassThrough()
        const agentToClient = new PassThrough()
        let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
          doneResolve = r
        })

        if (args[0] === '--version') {
          queueMicrotask(() => {
            agentToClient.end('2026.11.22-e9042b2\n')
            doneResolve({ exitCode: 0, signal: null, stdout: '2026.11.22-e9042b2\n', stderr: '' })
          })
          return {
            stdin: clientToAgent,
            stdout: agentToClient,
            done,
            collected: { stdout: { readFrom: () => ({ text: '2026.11.22-e9042b2\n' }) }, stderr: { readFrom: () => ({ text: '' }) } },
            terminate: async () => {},
          } as unknown as SubprocessHandle
        }

        if (args[0] === 'status') {
          const text = '✓ Logged in as hidden@example.com\n'
          queueMicrotask(() => {
            agentToClient.end(text)
            doneResolve({ exitCode: 0, signal: null, stdout: text, stderr: '' })
          })
          return {
            stdin: clientToAgent,
            stdout: agentToClient,
            done,
            collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
            terminate: async () => {},
          } as unknown as SubprocessHandle
        }

        if (args[0] === '--list-models') {
          const text = 'Available models\n\nauto - Auto (current, default)\nclaude-opus-5-5 - Claude Opus 5.5\n'
          queueMicrotask(() => {
            agentToClient.end(text)
            doneResolve({ exitCode: 0, signal: null, stdout: text, stderr: '' })
          })
          return {
            stdin: clientToAgent,
            stdout: agentToClient,
            done,
            collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text: '' }) } },
            terminate: async () => {},
          } as unknown as SubprocessHandle
        }

        // ACP stdio mode (`cursor-agent acp`)
        let buf = ''
        let currentMode = 'agent'
        let promptReqId: number | string | undefined
        clientToAgent.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          let nl = buf.indexOf('\n')
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line !== '') {
              const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
              if (msg.method === 'initialize') {
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    protocolVersion: 1,
                    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true } },
                  },
                })}\n`)
              } else if (msg.method === 'session/new') {
                seenMcpServers.push(msg.params?.mcpServers)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    sessionId: 'cursor-sess-1',
                    modes: {
                      currentModeId: 'agent',
                      availableModes: [
                        { id: 'agent', name: 'Agent' },
                        { id: 'plan', name: 'Plan' },
                        { id: 'ask', name: 'Ask' },
                      ],
                    },
                    models: {
                      currentModelId: 'default[]',
                      availableModels: [
                        { modelId: 'default[]', name: 'Auto' },
                        { modelId: 'claude-opus-5-5[context=300k,effort=medium,fast=false]', name: 'claude-opus-5-5' },
                      ],
                    },
                    configOptions: [
                      {
                        id: 'model',
                        name: 'Model',
                        category: 'model',
                        type: 'select',
                        currentValue: 'default[]',
                        options: [
                          { value: 'default[]', name: 'Auto' },
                          { value: 'claude-opus-5-5[context=300k,effort=medium,fast=false]', name: 'claude-opus-5-5' },
                        ],
                      },
                    ],
                  },
                })}\n`)
                setTimeout(() => {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                      sessionId: 'cursor-sess-1',
                      update: {
                        sessionUpdate: 'available_commands_update',
                        availableCommands: [{ name: 'align', description: 'Align design' }],
                      },
                    },
                  })}\n`)
                }, 15)
              } else if (msg.method === 'session/load') {
                const sid = msg.params?.sessionId
                if (sid === 'cursor-dead') {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32602, message: 'Invalid params', data: { message: 'Session "cursor-dead" not found' } },
                  })}\n`)
                } else {
                  seenMcpServers.push(msg.params?.mcpServers)
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                      models: {
                        currentModelId: 'default[]',
                        availableModels: [
                          { modelId: 'default[]', name: 'Auto' },
                          { modelId: 'claude-opus-5-5[context=300k,effort=medium,fast=false]', name: 'claude-opus-5-5' },
                        ],
                      },
                    },
                  })}\n`)
                }
              } else if (msg.method === 'session/set_mode') {
                currentMode = String(msg.params?.modeId ?? 'agent')
                seenModes.push(currentMode)
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              } else if (msg.method === 'session/set_config_option') {
                const cfgId = String(msg.params?.configId ?? '')
                const val = String(msg.params?.value ?? '')
                seenConfigSets.push({ configId: cfgId, value: val })
                if (cfgId !== 'model') {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32602, message: 'Invalid params', data: { message: `Unknown config option: ${cfgId}` } },
                  })}\n`)
                } else {
                  agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
                }
              } else if (msg.method === 'session/prompt') {
                promptReqId = msg.id
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'cursor-sess-1',
                    update: { sessionUpdate: 'session_info_update', title: 'Cursor Test' },
                  },
                })}\n`)
                if (currentMode === 'plan') {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 951,
                    method: 'session/request_permission',
                    params: {
                      sessionId: 'cursor-sess-1',
                      toolCall: {
                        toolCallId: 'c-read',
                        kind: 'other',
                        title: 'dsh-manager-dsh_manager_board_summary: dsh_manager_board_summary',
                      },
                      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
                    },
                  })}\n`)
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 952,
                    method: 'session/request_permission',
                    params: {
                      sessionId: 'cursor-sess-1',
                      toolCall: {
                        toolCallId: 'c-exec',
                        kind: 'execute',
                        title: 'Run shell command',
                      },
                      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
                    },
                  })}\n`)
                } else {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 953,
                    method: 'session/request_permission',
                    params: {
                      sessionId: 'cursor-sess-1',
                      toolCall: { toolCallId: 'c-edit', kind: 'edit', title: 'Edit file' },
                      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
                    },
                  })}\n`)
                }
              } else if (msg.id === 951) {
                planOutcomes.readMcp = (msg.result as { outcome?: unknown })?.outcome
              } else if (msg.id === 952) {
                planOutcomes.execute = (msg.result as { outcome?: unknown })?.outcome
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'cursor-sess-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Plan check done.' } },
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
              } else if (msg.id === 953) {
                agentOutcomes.edit = (msg.result as { outcome?: unknown })?.outcome
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'cursor-sess-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Agent edit done.' } },
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'cursor-sess-1',
                    update: { sessionUpdate: 'session_info_update', title: 'Renamed after text' },
                  },
                })}\n`)
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
              } else if (msg.method === 'session/close') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              }
            }
            nl = buf.indexOf('\n')
          }
        })
        clientToAgent.once('finish', () => {
          agentToClient.end()
          doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        })
        return {
          stdin: clientToAgent,
          stdout: agentToClient,
          done,
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
          terminate: async () => {
            agentToClient.end()
            doneResolve({ exitCode: 0, signal: 'SIGTERM', stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const cursor = new CursorAdapter()
    const probed = await cursor.probe(fakeSubprocess)
    expect(probed.available).toBe(true)
    expect(probed.executablePath).toBe('/Users/test/.local/bin/cursor-agent')
    expect(probed.version).toBe('2026.11.22-e9042b2')
    expect(probed.authStatus).toEqual({ authenticated: true, method: 'cursor_login', summary: 'Logged in' })
    expect(probed.models).toEqual([
      { id: 'default', name: 'Auto (Cursor default)' },
      { id: 'claude-opus-5-5[context=300k,effort=medium,fast=false]', name: 'claude-opus-5-5 (medium · 300k)' },
    ])
    expect(probed.modelContextWindows).toEqual({
      'claude-opus-5-5[context=300k,effort=medium,fast=false]': 300_000,
    })
    expect(probed.commands).toEqual([{ name: 'align', description: 'Align design', source: 'acp' }])

    // Turn 1: plan mode + MCP bridge + parameterized model + effort (no thought_level RPC!)
    const planOutcome = await cursor.runTurn(fakeSubprocess, {
      prompt: 'Check board in plan mode',
      cwd: '/tmp',
      model: 'claude-opus-5-5',
      reasoningEffort: 'medium',
      permissionMode: 'plan',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(planOutcome.externalSessionId).toBe('cursor-sess-1')
    expect(planOutcome.finalText).toBe('Plan check done.')
    expect(planOutcomes.readMcp).toEqual({ outcome: 'selected', optionId: 'allow-once' })
    expect(planOutcomes.execute).toEqual({ outcome: 'cancelled' })
    expect(seenModes).toContain('plan')
    expect(seenConfigSets).toEqual([
      { configId: 'model', value: 'claude-opus-5-5[context=300k,effort=medium,fast=false]' },
    ])
    expect(seenMcpServers[1]).toEqual([{
      type: 'http',
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer tok-cursor' }],
    }])

    // Turn 2: session/load resume in agent mode; session_info_update after text does NOT wipe finalText
    const agentOutcome = await cursor.runTurn(fakeSubprocess, {
      prompt: 'Resume in agent mode',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'cursor-sess-1',
      permissionMode: 'agent',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(agentOutcome.finalText).toBe('Agent edit done.')
    expect(agentOutcomes.edit).toEqual({ outcome: 'selected', optionId: 'allow-once' })
    expect(seenMcpServers[2]).toEqual(seenMcpServers[1])

    // Turn 3: dead session/load triggers ExternalResumeRejectedError
    await expect(cursor.runTurn(fakeSubprocess, {
      prompt: 'Dead session',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'cursor-dead',
      permissionMode: 'agent',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: () => {},
    })).rejects.toBeInstanceOf(ExternalResumeRejectedError)

    await cursor.dispose()
  })
})
