/** Unit tests for domain-agnostic Flow IR presets (coding + knowledge creation). */
import { describe, expect, test } from 'vitest'
import { FLOW_PRESETS, materializeFlowPreset, validateFlows } from '../../src/flow/flow-ir.ts'

describe('flow-ir presets', () => {
  test('built-in presets cover code-dev, bug-fix, and knowledge-creation without repo hardcoding', () => {
    expect(FLOW_PRESETS.map(p => p.id)).toEqual(['code-dev', 'bug-fix', 'knowledge-creation'])
    const serialized = JSON.stringify(FLOW_PRESETS)
    expect(serialized).not.toContain('home-repos')
    expect(serialized).not.toContain('dsh-manager')

    const knowledge = FLOW_PRESETS.find(p => p.id === 'knowledge-creation')!
    expect(knowledge.workspaceMode).toBe('in-place')
    expect(knowledge.steps.some(s => s.onFail === 'draft')).toBe(true)
  })

  test('materializeFlowPreset produces valid independent editable flows with unique names', () => {
    const f1 = materializeFlowPreset([], 'bug-fix', 100, p => `${p}-1`)
    const f2 = materializeFlowPreset([f1], 'bug-fix', 200, p => `${p}-2`)
    expect(f1.name).toBe('通用缺陷修复')
    expect(f2.name).toBe('通用缺陷修复 (2)')
    expect(f1.workspaceMode).toBe('worktree')
    expect(() => validateFlows([f1, f2])).not.toThrow()
  })
})
