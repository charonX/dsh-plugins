/** Regression tests for enriching `agentKindOptions` with `externalAgents` slash commands. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import { DshManagerCrew } from '../../src/crew-service.ts'

describe('DshManagerCrew.agentKindOptions', () => {
  test('attaches slashCommands from ExternalAgentsService.getCatalog() `{ agents }` payload', async () => {
    const root = new Context()
    const child = root.extend()

    root.provide('storageDomain' as never, { open: vi.fn() } as never)
    root.provide('llm' as never, { listProviders: () => [], listModels: async () => [] } as never)
    root.provide('externalAgents' as never, {
      getCatalog: vi.fn().mockResolvedValue({
        agents: [
          {
            id: 'claude-code',
            commands: [{ name: 'code-review', description: 'Review diff', argumentHint: '[--fix]' }],
          },
          {
            id: 'agy',
            commands: [{ name: 'plan', description: 'Plan carefully' }],
          },
        ],
      }),
    } as never)

    const crew = new DshManagerCrew(child, {})
    const { kinds } = await crew.agentKindOptions({ refresh: false })

    const claude = kinds.find(k => k.kind === 'claude-code')
    const agy = kinds.find(k => k.kind === 'agy')
    expect(claude?.slashCommands).toEqual([
      { name: 'code-review', description: 'Review diff', argumentHint: '[--fix]' },
    ])
    expect(agy?.slashCommands).toEqual([
      { name: 'plan', description: 'Plan carefully' },
    ])
  })
})
