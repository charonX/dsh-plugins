import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExternalTasksStore } from '../src/client/external-tasks-store.ts'
import { ConcurrentExternalSessionError, ExternalSessionStore } from '../src/session-store.ts'

describe('ExternalSessionStore', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists session bindings and restores externalSessionId across reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-agents-store-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.json')

    const store1 = new ExternalSessionStore(file)
    store1.setAgent('s-1', 'agy', {
      nativeFallbackModel: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    store1.recordExternalSessionId('s-1', 'agy', 'agy-conv-123')

    const store2 = new ExternalSessionStore(file)
    const loaded = store2.get('s-1')
    expect(loaded?.agentId).toBe('agy')
    expect(loaded?.externalSessionId).toBe('agy-conv-123')
    expect(loaded?.nativeFallbackModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('rejects concurrent execution on the same DSH or external conversation id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-agents-lock-'))
    dirs.push(dir)
    const store = new ExternalSessionStore(join(dir, 'sessions.json'))

    const release = store.acquireRun('s-1', 'ext-conv-1')
    expect(store.isRunning('s-1')).toBe(true)
    expect(() => store.acquireRun('s-1', 'ext-conv-1')).toThrow(ConcurrentExternalSessionError)
    expect(() => store.acquireRun('s-2', 'ext-conv-1')).toThrow(ConcurrentExternalSessionError)

    release()
    expect(store.isRunning('s-1')).toBe(false)
    const releaseAgain = store.acquireRun('s-2', 'ext-conv-1')
    releaseAgain()
  })

  it('retains background tasks across turn locks while backgroundActive is set and keeps client polling until done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-agents-bg-'))
    dirs.push(dir)
    const store = new ExternalSessionStore(join(dir, 'sessions.json'))

    const release1 = store.acquireRun('s-bg', 'ext-bg-1')
    store.upsertTask('s-bg', {
      taskId: 'cmd-1',
      toolUseId: 'cmd-1',
      label: 'Command',
      description: 'sleep 5',
      status: 'running',
      startedAt: 100,
      updatedAt: 100,
    })
    store.setBackgroundActive('s-bg', true)
    release1()

    expect(store.isRunning('s-bg')).toBe(false)
    expect(store.getTasks('s-bg')).toHaveLength(1)

    // Client tasks store re-polls when running goes false and retains active background tasks.
    let serverRunning = true
    const clientStore = createExternalTasksStore(async () => ({
      sessionId: 's-bg',
      agentId: 'agy',
      locked: true,
      running: false,
      activeTasks: serverRunning
        ? [{ taskId: 'cmd-1', label: 'Command', description: 'sleep 5', status: 'running', startedAt: 100, updatedAt: 100 }]
        : [],
    }))
    const unsub = clientStore.subscribe('s-bg', () => {})
    clientStore.syncRunning('s-bg', true)
    clientStore.syncRunning('s-bg', false)
    await new Promise(r => setTimeout(r, 20))
    expect(clientStore.getSnapshot('s-bg')).toHaveLength(1)

    serverRunning = false
    await new Promise(r => setTimeout(r, 1_100))
    expect(clientStore.getSnapshot('s-bg')).toEqual([])
    unsub()

    store.clearBackgroundState('s-bg')
    expect(store.getTasks('s-bg')).toEqual([])
  })

  it('clears rejected externalSessionId conditionally without losing agent, model, or permission bindings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-agents-clear-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.json')

    const store = new ExternalSessionStore(file)
    store.setAgent('s-clear', 'agy', {
      externalSessionId: 'stale-ext-1',
      model: 'gemini-4-neon',
      reasoningEffort: 'high',
      permissionMode: 'plan',
      nativeFallbackModel: { provider: 'deepseek', model: 'deepseek-chat' },
    })

    // Mismatched expectedExternalSessionId leaves the binding untouched.
    expect(store.clearExternalSessionId('s-clear', 'agy', 'other-id')).toBe(false)
    expect(store.get('s-clear')?.externalSessionId).toBe('stale-ext-1')

    // Matching id clears only externalSessionId and persists across reloads.
    expect(store.clearExternalSessionId('s-clear', 'agy', 'stale-ext-1')).toBe(true)
    const reloaded = new ExternalSessionStore(file).get('s-clear')
    expect(reloaded?.externalSessionId).toBeUndefined()
    expect(reloaded?.agentId).toBe('agy')
    expect(reloaded?.model).toBe('gemini-4-neon')
    expect(reloaded?.reasoningEffort).toBe('high')
    expect(reloaded?.permissionMode).toBe('plan')
    expect(reloaded?.nativeFallbackModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})
