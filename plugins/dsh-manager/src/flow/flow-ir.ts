/**
 * Canonical minimal Flow Intermediate Representation (Flow IR) for Dsh Manager:
 * - Domain-agnostic: supports coding (`worktree`), knowledge creation (`in-place`),
 *   research, or ops triage without hardcoded repository assumptions.
 * - Skill-driven: each step mounts `skills[]` (carrying methodology/checklists)
 *   plus an optional 1-line `goal`, optional `readOnly`, optional `agent`,
 *   optional `onFail` rework target, and optional `humanConfirm` gate.
 */
import { z } from 'zod'

/** One discovered skill manifest across workspace roots and host providers. */
export interface DiscoveredSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source?: 'workspace' | 'host'
}

/** Supported execution backends: built-in DSH session or external headless CLIs. */
export const AGENT_KINDS = ['builtin', 'claude-code', 'codex', 'agy', 'cursor', 'pi'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/** Workspace isolation policy per flow (`in-place` is safe default for non-git / knowledge work). */
export const WORKSPACE_MODES = ['auto', 'in-place', 'worktree'] as const
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

/** Provenance of a flow compiled once from a Playbook Skill or Markdown file. */
export const flowSourceRefSchema = z.object({
  kind: z.enum(['skill', 'file']),
  ref: z.string().trim().min(1).max(512),
  hash: z.string().trim().min(1).max(128),
  compiledAt: z.number().int().min(0).default(0),
})

export type FlowSourceRef = z.infer<typeof flowSourceRefSchema>

/** Optional per-step executor/model override; omitted steps inherit the bundle default. */
export const flowAgentBindingSchema = z.object({
  kind: z.enum(AGENT_KINDS).default('builtin'),
  provider: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(160).optional(),
})

export type FlowAgentBinding = z.infer<typeof flowAgentBindingSchema>

/** One step in a Flow IR chain. */
export const flowStepDefSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  skills: z.array(z.string().trim().min(1).max(80)).default([]),
  goal: z.string().trim().max(4000).optional(),
  readOnly: z.boolean().optional(),
  agent: flowAgentBindingSchema.optional(),
  onFail: z.string().trim().min(1).max(64).optional(),
  humanConfirm: z.boolean().optional(),
})

export type FlowStepDef = z.infer<typeof flowStepDefSchema>

/** One complete Flow definition (self-contained: includes trigger `when` and `steps[]`). */
export const flowDefSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  when: z.string().trim().min(1).max(2000),
  workspaceMode: z.enum(WORKSPACE_MODES).default('in-place'),
  source: flowSourceRefSchema.optional(),
  steps: z.array(flowStepDefSchema).min(1),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

export type FlowDef = z.infer<typeof flowDefSchema>

/** Validate cross-flow and intra-flow invariants (unique IDs, valid `onFail` target). */
export function validateFlows(flows: readonly FlowDef[]): readonly FlowDef[] {
  const flowIds = new Set<string>()
  for (const flow of flows) {
    if (flowIds.has(flow.id)) {
      throw new Error(`duplicate flow id "${flow.id}"`)
    }
    flowIds.add(flow.id)
    if (flow.steps.length === 0) {
      throw new Error(`flow "${flow.id}" must contain at least one step`)
    }
    const stepIds = new Set<string>()
    for (const step of flow.steps) {
      if (stepIds.has(step.id)) {
        throw new Error(`flow "${flow.id}" has duplicate step id "${step.id}"`)
      }
      stepIds.add(step.id)
    }
    for (const step of flow.steps) {
      if (step.onFail !== undefined && step.onFail !== 'self' && !stepIds.has(step.onFail)) {
        throw new Error(`flow "${flow.id}" step "${step.id}" references unknown onFail target "${step.onFail}"`)
      }
    }
  }
  return flows
}

/** One slash command advertised by an external agent CLI. */
export interface AgentSlashCommand {
  readonly name: string
  readonly description?: string
  readonly argumentHint?: string
}

/** Runtime probe result for one selectable execution backend. */
export interface AgentKindOption {
  readonly kind: AgentKind
  readonly command: string
  readonly available: boolean
  readonly executablePath?: string
  readonly version?: string
  readonly reason?: string
  readonly slashCommands?: readonly AgentSlashCommand[]
}

/** Selectable models per registered provider. */
export interface ModelProviderOptions {
  readonly provider: string
  readonly providerName: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

export const flowIdSchema = z.object({
  flowId: z.string().trim().min(1),
})
export type FlowIdInput = z.infer<typeof flowIdSchema>

export const flowStepInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(60),
  skills: z.array(z.string().trim().min(1).max(80)).default([]),
  goal: z.string().trim().max(4000).optional(),
  readOnly: z.boolean().optional(),
  agent: flowAgentBindingSchema.nullable().optional(),
  onFail: z.string().trim().min(1).max(64).nullable().optional(),
  humanConfirm: z.boolean().optional(),
})
export type FlowStepInput = z.infer<typeof flowStepInputSchema>

export const flowInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().optional(),
  when: z.string().trim().min(1).max(2000),
  workspaceMode: z.enum(WORKSPACE_MODES).optional(),
  steps: z.array(flowStepInputSchema).min(1),
})
export type FlowInput = z.infer<typeof flowInputSchema>

export const flowUpdateInputSchema = z.object({
  flowId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  when: z.string().trim().min(1).max(2000).optional(),
  workspaceMode: z.enum(WORKSPACE_MODES).optional(),
  steps: z.array(flowStepInputSchema).min(1).optional(),
})
export type FlowUpdateInput = z.infer<typeof flowUpdateInputSchema>

export const PRESET_IDS = ['code-dev', 'bug-fix', 'knowledge-creation'] as const
export type PresetId = (typeof PRESET_IDS)[number]

export interface FlowPresetDef {
  readonly id: PresetId
  readonly name: string
  readonly summary: string
  readonly when: string
  readonly workspaceMode: WorkspaceMode
  readonly steps: readonly FlowStepDef[]
}

/** Built-in domain-agnostic starter presets (coding + knowledge creation). */
export const FLOW_PRESETS: readonly FlowPresetDef[] = [
  {
    id: 'code-dev',
    name: '通用代码开发',
    summary: '梳理边界 → TDD 实现 → 只读审查(失败打回) → 交付确认',
    when: '新功能开发、模块重构、架构调整或代码改造任务',
    workspaceMode: 'worktree',
    steps: [
      {
        id: 'align',
        name: '边界梳理',
        skills: ['how', 'align'],
        goal: '理清模块边界、接缝与行为级验收标准',
        readOnly: true,
      },
      {
        id: 'implement',
        name: '实现与测试',
        skills: ['tdd', 'verify'],
        goal: '先写行为测试再最小实现，并实跑验证通过',
      },
      {
        id: 'review',
        name: '只读审查',
        skills: ['code-review', 'verify'],
        goal: '只读核验 Spec/Standards 与门禁实跑结果',
        readOnly: true,
        onFail: 'implement',
      },
      {
        id: 'deliver',
        name: '交付收口',
        skills: ['ship-pr'],
        goal: '按目标仓库规范整理提交与交付说明',
        humanConfirm: true,
      },
    ],
  },
  {
    id: 'bug-fix',
    name: '通用缺陷修复',
    summary: '真实复现 → 根因修复 → 独立回归验证(失败打回)',
    when: '线上故障、异常报错、功能回归或测试失败问题修复',
    workspaceMode: 'worktree',
    steps: [
      {
        id: 'repro',
        name: '真实表面复现',
        skills: ['bug-fix', 'verify'],
        goal: '在真实表面稳定复现缺陷并核查测试盲区',
        readOnly: true,
      },
      {
        id: 'fix',
        name: '根因修复',
        skills: ['bug-fix', 'tdd'],
        goal: '先补红灯回归测试，再实施最小根因修复',
      },
      {
        id: 'verify',
        name: '独立回归验证',
        skills: ['code-review', 'verify'],
        goal: '只读复测确认原问题已解决且无阻塞回归',
        readOnly: true,
        onFail: 'fix',
      },
    ],
  },
  {
    id: 'knowledge-creation',
    name: '知识创作与内容生产',
    summary: '资料梳理 → 撰写正文 → 质量与规范自检(失败打回)',
    when: '知识库笔记整理、主题调研综述、文章或内容草稿创作',
    workspaceMode: 'in-place',
    steps: [
      {
        id: 'research',
        name: '资料梳理与立意',
        skills: ['how'],
        goal: '检索既有笔记与相关资料，梳理结构化大纲与核心论点',
        readOnly: true,
      },
      {
        id: 'draft',
        name: '撰写正文',
        skills: [],
        goal: '遵循目录与行文规范撰写正文、补充元数据与关联链接',
      },
      {
        id: 'check',
        name: '质量与规范自检',
        skills: [],
        goal: '核查事实准确性、结构清晰度与知识库写作禁忌',
        readOnly: true,
        onFail: 'draft',
      },
    ],
  },
]

export const flowPresetApplyInputSchema = z.object({
  presetId: z.enum(PRESET_IDS),
})
export type FlowPresetApplyInput = z.infer<typeof flowPresetApplyInputSchema>

export const flowImportPlaybookInputSchema = z.object({
  kind: z.enum(['skill', 'file', 'markdown']),
  ref: z.string().trim().min(1).max(512),
  content: z.string().max(100_000).optional(),
  cwd: z.string().trim().min(1).optional(),
  useLlm: z.boolean().optional(),
})
export type FlowImportPlaybookInput = z.infer<typeof flowImportPlaybookInputSchema>

export const flowSyncPlaybookInputSchema = z.object({
  flowId: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  useLlm: z.boolean().optional(),
})
export type FlowSyncPlaybookInput = z.infer<typeof flowSyncPlaybookInputSchema>

export function getFlowPreset(presetId: string): FlowPresetDef | undefined {
  return FLOW_PRESETS.find(preset => preset.id === presetId)
}

function uniqueFlowName(baseName: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(baseName)) return baseName
  let idx = 2
  while (existingNames.has(`${baseName} (${idx})`)) {
    idx += 1
  }
  return `${baseName} (${idx})`
}

/** Materialize one read-only preset onto `flows[]` as an independent editable flow. */
export function materializeFlowPreset(
  existingFlows: readonly FlowDef[],
  presetId: PresetId,
  now = Date.now(),
  idFactory: (prefix: string) => string = prefix => `${prefix}-${crypto.randomUUID()}`,
): FlowDef {
  const preset = getFlowPreset(presetId)
  if (preset === undefined) {
    throw new Error(`unknown preset "${presetId}"`)
  }
  const existingNames = new Set(existingFlows.map(flow => flow.name))
  return flowDefSchema.parse({
    id: idFactory('flow'),
    name: uniqueFlowName(preset.name, existingNames),
    enabled: true,
    when: preset.when,
    workspaceMode: preset.workspaceMode,
    steps: preset.steps.map(step => ({ ...step, skills: [...step.skills] })),
    createdAt: now,
    updatedAt: now,
  })
}

/** Normalize user step inputs into valid unique-ID `FlowStepDef[]`. */
export function normalizeStepInputs(rawSteps: readonly FlowStepInput[]): readonly FlowStepDef[] {
  const usedIds = new Set<string>()
  return rawSteps.map((step, index) => {
    let candidate = (step.id ?? `step-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (candidate === '') candidate = `step-${index + 1}`
    let finalId = candidate
    let suffix = 2
    while (usedIds.has(finalId)) {
      finalId = `${candidate}-${suffix}`
      suffix += 1
    }
    usedIds.add(finalId)
    return flowStepDefSchema.parse({
      id: finalId,
      name: step.name,
      skills: [...new Set(step.skills.map(s => s.trim()).filter(Boolean))],
      ...(step.goal !== undefined && step.goal !== '' ? { goal: step.goal } : {}),
      ...(step.readOnly === true ? { readOnly: true } : {}),
      ...(step.agent !== undefined && step.agent !== null ? { agent: step.agent } : {}),
      ...(step.onFail !== undefined && step.onFail !== null && step.onFail !== '' ? { onFail: step.onFail } : {}),
      ...(step.humanConfirm === true ? { humanConfirm: true } : {}),
    })
  })
}
