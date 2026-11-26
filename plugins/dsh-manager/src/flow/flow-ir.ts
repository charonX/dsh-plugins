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

/** Workflow Playbook / preset identifier (e.g. `code-dev`, `bug-fix`, `knowledge-creation`, `refactoring`, or any workspace `*.md`). */
export type PresetId = string

/** Discovered Playbook metadata exported to client & steward without filesystem paths leaking into client code. */
export interface DiscoveredPlaybook {
  readonly id: string
  readonly name: string
  readonly when: string
  readonly workspaceMode: WorkspaceMode
  readonly source: 'workspace' | 'builtin'
  readonly ref: string
  readonly path: string
  readonly hash: string
}

export const flowPresetApplyInputSchema = z.object({
  presetId: z.string().trim().min(1).max(80),
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

function uniqueFlowName(baseName: string, existingNames: ReadonlySet<string>): string {
  if (!existingNames.has(baseName)) return baseName
  let idx = 2
  while (existingNames.has(`${baseName} (${idx})`)) {
    idx += 1
  }
  return `${baseName} (${idx})`
}

/** Materialize an independent editable `FlowDef` copy from a compiled Playbook flow. */
export function materializeCompiledPlaybook(
  existingFlows: readonly FlowDef[],
  compiled: FlowDef,
  now = Date.now(),
  idFactory: (prefix: string) => string = prefix => `${prefix}-${crypto.randomUUID()}`,
): FlowDef {
  const existingNames = new Set(existingFlows.map(flow => flow.name))
  return flowDefSchema.parse({
    ...compiled,
    id: idFactory('flow'),
    name: uniqueFlowName(compiled.name, existingNames),
    enabled: true,
    steps: compiled.steps.map(step => ({ ...step, skills: [...step.skills] })),
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
