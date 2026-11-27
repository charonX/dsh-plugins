/**
 * Pure declarative YAML schema, parser, serializer, cross-entity validator,
 * and v1/v2 -> v3 Flow IR lossless migration helper for Dsh Manager.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import {
  AGENT_KINDS,
  WORKSPACE_MODES,
  flowDefSchema,
  validateFlows,
  type AgentKind,
  type FlowAgentBinding,
  type FlowDef,
  type FlowStepDef,
} from '../flow/flow-ir.ts'

/** Canonical in-memory and on-disk shape of `team-config.yaml` (Flow IR v3). */
export interface TeamConfigDocument {
  readonly version: 3
  readonly flows: readonly FlowDef[]
}

/** Health and revision snapshot of the team-config hot-reload store. */
export interface TeamConfigStatusView {
  readonly filePath: string
  readonly revision: number
  readonly loadedAt: number
  readonly lastError?: string
  readonly lastErrorAt?: number
}

const yamlStepSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(60),
  skills: z.array(z.string().trim().min(1).max(80)).optional(),
  goal: z.string().trim().max(4000).optional(),
  readOnly: z.boolean().optional(),
  agent: z.object({
    kind: z.enum(AGENT_KINDS).optional(),
    provider: z.string().trim().min(1).max(120).optional(),
    model: z.string().trim().min(1).max(160).optional(),
  }).optional(),
  onFail: z.string().trim().min(1).max(64).optional(),
  humanConfirm: z.boolean().optional(),
})

const yamlFlowSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().optional(),
  when: z.string().trim().min(1).max(2000),
  workspaceMode: z.enum(WORKSPACE_MODES).optional(),
  source: z.object({
    kind: z.enum(['skill', 'file']),
    ref: z.string().trim().min(1).max(512),
    hash: z.string().trim().min(1).max(128),
    compiledAt: z.number().optional(),
  }).optional(),
  steps: z.array(yamlStepSchema).min(1),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

// Legacy v1/v2 schemas accepted transparently for one-way lossless migration.
const legacyCrewSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(4000),
  agentKind: z.enum(AGENT_KINDS).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const legacyStageSchema = z.object({
  memberId: z.string().trim().min(1),
  instruction: z.string().trim().max(4000).optional(),
  skippable: z.boolean().optional(),
  skipLogic: z.string().trim().max(2000).optional(),
  mode: z.enum(['execute', 'review']).optional(),
  prompt: z.unknown().optional(),
})

const legacyPipelineSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(40),
  stages: z.array(legacyStageSchema).optional(),
  prompt: z.unknown().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const legacyRouteSchema = z.object({
  id: z.string().trim().min(1),
  condition: z.string().trim().min(1).max(2000),
  pipelineId: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const yamlRootSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  flows: z.array(yamlFlowSchema).optional(),
  crew: z.array(legacyCrewSchema).optional(),
  pipelines: z.array(legacyPipelineSchema).optional(),
  routes: z.array(legacyRouteSchema).optional(),
  prompts: z.unknown().optional(),
})

/** Empty valid Flow IR configuration. */
export function emptyTeamConfig(): TeamConfigDocument {
  return { version: 3, flows: [] }
}

/** Format Zod issues into a concise single-line diagnostic. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/** Validate document-wide Flow IR invariants. */
export function validateTeamConfigDocument(doc: TeamConfigDocument): TeamConfigDocument {
  validateFlows(doc.flows)
  return doc
}

function migrateLegacyCollectionsToFlows(input: {
  readonly crew: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly agentKind?: AgentKind | undefined
    readonly provider?: string | undefined
    readonly model?: string | undefined
  }[]
  readonly pipelines: readonly {
    readonly id: string
    readonly name: string
    readonly stages?: readonly {
      readonly memberId: string
      readonly instruction?: string | undefined
      readonly mode?: 'execute' | 'review' | undefined
    }[] | undefined
    readonly createdAt?: number | undefined
    readonly updatedAt?: number | undefined
  }[]
  readonly routes: readonly {
    readonly id: string
    readonly condition: string
    readonly pipelineId: string
    readonly enabled?: boolean | undefined
    readonly order?: number | undefined
  }[]
  readonly now: number
}): { readonly flows: readonly FlowDef[]; readonly warnings: readonly string[] } {
  const warnings: string[] = []
  const crewById = new Map(input.crew.map(member => [member.id, member]))
  const routesByPipeline = new Map<string, typeof input.routes[number][]>()
  const pipelineIds = new Set(input.pipelines.map(p => p.id))

  for (const route of [...input.routes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!pipelineIds.has(route.pipelineId)) {
      warnings.push(`dropped route "${route.id}": unknown pipeline "${route.pipelineId}"`)
      continue
    }
    const list = routesByPipeline.get(route.pipelineId) ?? []
    list.push(route)
    routesByPipeline.set(route.pipelineId, list)
  }

  const flows: FlowDef[] = input.pipelines.map((pipeline, pIdx) => {
    const createdAt = pipeline.createdAt ?? input.now + pIdx
    const updatedAt = pipeline.updatedAt ?? createdAt
    const matchedRoutes = routesByPipeline.get(pipeline.id) ?? []
    const enabledRoutes = matchedRoutes.filter(r => r.enabled !== false)
    const when = enabledRoutes.length > 0
      ? enabledRoutes.map(r => r.condition).join('；')
      : (matchedRoutes.length > 0 ? matchedRoutes.map(r => r.condition).join('；') : pipeline.name)
    const enabled = enabledRoutes.length > 0

    const rawStages = pipeline.stages ?? []
    const steps: FlowStepDef[] = []
    let lastWritableStepId: string | undefined

    for (let sIdx = 0; sIdx < rawStages.length; sIdx += 1) {
      const stage = rawStages[sIdx]!
      const member = crewById.get(stage.memberId)
      if (member === undefined) {
        warnings.push(`migrated stage ${sIdx + 1} of pipeline "${pipeline.id}" without missing member "${stage.memberId}"`)
      }
      const stepId = `step-${sIdx + 1}`
      const isReview = stage.mode === 'review'
      const goalParts = [member?.role?.trim(), stage.instruction?.trim()].filter((v): v is string => v !== undefined && v !== '')
      const agent: FlowAgentBinding | undefined = (
        (member?.agentKind !== undefined && member.agentKind !== 'builtin')
        || member?.provider !== undefined
        || member?.model !== undefined
      )
        ? {
            kind: member?.agentKind ?? 'builtin',
            ...(member?.provider === undefined ? {} : { provider: member.provider }),
            ...(member?.model === undefined ? {} : { model: member.model }),
          }
        : undefined
      const step: FlowStepDef = {
        id: stepId,
        name: member?.name ?? `Step ${sIdx + 1}`,
        skills: [],
        ...(goalParts.length > 0 ? { goal: goalParts.join('\n') } : {}),
        ...(isReview ? { readOnly: true, onFail: lastWritableStepId ?? 'self' } : {}),
        ...(agent === undefined ? {} : { agent }),
      }
      if (!isReview) {
        lastWritableStepId = stepId
      }
      steps.push(step)
    }

    if (steps.length === 0) {
      steps.push({
        id: 'step-1',
        name: pipeline.name,
        skills: [],
        goal: pipeline.name,
      })
    }

    return flowDefSchema.parse({
      id: pipeline.id,
      name: pipeline.name,
      enabled,
      when,
      workspaceMode: 'auto',
      steps,
      createdAt,
      updatedAt,
    })
  })

  return { flows, warnings }
}

/**
 * Parse and validate `team-config.yaml` into canonical v3 Flow IR.
 * Automatically migrates legacy v1/v2 (`crew`, `pipelines`, `routes`, `prompts`)
 * documents into `flows[]`.
 */
export function parseTeamConfigYaml(yamlText: string, now = Date.now()): TeamConfigDocument {
  let raw: unknown
  try {
    raw = parseYaml(yamlText)
  } catch (error) {
    throw new Error(`invalid YAML syntax: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || raw === undefined) {
    return emptyTeamConfig()
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('team-config.yaml root must be a YAML mapping/object')
  }
  const parsed = yamlRootSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`invalid team-config schema: ${formatZodError(parsed.error)}`)
  }
  const data = parsed.data

  if (data.flows !== undefined) {
    const flows: FlowDef[] = data.flows.map((flow, fIdx) => {
      const createdAt = flow.createdAt ?? now + fIdx
      const updatedAt = flow.updatedAt ?? createdAt
      const steps: FlowStepDef[] = flow.steps.map((step, sIdx) => ({
        id: step.id ?? `step-${sIdx + 1}`,
        name: step.name,
        skills: step.skills ?? [],
        ...(step.goal === undefined || step.goal === '' ? {} : { goal: step.goal }),
        ...(step.readOnly === true ? { readOnly: true } : {}),
        ...(step.agent === undefined ? {} : {
          agent: {
            kind: step.agent.kind ?? 'builtin',
            ...(step.agent.provider === undefined ? {} : { provider: step.agent.provider }),
            ...(step.agent.model === undefined ? {} : { model: step.agent.model }),
          },
        }),
        ...(step.onFail === undefined ? {} : { onFail: step.onFail }),
        ...(step.humanConfirm === true ? { humanConfirm: true } : {}),
      }))
      return flowDefSchema.parse({
        id: flow.id,
        name: flow.name,
        enabled: flow.enabled ?? true,
        when: flow.when,
        workspaceMode: flow.workspaceMode ?? 'in-place',
        ...(flow.source === undefined ? {} : { source: flow.source }),
        steps,
        createdAt,
        updatedAt,
      })
    })
    return validateTeamConfigDocument({ version: 3, flows })
  }

  // Legacy v1/v2 migration path.
  const migrated = migrateLegacyCollectionsToFlows({
    crew: data.crew ?? [],
    pipelines: data.pipelines ?? [],
    routes: data.routes ?? [],
    now,
  })
  return validateTeamConfigDocument({ version: 3, flows: migrated.flows })
}

/** Serialize canonical v3 Flow IR to clean, human-editable YAML. */
export function serializeTeamConfigYaml(doc: TeamConfigDocument): string {
  const plain = {
    version: 3,
    flows: doc.flows.map(flow => ({
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled,
      when: flow.when,
      workspaceMode: flow.workspaceMode,
      ...(flow.source === undefined ? {} : { source: flow.source }),
      steps: flow.steps.map(step => ({
        id: step.id,
        name: step.name,
        skills: [...step.skills],
        ...(step.goal === undefined ? {} : { goal: step.goal }),
        ...(step.readOnly === true ? { readOnly: true } : {}),
        ...(step.agent === undefined ? {} : { agent: step.agent }),
        ...(step.onFail === undefined ? {} : { onFail: step.onFail }),
        ...(step.humanConfirm === true ? { humanConfirm: true } : {}),
      })),
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    })),
  }
  const header = [
    '# Dsh Manager 通用流程配置（Flow IR v3，支持热更新：修改保存后自动校验生效）',
    '# 字段说明：flows[].when（触发条件）、workspaceMode（in-place | worktree | auto）、steps[].{skills, goal, readOnly, agent, onFail, humanConfirm}',
    '',
  ].join('\n')
  const body = stringifyYaml(plain, { lineWidth: 100 })
  return `${header}${body.endsWith('\n') ? body : `${body}\n`}`
}

/** Migrate legacy storage-domain records into canonical Flow IR during first-boot upgrade. */
export function sanitizeLegacyTeamConfig(input: {
  readonly crew: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly agentKind?: AgentKind | undefined
    readonly provider?: string | undefined
    readonly model?: string | undefined
    readonly createdAt: number
  }[]
  readonly pipelines: readonly {
    readonly id: string
    readonly name: string
    readonly stages: readonly {
      readonly memberId: string
      readonly instruction?: string | undefined
      readonly mode?: 'execute' | 'review' | undefined
    }[]
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly routes: readonly {
    readonly id: string
    readonly condition: string
    readonly pipelineId: string
    readonly enabled: boolean
    readonly order: number
  }[]
}, now = Date.now()): { readonly doc: TeamConfigDocument; readonly warnings: readonly string[] } {
  const migrated = migrateLegacyCollectionsToFlows({
    crew: [...input.crew].sort((a, b) => a.createdAt - b.createdAt),
    pipelines: [...input.pipelines].sort((a, b) => a.createdAt - b.createdAt),
    routes: input.routes,
    now,
  })
  return {
    doc: validateTeamConfigDocument({ version: 3, flows: migrated.flows }),
    warnings: migrated.warnings,
  }
}
