/**
 * The route-rule core: a route rule is one allocation rule — a natural-
 * language condition description mapped to a pipeline. The Steward matches
 * ticket summaries against the enabled rules; nothing matches → the ticket
 * waits for a human judgment instead of a silent default. Rules are plain
 * mutable records; the pipeline owns the stage order.
 */
import { z } from 'zod'

/** One route rule: the condition text and the pipeline it hands tickets to. */
export const routeRule = z.object({
  id: z.string(),
  /** The condition in natural language; the Steward reads it verbatim. */
  condition: z.string().trim().min(1).max(2000),
  /** The referenced pipeline's id. */
  pipelineId: z.string().min(1),
  /** A disabled rule stays listed but never matches. */
  enabled: z.boolean(),
  /** Stable list order; lower runs first in the mindmap. */
  order: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type RouteRule = z.infer<typeof routeRule>
