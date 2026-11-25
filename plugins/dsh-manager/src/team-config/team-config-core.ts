/**
 * Pure declarative YAML schema, parser, serializer, cross-entity validator,
 * and legacy storage-domain migration helper for Dsh Manager team & flow
 * configuration (Crew, Pipelines, Route Rules).
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { AGENT_KINDS, crewMember, type CrewMember } from '../crew/crew-core.ts'
import { pipelineRecord, STAGE_MODES, type PipelineRecord, type PipelineStage } from '../pipeline/pipeline-core.ts'
import { routeRule, type RouteRule } from '../route/route-core.ts'

/** Canonical in-memory and on-disk shape of `team-config.yaml`. */
export interface TeamConfigDocument {
  readonly version: 1
  readonly crew: readonly CrewMember[]
  readonly pipelines: readonly PipelineRecord[]
  readonly routes: readonly RouteRule[]
}

/** Health and revision snapshot of the team-config hot-reload store. */
export interface TeamConfigStatusView {
  readonly filePath: string
  readonly revision: number
  readonly loadedAt: number
  readonly lastError?: string
  readonly lastErrorAt?: number
}

const yamlCrewSchema = z.object({
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

const yamlStageSchema = z.object({
  memberId: z.string().trim().min(1),
  instruction: z.string().trim().max(4000).optional(),
  skippable: z.boolean().optional(),
  skipLogic: z.string().trim().max(2000).optional(),
  mode: z.enum(STAGE_MODES).optional(),
})

const yamlPipelineSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(40),
  stages: z.array(yamlStageSchema).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const yamlRouteSchema = z.object({
  id: z.string().trim().min(1),
  condition: z.string().trim().min(1).max(2000),
  pipelineId: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

const yamlRootSchema = z.object({
  version: z.literal(1).optional(),
  crew: z.array(yamlCrewSchema).optional(),
  pipelines: z.array(yamlPipelineSchema).optional(),
  routes: z.array(yamlRouteSchema).optional(),
})

/** Empty valid team configuration. */
export function emptyTeamConfig(): TeamConfigDocument {
  return { version: 1, crew: [], pipelines: [], routes: [] }
}

/** Format Zod issues into a concise single-line human/agent-readable diagnostic. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Validate cross-entity invariants (unique IDs within each collection and
 * referential integrity across stages -> crew and routes -> pipelines).
 * Throws an Error with an actionable diagnostic on violation.
 */
export function validateTeamConfigDocument(doc: TeamConfigDocument): TeamConfigDocument {
  const crewIds = new Set<string>()
  for (const member of doc.crew) {
    if (crewIds.has(member.id)) {
      throw new Error(`duplicate crew id "${member.id}"`)
    }
    crewIds.add(member.id)
  }

  const pipelineIds = new Set<string>()
  for (const pipeline of doc.pipelines) {
    if (pipelineIds.has(pipeline.id)) {
      throw new Error(`duplicate pipeline id "${pipeline.id}"`)
    }
    pipelineIds.add(pipeline.id)
    for (let index = 0; index < pipeline.stages.length; index += 1) {
      const stage = pipeline.stages[index]!
      if (!crewIds.has(stage.memberId)) {
        throw new Error(`pipeline "${pipeline.id}" stage ${index + 1} references unknown crew member "${stage.memberId}"`)
      }
    }
  }

  const routeIds = new Set<string>()
  for (const rule of doc.routes) {
    if (routeIds.has(rule.id)) {
      throw new Error(`duplicate route id "${rule.id}"`)
    }
    routeIds.add(rule.id)
    if (!pipelineIds.has(rule.pipelineId)) {
      throw new Error(`route "${rule.id}" references unknown pipeline "${rule.pipelineId}"`)
    }
  }

  return doc
}

/**
 * Parse and validate `team-config.yaml` into a canonical {@link TeamConfigDocument}.
 * Throws an Error on YAML syntax errors, schema mismatches, duplicate IDs, or
 * broken cross-entity references.
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

  const crew: CrewMember[] = (data.crew ?? []).map((item, idx) => {
    const createdAt = item.createdAt ?? now + idx
    const updatedAt = item.updatedAt ?? createdAt
    return crewMember.parse({
      id: item.id,
      name: item.name,
      role: item.role,
      ...(item.agentKind === undefined ? {} : { agentKind: item.agentKind }),
      ...(item.provider === undefined ? {} : { provider: item.provider }),
      ...(item.model === undefined ? {} : { model: item.model }),
      enabled: item.enabled ?? true,
      createdAt,
      updatedAt,
    })
  })

  const pipelines: PipelineRecord[] = (data.pipelines ?? []).map((item, idx) => {
    const createdAt = item.createdAt ?? now + idx
    const updatedAt = item.updatedAt ?? createdAt
    const stages: PipelineStage[] = (item.stages ?? []).map(stage => ({
      memberId: stage.memberId,
      instruction: stage.instruction ?? '',
      skippable: stage.skippable ?? false,
      ...(stage.skipLogic === undefined ? {} : { skipLogic: stage.skipLogic }),
      ...(stage.mode === undefined ? {} : { mode: stage.mode }),
    }))
    return pipelineRecord.parse({
      id: item.id,
      name: item.name,
      stages,
      createdAt,
      updatedAt,
    })
  })

  const routes: RouteRule[] = (data.routes ?? []).map((item, idx) => {
    const createdAt = item.createdAt ?? now + idx
    const updatedAt = item.updatedAt ?? createdAt
    return routeRule.parse({
      id: item.id,
      condition: item.condition,
      pipelineId: item.pipelineId,
      enabled: item.enabled ?? true,
      order: item.order ?? idx,
      createdAt,
      updatedAt,
    })
  })

  return validateTeamConfigDocument({
    version: 1,
    crew,
    pipelines,
    routes,
  })
}

/**
 * Serialize a {@link TeamConfigDocument} to clean, deterministic, human- and
 * agent-editable YAML with a header comment.
 */
export function serializeTeamConfigYaml(doc: TeamConfigDocument): string {
  const plain = {
    version: 1,
    crew: doc.crew.map(member => ({
      id: member.id,
      name: member.name,
      role: member.role,
      ...(member.agentKind === undefined ? {} : { agentKind: member.agentKind }),
      ...(member.provider === undefined ? {} : { provider: member.provider }),
      ...(member.model === undefined ? {} : { model: member.model }),
      enabled: member.enabled,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    })),
    pipelines: doc.pipelines.map(pipeline => ({
      id: pipeline.id,
      name: pipeline.name,
      stages: pipeline.stages.map(stage => ({
        memberId: stage.memberId,
        instruction: stage.instruction,
        skippable: stage.skippable,
        ...(stage.skipLogic === undefined ? {} : { skipLogic: stage.skipLogic }),
        ...(stage.mode === undefined ? {} : { mode: stage.mode }),
      })),
      createdAt: pipeline.createdAt,
      updatedAt: pipeline.updatedAt,
    })),
    routes: doc.routes.map(rule => ({
      id: rule.id,
      condition: rule.condition,
      pipelineId: rule.pipelineId,
      enabled: rule.enabled,
      order: rule.order,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    })),
  }
  const header = [
    '# Dsh Manager 团队与流程配置（支持热更新：修改并保存后自动校验生效）',
    '# 文档字段：crew（队员）、pipelines（流水线）、routes（路由规则）',
    '',
  ].join('\n')
  const body = stringifyYaml(plain, { lineWidth: 100 })
  return `${header}${body.endsWith('\n') ? body : `${body}\n`}`
}

/**
 * Clean up legacy storage-domain records during one-time migration so any
 * previously orphaned stage/rule references do not poison the initial YAML.
 */
export function sanitizeLegacyTeamConfig(input: {
  readonly crew: readonly CrewMember[]
  readonly pipelines: readonly PipelineRecord[]
  readonly routes: readonly RouteRule[]
}): { readonly doc: TeamConfigDocument; readonly warnings: readonly string[] } {
  const warnings: string[] = []
  const crew = [...input.crew].sort((a, b) => a.createdAt - b.createdAt)
  const crewIds = new Set(crew.map(member => member.id))

  const pipelines: PipelineRecord[] = [...input.pipelines]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(pipeline => {
      const stages = pipeline.stages.filter((stage, idx) => {
        if (crewIds.has(stage.memberId)) return true
        warnings.push(`dropped stage ${idx + 1} of pipeline "${pipeline.id}": unknown member "${stage.memberId}"`)
        return false
      })
      return { ...pipeline, stages }
    })
  const pipelineIds = new Set(pipelines.map(pipeline => pipeline.id))

  const routes = [...input.routes]
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    .filter(rule => {
      if (pipelineIds.has(rule.pipelineId)) return true
      warnings.push(`dropped route "${rule.id}": unknown pipeline "${rule.pipelineId}"`)
      return false
    })

  return {
    doc: validateTeamConfigDocument({ version: 1, crew, pipelines, routes }),
    warnings,
  }
}
