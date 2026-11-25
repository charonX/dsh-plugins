import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { describe, expect, it } from 'vitest'
import { filterModelDirectoryState } from '../src/client/model-filter-core.ts'

function baseDirectoryState(provider: string, model: string): ModelDirectoryState {
  return {
    current: { provider, model },
    routable: true,
    groups: [
      {
        id: 'deepseek-account',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      },
      {
        id: 'ext-agy',
        name: 'Antigravity',
        models: [{ id: 'default', name: 'Default (Antigravity default)' }, { id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
      },
      {
        id: 'ext-claude-code',
        name: 'Claude Code',
        models: [{ id: 'default', name: 'Default' }, { id: 'sonnet', name: 'Claude Sonnet' }],
      },
      {
        id: 'ext-pi',
        name: 'Pi Agent',
        models: [{ id: 'default', name: 'Default' }, { id: 'magpie/deepseek/deepseek-flash', name: 'magpie/deepseek/deepseek-flash' }],
      },
    ],
    failures: [
      { id: 'deepseek-official', name: 'DeepSeek Official', message: 'no key' },
      { id: 'ext-codex', name: 'Codex', message: 'not installed' },
    ],
    status: 'ready',
    pending: null,
    error: null,
  }
}

describe('filterModelDirectoryState', () => {
  it('hides all ext-* providers and failures when agent is native', () => {
    const raw = baseDirectoryState('deepseek-account', 'deepseek-chat')
    const filtered = filterModelDirectoryState(raw, 'native')
    expect(filtered.groups.map(g => g.id)).toEqual(['deepseek-account'])
    expect(filtered.failures.map(f => f.id)).toEqual(['deepseek-official'])
    expect(filtered.routable).toBe(true)
  })

  it('keeps only Antigravity (ext-agy) models when Antigravity is selected', () => {
    const raw = baseDirectoryState('ext-agy', 'gemini-4-neon')
    const filtered = filterModelDirectoryState(raw, 'agy')
    expect(filtered.groups.map(g => g.id)).toEqual(['ext-agy'])
    expect(filtered.groups[0]?.models.map(m => m.id)).toEqual(['default', 'gemini-4-neon'])
    expect(filtered.failures).toEqual([])
    expect(filtered.routable).toBe(true)
  })

  it('marks routable false when current model belongs to a different agent', () => {
    const raw = baseDirectoryState('deepseek-account', 'deepseek-chat')
    const filtered = filterModelDirectoryState(raw, 'claude-code')
    expect(filtered.groups.map(g => g.id)).toEqual(['ext-claude-code'])
    expect(filtered.routable).toBe(false)
  })
})
