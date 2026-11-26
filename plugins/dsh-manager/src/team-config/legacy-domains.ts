/**
 * Read-only legacy storage-domain table definitions used strictly for one-time
 * migration of pre-YAML v1/v2 data into Flow IR v3.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { AGENT_KINDS } from '../flow/flow-ir.ts'

const legacyCrewMember = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  agentKind: z.enum(AGENT_KINDS).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const legacyPipelineRecord = z.object({
  id: z.string(),
  name: z.string(),
  stages: z.array(z.object({
    memberId: z.string(),
    instruction: z.string().default(''),
    skippable: z.boolean().default(false),
    skipLogic: z.string().optional(),
    mode: z.enum(['execute', 'review']).optional(),
  })),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const legacyRouteRule = z.object({
  id: z.string(),
  condition: z.string(),
  pipelineId: z.string(),
  enabled: z.boolean(),
  order: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const legacyCrewDomain = defineDomain({
  name: 'dsh_manager_crew',
  version: 1,
  tables: {
    members: domainTable<Branded<'CrewMemberId'>, z.infer<typeof legacyCrewMember>>(legacyCrewMember),
  },
})

export const legacyPipelineDomain = defineDomain({
  name: 'dsh_manager_pipeline',
  version: 1,
  tables: {
    pipelines: domainTable<Branded<'PipelineId'>, z.infer<typeof legacyPipelineRecord>>(legacyPipelineRecord),
  },
})

export const legacyRouteDomain = defineDomain({
  name: 'dsh_manager_route',
  version: 1,
  tables: {
    rules: domainTable<Branded<'RouteRuleId'>, z.infer<typeof legacyRouteRule>>(legacyRouteRule),
  },
})
