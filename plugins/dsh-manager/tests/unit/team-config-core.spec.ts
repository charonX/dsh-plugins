/** Unit tests for Flow IR v3 YAML parsing, serialization, cross-entity validation, and v1/v2 migration. */
import { describe, expect, test } from 'vitest'
import {
  emptyTeamConfig,
  parseTeamConfigYaml,
  sanitizeLegacyTeamConfig,
  serializeTeamConfigYaml,
  validateTeamConfigDocument,
} from '../../src/team-config/team-config-core.ts'

describe('team-config-core (Flow IR v3)', () => {
  test('round-trips canonical Flow IR v3 YAML cleanly', () => {
    const yaml = [
      'version: 3',
      'flows:',
      '  - id: flow-knowledge',
      '    name: 知识创作',
      '    enabled: true',
      '    when: 读书笔记整理或文章写作',
      '    workspaceMode: in-place',
      '    steps:',
      '      - id: research',
      '        name: 资料梳理',
      '        skills: [how]',
      '        readOnly: true',
      '      - id: draft',
      '        name: 撰写正文',
      '        skills: [knowledge-writing]',
      '      - id: check',
      '        name: 质量自检',
      '        skills: []',
      '        readOnly: true',
      '        onFail: draft',
      '        humanConfirm: true',
    ].join('\n')

    const parsed = parseTeamConfigYaml(yaml, 100)
    expect(parsed.version).toBe(3)
    expect(parsed.flows).toHaveLength(1)
    expect(parsed.flows[0]?.workspaceMode).toBe('in-place')
    expect(parsed.flows[0]?.steps[2]?.onFail).toBe('draft')
    expect(parsed.flows[0]?.steps[2]?.humanConfirm).toBe(true)

    const reparsed = parseTeamConfigYaml(serializeTeamConfigYaml(parsed), 200)
    expect(reparsed.flows[0]?.name).toBe('知识创作')
    expect(reparsed.flows[0]?.steps.map(s => s.id)).toEqual(['research', 'draft', 'check'])
  })

  test('rejects duplicate flow ids, duplicate step ids, and invalid onFail targets', () => {
    expect(() => validateTeamConfigDocument({
      version: 3,
      flows: [
        { id: 'f1', name: 'A', enabled: true, when: 'a', workspaceMode: 'in-place', steps: [{ id: 's1', name: 'S1', skills: [] }], createdAt: 1, updatedAt: 1 },
        { id: 'f1', name: 'B', enabled: true, when: 'b', workspaceMode: 'in-place', steps: [{ id: 's1', name: 'S1', skills: [] }], createdAt: 2, updatedAt: 2 },
      ],
    })).toThrow(/duplicate flow id "f1"/)

    expect(() => validateTeamConfigDocument({
      version: 3,
      flows: [{
        id: 'f1',
        name: 'A',
        enabled: true,
        when: 'a',
        workspaceMode: 'in-place',
        steps: [
          { id: 's1', name: 'S1', skills: [] },
          { id: 's1', name: 'S2', skills: [] },
        ],
        createdAt: 1,
        updatedAt: 1,
      }],
    })).toThrow(/duplicate step id "s1"/)

    expect(() => parseTeamConfigYaml([
      'version: 3',
      'flows:',
      '  - id: f1',
      '    name: Test',
      '    when: anything',
      '    steps:',
      '      - id: s1',
      '        name: Step 1',
      '        onFail: ghost-step',
    ].join('\n'))).toThrow(/unknown onFail target "ghost-step"/)
  })

  test('migrates legacy v1/v2 crew + pipelines + routes + prompts into v3 Flow IR', () => {
    const legacyYaml = [
      'version: 2',
      'crew:',
      '  - id: dev',
      '    name: 开发者',
      '    role: write code with tests',
      '    agentKind: claude-code',
      '    model: claude-sonnet-4-5',
      '  - id: rev',
      '    name: 审查员',
      '    role: review read-only',
      'pipelines:',
      '  - id: p1',
      '    name: 开发流',
      '    prompt:',
      '      sections:',
      '        artifacts: old override',
      '    stages:',
      '      - memberId: dev',
      '        instruction: implement feature',
      '        mode: execute',
      '      - memberId: rev',
      '        instruction: check tests',
      '        mode: review',
      'routes:',
      '  - id: r1',
      '    condition: 编码任务',
      '    pipelineId: p1',
      '    enabled: true',
      'prompts:',
      '  turns:',
      '    executor:',
      '      sections:',
      '        identity: legacy',
    ].join('\n')

    const migrated = parseTeamConfigYaml(legacyYaml, 50)
    expect(migrated.version).toBe(3)
    expect(migrated.flows).toHaveLength(1)
    const flow = migrated.flows[0]!
    expect(flow.name).toBe('开发流')
    expect(flow.enabled).toBe(true)
    expect(flow.when).toBe('编码任务')
    expect(flow.steps[0]?.agent).toEqual({ kind: 'claude-code', model: 'claude-sonnet-4-5' })
    expect(flow.steps[1]?.readOnly).toBe(true)
    expect(flow.steps[1]?.onFail).toBe('step-1')
  })

  test('sanitizeLegacyTeamConfig handles empty docs and orphaned references cleanly', () => {
    expect(emptyTeamConfig()).toEqual({ version: 3, flows: [] })
    const result = sanitizeLegacyTeamConfig({
      crew: [{ id: 'c1', name: 'C1', role: 'role', createdAt: 10 }],
      pipelines: [{
        id: 'p1',
        name: 'P1',
        stages: [
          { memberId: 'c1', instruction: 'keep' },
          { memberId: 'ghost-c', instruction: 'fallback step' },
        ],
        createdAt: 10,
        updatedAt: 10,
      }],
      routes: [
        { id: 'r1', condition: 'ok', pipelineId: 'p1', enabled: true, order: 0 },
        { id: 'r2', condition: 'broken', pipelineId: 'ghost-p', enabled: true, order: 1 },
      ],
    }, 100)
    expect(result.doc.flows).toHaveLength(1)
    expect(result.doc.flows[0]?.steps).toHaveLength(2)
    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
  })
})
