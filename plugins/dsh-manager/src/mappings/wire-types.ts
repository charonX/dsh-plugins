/**
 * Wire-level types and input schemas of the mappings API — shared by the
 * Host service and the client contribution, so the browser face never pulls
 * in Node-only modules.
 */
import { z as zod } from 'zod'

/** One DSH project the mapping picker offers, projected from the harness workspace registry. */
export interface ProjectRef {
  /** Stable project id in the harness project list. */
  readonly id: string
  /** User-facing project name. */
  readonly name: string
}

/** One mapping as the wire sees it. */
export interface MappingView {
  readonly id: string
  readonly connectionId: string
  readonly external: string
  readonly projectId: string
  readonly updatedAt: number
  /** False when the mapped project no longer exists in the harness list. */
  readonly valid: boolean
}

/** Input of creating or editing one mapping; it overwrites the same pair. */
export interface MappingSetInput {
  readonly connectionId: string
  /** Connector-specific external key, e.g. a Jira project key. */
  readonly external: string
  readonly projectId: string
}

export const mappingSetInputSchema = zod.object({
  connectionId: zod.string().min(1),
  external: zod.string().min(1),
  projectId: zod.string().min(1),
})

/** Input of removing one mapping. */
export interface MappingRemoveInput {
  readonly id: string
}

export const mappingRemoveInputSchema = zod.object({
  id: zod.string().min(1),
})
