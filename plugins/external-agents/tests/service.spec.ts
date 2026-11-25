import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistryPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmPlugin, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionPlugin, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SubprocessLocalPlugin from '@deepseek-ai/dsh-subprocess-local'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'
import ToolsPlugin from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import ExternalAgentsService from '../src/index.ts'

describe('ExternalAgentsService', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn()
    }
  })

  it('registers ext-* LLM routes, switches agents only while blank, and locks after first turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-svc-'))
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
    await ctx.plugin(ExternalAgentsService, {
      storeFile: join(dir, 'sessions.json'),
      registerAgentPresets: false,
      registerSubagents: false,
    })

    const svc = ctx.externalAgents
    expect(svc).toBeDefined()

    const catalog = await svc.getCatalog()
    expect(catalog.agents.map(a => a.id)).toEqual(['native', 'agy', 'claude-code', 'pi', 'codex'])

    // Verify per-agent permission systems differ and Pi has none.
    const agyDesc = catalog.agents.find(a => a.id === 'agy')
    const claudeDesc = catalog.agents.find(a => a.id === 'claude-code')
    const piDesc = catalog.agents.find(a => a.id === 'pi')
    const codexDesc = catalog.agents.find(a => a.id === 'codex')
    expect(agyDesc?.label).toBe('Antigravity')
    expect(agyDesc?.permissionModes.map(m => m.id)).toContain('accept-edits')
    expect(claudeDesc?.permissionModes.map(m => m.id)).toContain('dontAsk')
    expect(codexDesc?.permissionModes.map(m => m.id)).toContain('workspace-write')
    expect(piDesc?.permissionModes).toEqual([])

    // ext-agy models and provider availability label should reflect live probe after getCatalog()
    const agyModels = await ctx.llm.listModels('ext-agy')
    expect(agyModels.length).toBeGreaterThan(0)
    const piModels = await ctx.llm.listModels('ext-pi')
    expect(piModels.length).toBeGreaterThan(0)
    const providers = ctx.llm.listProviders()
    if (agyDesc?.available) {
      expect(providers.find(p => p.id === 'ext-agy')?.name).toBe('Antigravity')
    }
    if (claudeDesc?.available) {
      expect(providers.find(p => p.id === 'ext-claude-code')?.name).toBe('Claude Code')
    }

    // Reasoning levels ride the ext-* routes so the composer model menu exposes them.
    const codexModelInfo = await ctx.llm.resolveModelInfo('ext-codex', 'default')
    expect(codexModelInfo.reasoning?.efforts.map(effort => effort.id))
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    const agyModelInfo = await ctx.llm.resolveModelInfo('ext-agy', 'default')
    expect(agyModelInfo.reasoning?.efforts.length).toBeGreaterThan(0)

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-svc-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handle.dispose())

    // Before first turn, switching to an installed agent (e.g. pi) or back to native works.
    const piInfo = catalog.agents.find(a => a.id === 'pi')
    if (piInfo?.available) {
      const switched = await svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'pi' })
      expect(switched.agentId).toBe('pi')
      expect(switched.permissionMode).toBeUndefined()
      expect(switched.locked).toBe(false)
      expect(handle.agent.model.current()?.provider).toBe('ext-pi')

      // Pi has no permission mode system -> updating permissionMode rejects.
      await expect(
        svc.selectSessionPermission({ sessionId: 'sess-svc-1', permissionMode: 'plan' }),
      ).rejects.toThrow(/does not support permission modes/i)

      const back = await svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'native' })
      expect(back.agentId).toBe('native')
      expect(handle.agent.model.current()?.provider).toBe('deepseek')
      expect(handle.agent.model.current()?.model).toBe('deepseek-chat')
    }

    // Regression: synchronous agent-preset/selected emitted inside session/event
    // publication must NOT reenter Session.append() synchronously.
    const unsubRepro = ctx.on('session/event', (session, event) => {
      if (event.type === 'agent-preset/selected') {
        ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
      }
    }, { global: true })
    cleanups.push(() => { unsubRepro() })
    expect(() => {
      handle.agent.session.append('agent-preset/selected', { agentPreset: 'ext-claude-code' })
    }).not.toThrow()
    await Promise.resolve()
    expect(handle.agent.model.current()?.provider).toBe('ext-claude-code')
    // Reset back to deepseek before testing Antigravity below.
    handle.agent.model.select({ provider: 'deepseek', model: 'deepseek-chat' })

    if (agyDesc?.available) {
      const switchedAgy = await svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'agy' })
      expect(switchedAgy.permissionMode).toBe('accept-edits')
      const updatedPerm = await svc.selectSessionPermission({ sessionId: 'sess-svc-1', permissionMode: 'plan' })
      expect(updatedPerm.permissionMode).toBe('plan')
      await expect(
        svc.selectSessionPermission({ sessionId: 'sess-svc-1', permissionMode: 'nonexistent' }),
      ).rejects.toThrow(/Invalid permission mode/i)
    }

    // Switching to an uninstalled agent (codex, if absent on host) fails loudly.
    const codexInfo = catalog.agents.find(a => a.id === 'codex')
    if (codexInfo && !codexInfo.available) {
      await expect(
        svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'codex' }),
      ).rejects.toThrow()
    }

    // Simulate a started turn -> agent selection must lock.
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const lockedState = await svc.getSessionState('sess-svc-1')
    expect(lockedState.locked).toBe(true)

    await expect(
      svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'agy' }),
    ).rejects.toThrow(/cannot be switched/i)
  }, 20_000)

  it('registers ext-* AgentPresets even when agentPresets service starts AFTER ExternalAgentsService (cold boot race)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-preset-race-'))
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

    // Start ExternalAgentsService BEFORE agentPresets is provided (mirrors cold boot order).
    await ctx.plugin(ExternalAgentsService, {
      storeFile: join(dir, 'sessions.json'),
      registerAgentPresets: true,
      registerSubagents: false,
    })

    const registeredIds: string[] = []
    ctx.provide('agentPresets')
    ;(ctx as unknown as { agentPresets: unknown }).agentPresets = {
      defaultId: 'default',
      presetForSession: () => null,
      register: async (def: { id: string }) => {
        registeredIds.push(def.id)
        return async () => {}
      },
      select: async () => {},
    }
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(registeredIds).toEqual(
      expect.arrayContaining(['ext-agy', 'ext-claude-code', 'ext-pi', 'ext-codex']),
    )
  })
})
