import { describe, expect, test } from 'vitest'
import { emptyTeamConfig } from '../../src/team-config/team-config-core.ts'
import { PIPELINE_PRESETS, applyPresetToTeamConfig } from '../../src/team-config/presets.ts'

describe('team-config presets', () => {
  test('ships 3 read-only presets using template variables with zero repo assumptions', () => {
    expect(PIPELINE_PRESETS.map(p => p.id)).toEqual([
      'requirement-impl',
      'bug-fix',
      'readonly-analysis',
    ])
    for (const preset of PIPELINE_PRESETS) {
      for (const stage of preset.stages) {
        const combined = `${stage.role}\n${stage.instruction}`
        expect(combined).toMatch(/\{\{(project|env)\./)
        expect(combined).not.toContain('dsh-manager')
      }
    }
  })

  test('applyPresetToTeamConfig creates missing crew, reuses matching (agentKind, role), and makes independent pipelines', () => {
    let seq = 0
    const nextId = (prefix: string): string => `${prefix}-${++seq}`

    const base = emptyTeamConfig()
    const first = applyPresetToTeamConfig(base, 'bug-fix', 1000, nextId)
    expect(first.pipeline.name).toBe('缺陷修复')
    expect(first.pipeline.stages).toHaveLength(3)
    expect(first.pipeline.stages[2]?.mode).toBe('review')
    expect(first.createdMembers).toHaveLength(3)
    expect(first.nextDoc.crew).toHaveLength(3)

    // Applying again reuses all 3 matching members and assigns unique pipeline name
    const second = applyPresetToTeamConfig(first.nextDoc, 'bug-fix', 2000, nextId)
    expect(second.createdMembers).toHaveLength(0)
    expect(second.nextDoc.crew).toHaveLength(3)
    expect(second.pipeline.name).toBe('缺陷修复 (2)')
    expect(second.pipeline.stages.map(s => s.memberId)).toEqual(first.pipeline.stages.map(s => s.memberId))

    // A member with different agentKind is NOT reused even with identical role
    const customDoc = {
      ...first.nextDoc,
      crew: first.nextDoc.crew.map((m, idx) => idx === 0 ? { ...m, agentKind: 'claude-code' as const } : m),
    }
    const third = applyPresetToTeamConfig(customDoc, 'bug-fix', 3000, nextId)
    expect(third.createdMembers).toHaveLength(1)
  })
})
