import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistryPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmPlugin, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionPlugin, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
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

  it('does not register ext-* LLM providers or presets by default, switches agents without mutating agent.model, and manages config/session model state', async () => {
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

    const registeredPresetIds: string[] = []
    ctx.provide('agentPresets')
    ;(ctx as unknown as { agentPresets: unknown }).agentPresets = {
      defaultId: 'standard',
      presetForSession: () => null,
      register: async (def: { id: string }) => {
        registeredPresetIds.push(def.id)
        return async () => {}
      },
      select: async () => {},
    }

    await ctx.plugin(ExternalAgentsService, {
      storeFile: join(dir, 'sessions.json'),
      configFile: join(dir, 'config.json'),
      quotaFile: join(dir, 'quotas.json'),
      registerSubagents: false,
    })

    const svc = ctx.externalAgents
    expect(svc).toBeDefined()

    // No fake ext-* providers in ctx.llm and no ext-* AgentPresets registered.
    expect(ctx.llm.listProviders().some(p => p.id.startsWith('ext-'))).toBe(false)
    expect(registeredPresetIds).toEqual([])

    const catalog = await svc.getCatalog()
    expect(catalog.agents.map(a => a.id)).toEqual(['native', 'agy', 'claude-code', 'pi', 'codex', 'cursor'])

    // Catalog exposes reasoning, permission modes, and quota snapshots for settings & dsh-manager flow nodes.
    const agyDesc = catalog.agents.find(a => a.id === 'agy')
    const claudeDesc = catalog.agents.find(a => a.id === 'claude-code')
    const piDesc = catalog.agents.find(a => a.id === 'pi')
    const codexDesc = catalog.agents.find(a => a.id === 'codex')
    const cursorDesc = catalog.agents.find(a => a.id === 'cursor')
    expect(agyDesc?.label).toBe('Antigravity')
    expect(agyDesc?.permissionModes.map(m => m.id)).toContain('accept-edits')
    expect(claudeDesc?.permissionModes.map(m => m.id)).toContain('dontAsk')
    expect(codexDesc?.permissionModes.map(m => m.id)).toContain('workspace-write')
    expect(codexDesc?.reasoning?.efforts.map(e => e.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(piDesc?.permissionModes).toEqual([])
    expect(piDesc?.quota?.status).toBe('unsupported')
    expect(cursorDesc?.label).toBe('Cursor')
    expect(cursorDesc?.defaultPermissionMode).toBe('agent')
    expect(cursorDesc?.permissionModes.map(m => m.id)).toEqual(['agent', 'plan', 'ask'])
    expect(cursorDesc?.quota?.status).toBe('unsupported')

    // Global config defaults & per-agent settings round-trip.
    const updatedCfg = await svc.updateConfig({
      defaultAgent: 'native',
      agentId: 'pi',
      settings: {
        defaultModel: 'custom/pi-model',
        defaultReasoningEffort: 'high',
        customModels: [{ id: 'custom/pi-model', name: 'Custom Pi' }],
      },
    })
    expect(updatedCfg.agents.pi?.defaultModel).toBe('custom/pi-model')
    expect(updatedCfg.agents.pi?.defaultReasoningEffort).toBe('high')

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-svc-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handle.dispose())

    // Before first turn, switching to an installed agent (e.g. pi) preserves native agent.model and seeds configured defaults.
    if (piDesc?.available) {
      const switched = await svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'pi' })
      expect(switched.agentId).toBe('pi')
      expect(switched.permissionMode).toBeUndefined()
      expect(switched.locked).toBe(false)
      expect(switched.selectedExternalModel).toEqual({
        model: 'custom/pi-model',
        reasoningEffort: 'high',
      })
      // Underlying DSH native model stays clean instead of being overwritten with `ext-*`.
      expect(handle.agent.model.current()?.provider).toBe('deepseek')

      // Updating external model & effort via selectSessionModel updates session state without touching native agent.model.
      const updatedModel = await svc.selectSessionModel({
        sessionId: 'sess-svc-1',
        model: 'default',
        reasoningEffort: 'xhigh',
      })
      expect(updatedModel.selectedExternalModel).toEqual({
        model: 'default',
        reasoningEffort: 'xhigh',
      })
      expect(handle.agent.model.current()?.provider).toBe('deepseek')

      // Passing reasoningEffort: null clears explicit effort back to CLI default.
      const clearedEffort = await svc.selectSessionModel({
        sessionId: 'sess-svc-1',
        reasoningEffort: null,
      })
      expect(clearedEffort.selectedExternalModel).toEqual({ model: 'default' })

      // Pi has no permission mode system -> updating permissionMode rejects.
      await expect(
        svc.selectSessionPermission({ sessionId: 'sess-svc-1', permissionMode: 'plan' }),
      ).rejects.toThrow(/does not support permission modes/i)

      const back = await svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'native' })
      expect(back.agentId).toBe('native')
      expect(back.selectedExternalModel).toBeUndefined()
      expect(handle.agent.model.current()?.provider).toBe('deepseek')
      expect(handle.agent.model.current()?.model).toBe('deepseek-chat')
    }

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
    if (codexDesc && !codexDesc.available) {
      await expect(
        svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'codex' }),
      ).rejects.toThrow()
    }

    // Simulate a started turn -> agent selection must lock, while model selection remains editable.
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const lockedState = await svc.getSessionState('sess-svc-1')
    expect(lockedState.locked).toBe(true)

    await expect(
      svc.selectSessionAgent({ sessionId: 'sess-svc-1', agentId: 'claude-code' }),
    ).rejects.toThrow(/cannot be switched/i)

    if (agyDesc?.available) {
      const midTurnModel = await svc.selectSessionModel({
        sessionId: 'sess-svc-1',
        model: 'gemini-4-neon',
        reasoningEffort: 'high',
      })
      expect(midTurnModel.selectedExternalModel).toEqual({
        model: 'gemini-4-neon',
        reasoningEffort: 'high',
      })
    }
  }, 20_000)

  it('auto-binds newly created blank sessions when config.defaultAgent is set to an available CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-default-agent-'))
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
      configFile: join(dir, 'config.json'),
      quotaFile: join(dir, 'quotas.json'),
      registerSubagents: false,
    })

    const svc = ctx.externalAgents
    const catalog = await svc.getCatalog()
    const availableExt = catalog.agents.find(a => a.id !== 'native' && a.available)
    if (availableExt === undefined) return

    await svc.updateConfig({
      defaultAgent: availableExt.id,
      agentId: availableExt.id as never,
      settings: { defaultReasoningEffort: 'medium' },
    })

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-auto-default'),
      meta: { cwd: dir },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handle.dispose())

    await new Promise(resolve => setTimeout(resolve, 100))
    const state = await svc.getSessionState('sess-auto-default')
    expect(state.agentId).toBe(availableExt.id)
    expect(state.selectedExternalModel?.reasoningEffort).toBe('medium')
  }, 20_000)

  it('probes and caches session slash commands using each session workspace cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ext-cwd-cmds-'))
    const dirA = join(root, 'workspace-a')
    const dirB = join(root, 'workspace-b')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    const spawnLog: Array<{ bin: string; cwd?: string | undefined; args: readonly string[] }> = []
    const fakeSubprocess = {
      resolveExecutable: async (cmd: string) => `/fake/bin/${cmd}`,
      spawn: ((opts: { argv: readonly string[]; cwd?: string }) => {
        const bin = opts.argv[0] ?? ''
        spawnLog.push({ bin, cwd: opts.cwd, args: opts.argv })
        const stdout = new PassThrough()
        const stdin = new PassThrough()
        let resolveDone!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
          resolveDone = r
        })

        if (opts.argv.includes('--version')) {
          queueMicrotask(() => {
            stdout.end('1.0.0\n')
            resolveDone({ exitCode: 0, signal: null, stdout: '1.0.0\n', stderr: '' })
          })
        } else if (bin.endsWith('/claude') && opts.argv.includes('auth')) {
          queueMicrotask(() => {
            stdout.end('{"loggedIn":false}\n')
            resolveDone({ exitCode: 0, signal: null, stdout: '{"loggedIn":false}\n', stderr: '' })
          })
        } else if (bin.endsWith('/claude')) {
          stdin.on('data', () => {
            const cmds = opts.cwd === dirA
              ? [{ name: 'align', description: 'Skill from A', builtin: false }]
              : opts.cwd === dirB
                ? [{ name: 'how', description: 'Skill from B', builtin: false }]
                : [{ name: 'global-only', description: 'Global', builtin: true }]
            stdout.write(`${JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', response: { commands: cmds, models: [] } },
            })}\n`)
          })
        } else {
          queueMicrotask(() => {
            stdout.end()
            resolveDone({ exitCode: 1, signal: null, stdout: '', stderr: '' })
          })
        }

        return {
          stdin,
          stdout,
          done,
          collected: {
            stdout: { readFrom: () => ({ text: opts.argv.includes('--version') ? '1.0.0\n' : '' }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
          terminate: async () => {
            stdout.end()
            resolveDone({ exitCode: 0, signal: null, stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      }) as SubprocessRuntime['spawn'],
    } as unknown as SubprocessRuntime

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    ctx.provide('subprocess')
    ;(ctx as unknown as { subprocess: SubprocessRuntime }).subprocess = fakeSubprocess
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })
    await ctx.plugin(ExternalAgentsService, {
      storeFile: join(root, 'sessions.json'),
      configFile: join(root, 'config.json'),
      quotaFile: join(root, 'quotas.json'),
      registerAgentPresets: false,
      registerSubagents: false,
    })

    const svc = ctx.externalAgents

    const handleA = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-cwd-a'),
      meta: { cwd: dirA },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handleA.dispose())

    const handleB = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-cwd-b'),
      meta: { cwd: dirB },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handleB.dispose())

    // Native session returns empty external commands.
    expect(await svc.getSessionCommands('sess-cwd-a')).toEqual({
      agentId: 'native',
      commands: [],
    })

    await svc.selectSessionAgent({ sessionId: 'sess-cwd-a', agentId: 'claude-code' })
    await svc.selectSessionAgent({ sessionId: 'sess-cwd-b', agentId: 'claude-code' })

    const beforeCount = spawnLog.filter(s => s.bin.endsWith('/claude') && s.cwd === dirA).length
    expect(beforeCount).toBe(0)

    const [resA1, resA2] = await Promise.all([
      svc.getSessionCommands('sess-cwd-a'),
      svc.getSessionCommands('sess-cwd-a'),
    ])
    expect(resA1).toEqual({
      agentId: 'claude-code',
      commands: [{ name: 'align', description: 'Skill from A', source: 'custom' }],
    })
    expect(resA2).toEqual(resA1)
    // Concurrent calls for the same (agentId, cwd) share a single probe.
    expect(spawnLog.filter(s => s.bin.endsWith('/claude') && s.cwd === dirA)).toHaveLength(1)

    const resB = await svc.getSessionCommands('sess-cwd-b')
    expect(resB).toEqual({
      agentId: 'claude-code',
      commands: [{ name: 'how', description: 'Skill from B', source: 'custom' }],
    })
    expect(spawnLog.filter(s => s.bin.endsWith('/claude') && s.cwd === dirB)).toHaveLength(1)
  })

  it('degrades gracefully when cursor/external CLIs are missing without affecting DSH Native sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-missing-cursor-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const missingSubprocess = {
      resolveExecutable: async (cmd: string) => {
        throw new Error(`ENOENT: ${cmd} not found`)
      },
      spawn: () => {
        throw new Error('should not spawn missing CLI')
      },
    } as unknown as SubprocessRuntime

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    ctx.provide('subprocess')
    ;(ctx as unknown as { subprocess: SubprocessRuntime }).subprocess = missingSubprocess
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })
    await ctx.plugin(ExternalAgentsService, {
      storeFile: join(dir, 'sessions.json'),
      configFile: join(dir, 'config.json'),
      quotaFile: join(dir, 'quotas.json'),
      registerAgentPresets: false,
      registerSubagents: false,
    })

    const svc = ctx.externalAgents
    const catalog = await svc.getCatalog()
    const nativeDesc = catalog.agents.find(a => a.id === 'native')
    const cursorDesc = catalog.agents.find(a => a.id === 'cursor')
    expect(nativeDesc?.available).toBe(true)
    expect(cursorDesc?.available).toBe(false)

    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-native-safe'),
      meta: { cwd: dir },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    cleanups.push(() => handle.dispose())

    const state = await svc.getSessionState('sess-native-safe')
    expect(state.agentId).toBe('native')
    expect(handle.agent.model.current()?.provider).toBe('deepseek')

    await expect(
      svc.selectSessionAgent({ sessionId: 'sess-native-safe', agentId: 'cursor' }),
    ).rejects.toThrow()

    // Session remains cleanly on native after failed switch to uninstalled cursor.
    expect((await svc.getSessionState('sess-native-safe')).agentId).toBe('native')
  })
})
