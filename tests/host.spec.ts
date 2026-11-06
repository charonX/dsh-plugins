import { describe, expect, it } from 'vitest'
import { providerNamespaceOf } from '../src/client/host.ts'
import type { NamespaceView } from '../src/client/host.ts'

const namespaces: NamespaceView[] = [
  { ns: 'llm-deepseek', value: { models: [] }, revision: 1 },
  { ns: 'llm-pi-ai', value: { providers: {} }, revision: 3 },
  { ns: 'ui-settings-models', value: { someSetting: true }, revision: 2 },
]

describe('providerNamespaceOf', () => {
  it('picks the namespace that carries a providers dictionary', () => {
    expect(providerNamespaceOf(namespaces)).toBe('llm-pi-ai')
  })

  it('ignores namespaces with other shapes', () => {
    expect(providerNamespaceOf(namespaces.slice(0, 1))).toBeUndefined()
    expect(providerNamespaceOf([])).toBeUndefined()
  })
})
