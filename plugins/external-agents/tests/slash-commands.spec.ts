import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutlineRegular: () => null,
}))

import { buildAgentSlashCandidates, createExternalSlashSource } from '../src/client/slash-commands.ts'
import type { AgentDescriptor } from '../src/types.ts'

const claudeDescriptor: AgentDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  command: 'claude',
  available: true,
  models: [{ id: 'default', name: 'Default' }],
  permissionModes: [],
  commands: [
    { name: 'simplify', description: 'Review and clean up changed code', argumentHint: '[<target>]' },
    { name: 'code-review', description: 'Review current diff for bugs' },
    { name: 'verify', description: 'Exercise affected flow end-to-end' },
  ],
}

const nativeDescriptor: AgentDescriptor = {
  id: 'native',
  label: 'DSH Native',
  command: '',
  available: true,
  models: [],
  permissionModes: [],
  commands: [],
}

describe('external agent slash command source', () => {
  it('ranks prefix matches before description/substring matches and omits native agents', () => {
    expect(buildAgentSlashCandidates(nativeDescriptor, '')).toEqual([])

    const matches = buildAgentSlashCandidates(claudeDescriptor, 'ver', a => `${a.label} 指令`)
    expect(matches.map(m => m.name)).toEqual(['verify'])
    expect(matches[0]?.section).toBe('Claude Code 指令')

    const reviewMatches = buildAgentSlashCandidates(claudeDescriptor, 'review')
    expect(reviewMatches.map(m => m.name)).toEqual(['code-review', 'simplify'])
    expect(reviewMatches[1]?.description).toBe('[<target>] · Review and clean up changed code')
  })

  it('fetches catalog dynamically for non-native sessions and inserts plain /command text on pick', async () => {
    let cached: readonly AgentDescriptor[] | undefined
    const fetchCatalog = vi.fn(async () => {
      cached = [nativeDescriptor, claudeDescriptor]
      return cached
    })
    const source = createExternalSlashSource({
      getAgentId: () => 'native',
      fetchSessionAgentId: async () => 'claude-code',
      getCachedCatalog: () => cached,
      fetchCatalog,
      sectionLabel: a => `${a.label} Commands`,
    })

    const session = { sessionId: brandString<SessionId>('s-1') }
    const candidates = await source.candidates(session, {
      query: 'sim',
      position: 'leading',
      drilled: false,
      signal: new AbortController().signal,
    })

    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.name).toBe('simplify')
    expect(candidates[0]?.section).toBe('Claude Code Commands')

    const outcome = source.onPick({
      candidate: candidates[0]!,
      session,
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 4, draftRev: 0 },
    })
    expect(outcome).toEqual({ text: '/simplify ' })
  })

  it('prefers session-scoped commands from workspace cwd over global catalog commands and warms them', async () => {
    const cached: readonly AgentDescriptor[] = [
      nativeDescriptor,
      { ...claudeDescriptor, commands: [{ name: 'global-only', description: 'Global command' }] },
    ]
    const sessionCommands = new Map<string, readonly { name: string; description?: string }[]>()
    const fetchSessionCommands = vi.fn(async (sid: string) => {
      const cmds = [{ name: 'align', description: 'Workspace skill from cwd' }]
      sessionCommands.set(`${sid}:claude-code`, cmds)
      return cmds
    })
    const source = createExternalSlashSource({
      getAgentId: () => 'claude-code',
      fetchSessionAgentId: async () => 'claude-code',
      getCachedCatalog: () => cached,
      fetchCatalog: async () => cached,
      getCachedSessionCommands: (sid, agentId) => sessionCommands.get(`${sid}:${agentId}`),
      fetchSessionCommands,
      sectionLabel: a => `${a.label} 指令`,
    })

    const session = { sessionId: brandString<SessionId>('s-cwd-1') }
    source.warm?.(session)
    await Promise.resolve()
    await Promise.resolve()

    const candidates = await source.candidates(session, {
      query: 'ali',
      position: 'leading',
      drilled: false,
      signal: new AbortController().signal,
    })

    expect(fetchSessionCommands).toHaveBeenCalledTimes(1)
    expect(fetchSessionCommands).toHaveBeenCalledWith('s-cwd-1', 'claude-code')
    expect(candidates.map(c => c.name)).toEqual(['align'])
    expect(candidates[0]?.section).toBe('Claude Code 指令')
  })
})
