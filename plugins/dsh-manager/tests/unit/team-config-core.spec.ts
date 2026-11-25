import { describe, expect, test } from 'vitest'
import {
  emptyTeamConfig,
  parseTeamConfigYaml,
  sanitizeLegacyTeamConfig,
  serializeTeamConfigYaml,
  validateTeamConfigDocument,
} from '../../src/team-config/team-config-core.ts'

describe('team-config-core', () => {
  test('parses minimal YAML with human-friendly defaults and round-trips cleanly', () => {
    const yaml = [
      'version: 1',
      'crew:',
      '  - id: dev-li',
      '    name: Dev Li',
      '    role: implement vertical slices with TDD',
      '    agentKind: claude-code',
      'pipelines:',
      '  - id: feature-flow',
      '    name: Feature Flow',
      '    stages:',
      '      - memberId: dev-li',
      '        instruction: write failing test first',
      '        skippable: true',
      '        skipLogic: skip on pure doc updates',
      '        mode: execute',
      'routes:',
      '  - id: feature-route',
      '    condition: any new feature work',
      '    pipelineId: feature-flow',
    ].join('\n')

    const parsed = parseTeamConfigYaml(yaml, 1_000)
    expect(parsed.crew).toHaveLength(1)
    expect(parsed.crew[0]).toMatchObject({
      id: 'dev-li',
      name: 'Dev Li',
      agentKind: 'claude-code',
      enabled: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    expect(parsed.pipelines[0]?.stages[0]).toEqual({
      memberId: 'dev-li',
      instruction: 'write failing test first',
      skippable: true,
      skipLogic: 'skip on pure doc updates',
      mode: 'execute',
    })
    expect(parsed.routes[0]).toMatchObject({
      id: 'feature-route',
      pipelineId: 'feature-flow',
      enabled: true,
      order: 0,
    })

    const reparsed = parseTeamConfigYaml(serializeTeamConfigYaml(parsed), 2_000)
    expect(reparsed).toEqual(parsed)
  })

  test('empty or whitespace YAML yields an empty valid config', () => {
    expect(parseTeamConfigYaml('')).toEqual(emptyTeamConfig())
    expect(parseTeamConfigYaml('# comment only\n')).toEqual(emptyTeamConfig())
  })

  test('rejects broken syntax, duplicate IDs, unknown memberId, and unknown pipelineId', () => {
    expect(() => parseTeamConfigYaml('crew: [unclosed')).toThrow(/invalid YAML syntax/i)
    expect(() => parseTeamConfigYaml('- list-root')).toThrow(/mapping\/object/i)
    expect(() => parseTeamConfigYaml([
      'crew:',
      '  - id: same',
      '    name: A',
      '    role: first',
      '  - id: same',
      '    name: B',
      '    role: second',
    ].join('\n'))).toThrow(/duplicate crew id "same"/)

    expect(() => parseTeamConfigYaml([
      'crew:',
      '  - id: a',
      '    name: A',
      '    role: role A',
      'pipelines:',
      '  - id: p1',
      '    name: P1',
      '    stages:',
      '      - memberId: missing-member',
    ].join('\n'))).toThrow(/unknown crew member "missing-member"/)

    expect(() => parseTeamConfigYaml([
      'routes:',
      '  - id: r1',
      '    condition: match all',
      '    pipelineId: missing-pipe',
    ].join('\n'))).toThrow(/unknown pipeline "missing-pipe"/)
  })

  test('validateTeamConfigDocument rejects duplicate pipeline and route IDs', () => {
    expect(() => validateTeamConfigDocument({
      version: 1,
      crew: [{ id: 'c1', name: 'C1', role: 'r', enabled: true, createdAt: 1, updatedAt: 1 }],
      pipelines: [
        { id: 'p1', name: 'P1', stages: [{ memberId: 'c1', instruction: '', skippable: false }], createdAt: 1, updatedAt: 1 },
        { id: 'p1', name: 'P2', stages: [{ memberId: 'c1', instruction: '', skippable: false }], createdAt: 2, updatedAt: 2 },
      ],
      routes: [],
    })).toThrow(/duplicate pipeline id "p1"/)

    expect(() => validateTeamConfigDocument({
      version: 1,
      crew: [{ id: 'c1', name: 'C1', role: 'r', enabled: true, createdAt: 1, updatedAt: 1 }],
      pipelines: [
        { id: 'p1', name: 'P1', stages: [{ memberId: 'c1', instruction: '', skippable: false }], createdAt: 1, updatedAt: 1 },
      ],
      routes: [
        { id: 'r1', condition: 'c1', pipelineId: 'p1', enabled: true, order: 0, createdAt: 1, updatedAt: 1 },
        { id: 'r1', condition: 'c2', pipelineId: 'p1', enabled: true, order: 1, createdAt: 2, updatedAt: 2 },
      ],
    })).toThrow(/duplicate route id "r1"/)
  })

  test('sanitizeLegacyTeamConfig drops orphaned legacy references with warnings', () => {
    const result = sanitizeLegacyTeamConfig({
      crew: [{ id: 'c1', name: 'C1', role: 'role', enabled: true, createdAt: 10, updatedAt: 10 }],
      pipelines: [
        {
          id: 'p1',
          name: 'P1',
          stages: [
            { memberId: 'c1', instruction: 'keep', skippable: false },
            { memberId: 'ghost-c', instruction: 'drop', skippable: false },
          ],
          createdAt: 10,
          updatedAt: 10,
        },
      ],
      routes: [
        { id: 'r1', condition: 'ok', pipelineId: 'p1', enabled: true, order: 0, createdAt: 10, updatedAt: 10 },
        { id: 'r2', condition: 'broken', pipelineId: 'ghost-p', enabled: true, order: 1, createdAt: 11, updatedAt: 11 },
      ],
    })
    expect(result.doc.pipelines[0]?.stages).toHaveLength(1)
    expect(result.doc.routes).toHaveLength(1)
    expect(result.warnings).toHaveLength(2)
  })
})
