import { describe, expect, it } from 'vitest'
import { providerNamespaceOf } from '../src/client/host.ts'
import type { NamespaceView } from '../src/client/host.ts'

const view = (entries: readonly { ns: string; value: unknown }[]): NamespaceView[] =>
  entries.map((entry, index) => ({ ...entry, revision: index + 1 }))

describe('provider namespace discovery', () => {
  it('finds the pi-ai namespace from the mirror alone, without the Remote directory', () => {
    // The page must render even when llm/listConfigurableProviders is
    // unavailable: the mirror already holds the value.
    expect(providerNamespaceOf(view([
      { ns: 'llm-deepseek', value: { models: [] } },
      { ns: 'llm-pi-ai', value: { providers: { siliconflow: { models: [] } } } },
    ]))).toBe('llm-pi-ai')
  })

  it('ignores a provider dictionary that is not an object', () => {
    expect(providerNamespaceOf(view([{ ns: 'llm-pi-ai', value: { providers: null } }]))).toBeUndefined()
  })
})
