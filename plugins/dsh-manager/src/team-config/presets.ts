/**
 * Built-in read-only pipeline presets (Requirement Implementation, Bug Fix,
 * Read-only Analysis). All preset instructions use template variables
 * (`{{project.*}}`, `{{env.*}}`) with zero repository-specific assumptions.
 * Copying a preset materializes an independent editable pipeline and reuses
 * matching crew members by `(agentKind, role)` or creates missing ones.
 */
import type { AgentKind, CrewMember } from '../crew/crew-core.ts'
import type { PipelineRecord, PipelineStage } from '../pipeline/pipeline-core.ts'
import type { TeamConfigDocument } from './team-config-core.ts'

export const PRESET_IDS = ['requirement-impl', 'bug-fix', 'readonly-analysis'] as const
export type PresetId = (typeof PRESET_IDS)[number]

export interface PresetStageBlueprint {
  readonly memberName: string
  readonly agentKind: AgentKind
  readonly role: string
  readonly instruction: string
  readonly skippable: boolean
  readonly skipLogic?: string
  readonly mode: 'execute' | 'review'
}

export interface PipelinePresetDef {
  readonly id: PresetId
  readonly name: string
  readonly summary: string
  readonly stages: readonly PresetStageBlueprint[]
}

export const PIPELINE_PRESETS: readonly PipelinePresetDef[] = [
  {
    id: 'requirement-impl',
    name: '需求实现',
    summary: '分析对齐 → 实现 → 审查（review 模式）',
    stages: [
      {
        memberName: '需求分析员',
        agentKind: 'builtin',
        role: 'Analyze requirements, explore codebase boundaries under {{project.root}}, and draft a scoped plan in {{env.scratchDir}}/design.md.\n{{project.agentsMd}}',
        instruction: 'Converge scope boundaries, module seams, and behavior-level acceptance cases in {{env.scratchDir}}/design.md.',
        skippable: true,
        skipLogic: 'Skip when ticket already carries agreed acceptanceCriteria and handoffSessionId.',
        mode: 'execute',
      },
      {
        memberName: '切片开发员',
        agentKind: 'builtin',
        role: 'Implement vertical slices with TDD inside {{env.worktreePath}} following the project instructions and git-flow rules.\n{{project.agentsMd}}\n{{project.gitFlow}}',
        instruction: 'Write failing behavior tests first, implement minimal changes, and save verification logs to {{env.scratchDir}}/test-report.log.',
        skippable: false,
        mode: 'execute',
      },
      {
        memberName: '独立审查员',
        agentKind: 'builtin',
        role: 'Run read-only dual-axis Spec & Standards review against {{project.root}} and record findings in {{env.scratchDir}}/review-report.md.\n{{project.verifyDocs}}',
        instruction: 'Perform read-only review and run required verification gates for {{project.root}}; record findings in {{env.scratchDir}}/review-report.md.\n{{project.verifyDocs}}',
        skippable: false,
        mode: 'review',
      },
    ],
  },
  {
    id: 'bug-fix',
    name: '缺陷修复',
    summary: '复现 → 定位修复 → 验证（review 模式）',
    stages: [
      {
        memberName: '缺陷复现员',
        agentKind: 'builtin',
        role: 'Reproduce the defect on the real surface and write failing reproduction evidence to {{env.scratchDir}}/repro-red.log.',
        instruction: 'Reproduce the issue on the target surface, inspect test blind spots, and record failing output in {{env.scratchDir}}/repro-red.log.',
        skippable: false,
        mode: 'execute',
      },
      {
        memberName: '根因修复员',
        agentKind: 'builtin',
        role: 'Locate root cause in {{env.worktreePath}}, add behavior-level regression tests, and implement minimal fix.',
        instruction: 'Add a behavior/E2E regression test, apply minimal root-cause fix in {{env.worktreePath}}, and save green output to {{env.scratchDir}}/test-report.log.\n{{project.agentsMd}}',
        skippable: false,
        mode: 'execute',
      },
      {
        memberName: '回归验证员',
        agentKind: 'builtin',
        role: 'Run read-only verification for {{project.root}} and save output to {{env.scratchDir}}/test-report.log.\n{{project.verifyDocs}}',
        instruction: 'Verify the fix end-to-end against {{project.root}} without editing tracked files and record review status in {{env.scratchDir}}/review-report.md.\n{{project.verifyDocs}}',
        skippable: false,
        mode: 'review',
      },
    ],
  },
  {
    id: 'readonly-analysis',
    name: '只读分析',
    summary: '调研 → 结论报告',
    stages: [
      {
        memberName: '只读调研员',
        agentKind: 'builtin',
        role: 'Read-only codebase and docs exploration under {{project.root}} without modifying tracked files.\n{{project.agentsMd}}',
        instruction: 'Trace runtime flow, ownership boundaries, and relevant constraints across {{project.root}} without editing repository files.',
        skippable: false,
        mode: 'review',
      },
      {
        memberName: '报告撰写员',
        agentKind: 'builtin',
        role: 'Synthesize verified findings and recommendations into {{env.scratchDir}}/analysis-report.md.',
        instruction: 'Write an evidence-backed analysis report to {{env.scratchDir}}/analysis-report.md citing exact file paths and symbols.',
        skippable: false,
        mode: 'review',
      },
    ],
  },
]

export function getPresetById(presetId: string): PipelinePresetDef | undefined {
  return PIPELINE_PRESETS.find(p => p.id === presetId)
}

function uniquePipelineName(baseName: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(baseName)) return baseName
  let idx = 2
  while (existingNames.has(`${baseName} (${idx})`)) {
    idx += 1
  }
  return `${baseName} (${idx})`
}

/**
 * Materialize an independent copy of `presetId` onto `doc`:
 * - Reuses existing crew members matching `(agentKind, role)`
 * - Creates missing crew members with auto-generated IDs
 * - Appends a new editable pipeline disconnected from the read-only preset
 */
export function applyPresetToTeamConfig(
  doc: TeamConfigDocument,
  presetId: PresetId,
  now = Date.now(),
  idFactory: (prefix: string) => string = prefix => `${prefix}-${crypto.randomUUID()}`,
): {
  readonly nextDoc: TeamConfigDocument
  readonly pipeline: PipelineRecord
  readonly createdMembers: readonly CrewMember[]
} {
  const preset = getPresetById(presetId)
  if (preset === undefined) {
    throw new Error(`unknown preset "${presetId}"`)
  }

  const crewPool: CrewMember[] = [...doc.crew]
  const createdMembers: CrewMember[] = []
  const stages: PipelineStage[] = []

  for (const stageDef of preset.stages) {
    const existing = crewPool.find(m =>
      (m.agentKind ?? 'builtin') === stageDef.agentKind && m.role === stageDef.role)
    let memberId: string
    if (existing !== undefined) {
      memberId = existing.id
    } else {
      const created: CrewMember = {
        id: idFactory('crew'),
        name: stageDef.memberName,
        role: stageDef.role,
        ...(stageDef.agentKind === 'builtin' ? {} : { agentKind: stageDef.agentKind }),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }
      crewPool.push(created)
      createdMembers.push(created)
      memberId = created.id
    }
    stages.push({
      memberId,
      instruction: stageDef.instruction,
      skippable: stageDef.skippable,
      ...(stageDef.skipLogic === undefined ? {} : { skipLogic: stageDef.skipLogic }),
      mode: stageDef.mode,
    })
  }

  const existingPipelineNames = new Set(doc.pipelines.map(p => p.name))
  const pipeline: PipelineRecord = {
    id: idFactory('pipe'),
    name: uniquePipelineName(preset.name, existingPipelineNames),
    stages,
    createdAt: now,
    updatedAt: now,
  }

  return {
    nextDoc: {
      ...doc,
      crew: crewPool,
      pipelines: [...doc.pipelines, pipeline],
    },
    pipeline,
    createdMembers,
  }
}
