import { describe, expect, it } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { listCatalog, resolveSelection, selectionOfProjection } from '../src/models.ts'

describe('resolveSelection', () => {
  const override = { provider: 'local', model: 'm1' }
  const session = { provider: 'deepseek', model: 'm2' }
  const fallback = { provider: 'deepseek', model: 'm3' }

  it('prefers the explicit override', () => {
    expect(resolveSelection(override, session, fallback)).toEqual({ source: 'override', selection: override })
  })

  it('uses the session selection when nothing is pinned', () => {
    expect(resolveSelection(undefined, session, fallback)).toEqual({ source: 'session', selection: session })
  })

  it('falls back to the host default', () => {
    expect(resolveSelection(undefined, undefined, fallback)).toEqual({ source: 'default', selection: fallback })
  })

  it('reports no selection when nothing is configured', () => {
    expect(resolveSelection(undefined, undefined, undefined)).toEqual({ source: null, selection: null })
  })
})

describe('selectionOfProjection', () => {
  it('prefers the newest recorded selection', () => {
    expect(selectionOfProjection({
      lastUsed: { provider: 'a', model: 'b' },
      next: { provider: 'c', model: 'd', reasoningEffort: 'off' },
    })).toEqual({ provider: 'c', model: 'd' })
  })

  it('falls back to the last used route', () => {
    expect(selectionOfProjection({ lastUsed: { provider: 'a', model: 'b' }, next: null }))
      .toEqual({ provider: 'a', model: 'b' })
  })

  it('ignores malformed state', () => {
    expect(selectionOfProjection(null)).toBeUndefined()
    expect(selectionOfProjection({ next: { provider: 1 } })).toBeUndefined()
  })
})

describe('listCatalog', () => {
  it('lists models without resolving reasoning metadata and skips failing providers', async () => {
    let resolved = 0
    const llm = {
      listProviders: () => [
        { id: 'ok', name: 'OK Provider' },
        { id: 'down', name: 'Down Provider' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'down') throw new Error('catalog unavailable')
        return [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }]
      },
      resolveModelInfo: async () => { resolved += 1; return { provider: 'ok', id: 'm1', name: 'm1' } },
    } as unknown as LlmRuntime

    await expect(listCatalog(llm)).resolves.toEqual([{
      id: 'ok',
      name: 'OK Provider',
      models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }],
    }])
    // The settings selector never shows reasoning capability, so the state read
    // must not pay a per-model adapter round trip for it.
    expect(resolved).toBe(0)
  })
})
