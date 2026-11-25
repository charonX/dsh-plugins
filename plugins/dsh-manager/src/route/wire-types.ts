/**
 * Wire-level types and input schemas of the route API — shared by the host
 * service and the client contribution.
 */
import { z as zod } from 'zod'
import type { RouteRule } from './route-core.ts'

export type RouteRuleView = RouteRule

export const routeInputSchema = zod.object({
  condition: zod.string().trim().min(1).max(2000),
  pipelineId: zod.string().min(1),
  enabled: zod.boolean().optional(),
})

export type RouteInput = zod.infer<typeof routeInputSchema>

export const routeIdSchema = zod.object({
  ruleId: zod.string().min(1),
})

export type RouteIdInput = zod.infer<typeof routeIdSchema>

export const routeUpdateInputSchema = routeIdSchema.extend(routeInputSchema.partial().shape)

export type RouteUpdateInput = zod.infer<typeof routeUpdateInputSchema>
