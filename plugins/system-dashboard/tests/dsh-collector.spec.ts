import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { collectDshSnapshot } from '../src/collectors/dsh.ts'

describe('collectDshSnapshot', () => {
  it('gracefully degrades on minimal context without optional services', async () => {
    const minimalCtx = {
      get: () => undefined,
    } as unknown as Context

    const snap = await collectDshSnapshot(minimalCtx)
    expect(snap.process.pid).toBe(process.pid)
    expect(snap.agents.total).toBe(0)
    expect(snap.sessions.total).toBe(0)
    expect(snap.workspaces.total).toBe(0)
    expect(snap.mcp.available).toBe(false)
    expect(snap.skills.available).toBe(false)
    expect(snap.schedules.available).toBe(false)
  })

  it('collects live DSH services when present', async () => {
    const services: Record<string, unknown> = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' }),
      },
      llm: {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] }],
      },
      agents: {
        list: () => [
          { id: 'sess-1', status: 'running', session: { seq: 12, header: { cwd: '/tmp/proj', createdAt: 1000 } } },
          { id: 'sess-2', status: 'idle', session: { seq: 4, header: { cwd: '/tmp/proj2', createdAt: 2000 } } },
        ],
      },
      sessions: {
        list: () => [
          { id: 'sess-1', seq: 12, header: { cwd: '/tmp/proj', createdAt: 1000 } },
          { id: 'sess-2', seq: 4, header: { cwd: '/tmp/proj2', createdAt: 2000 } },
        ],
      },
      sessionTitle: {
        get: (s: { id: string }) => ({ title: `Title for ${s.id}` }),
      },
      workspaceRegistry: {
        list: () => [{ id: 'ws-1', title: 'dsh', path: '/tmp/proj', sessionIds: ['sess-1', 'sess-archived'] }],
        archivedSessionIds: ['sess-archived'],
      },
      mcpManager: {
        list: () => [{ name: 'fs', configured: true, status: { state: 'ready' } }],
      },
      skills: {
        list: async () => [{ name: 'tdd' }, { name: 'research' }],
      },
      schedule: {
        list: async () => ({ items: [{ status: 'active' }, { status: 'paused' }], total: 2 }),
      },
      loader: {
        entries: () => [
          { options: { name: 'a' }, fiber: { state: 2 } },
          { options: { name: 'b' }, fiber: { state: 3 } },
        ],
      },
    }

    const ctx = {
      get: (name: string) => services[name],
    } as unknown as Context

    const snap = await collectDshSnapshot(ctx)
    expect(snap.defaultModel).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    expect(snap.providers).toEqual([{ id: 'deepseek-official', name: 'DeepSeek', modelCount: 2 }])
    expect(snap.agents.total).toBe(2)
    expect(snap.agents.running).toBe(1)
    expect(snap.agents.idle).toBe(1)
    expect(snap.sessions.items[0]?.title).toBe('Title for sess-2')
    expect(snap.workspaces.items[0]?.sessionCount).toBe(1)
    expect(snap.mcp.connected).toBe(1)
    expect(snap.skills.total).toBe(2)
    expect(snap.schedules.active).toBe(1)
    expect(snap.plugins).toEqual({ total: 2, active: 1, failed: 1, failedNames: ['b'] })
  })
})
