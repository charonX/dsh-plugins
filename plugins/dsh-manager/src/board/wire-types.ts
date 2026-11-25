/**
 * Wire-level types and input schemas of the board API — shared by the Host
 * service and the client contribution.
 */
import { z as zod } from 'zod'
import { SOURCE_KINDS } from '../sources/wire-types.ts'

/** The kinds a board filter can address; `manual` instances back user input. */
export const BOARD_FILTER_KINDS = [...SOURCE_KINDS, 'manual'] as const
export type BoardFilterKind = (typeof BOARD_FILTER_KINDS)[number]

/** The combined board filter; every field is optional and they intersect. */
export interface BoardFilter {
  /** Keep only tickets whose thread came from this connection. */
  readonly connectionId?: string | undefined
  /** Keep only tickets belonging to this DSH project. */
  readonly projectId?: string | undefined
  /** Keep only tickets whose producing Source instance has this kind. */
  readonly kind?: BoardFilterKind | undefined
  /** Keep only tickets whose title or external key contains this text, case-insensitive. */
  readonly search?: string | undefined
}

export const boardFilterSchema = zod.object({
  connectionId: zod.string().min(1).optional(),
  projectId: zod.string().min(1).optional(),
  kind: zod.enum(BOARD_FILTER_KINDS).optional(),
  search: zod.string().min(1).optional(),
})

/** Update a ticket's prerequisite dependencies (`dependsOn`). */
export interface TicketDependenciesInput {
  readonly ticketId: string
  readonly dependsOn: readonly string[]
}

export const ticketDependenciesInputSchema = zod.object({
  ticketId: zod.string().min(1),
  dependsOn: zod.array(zod.string().min(1)),
})

/** Manually close/abandon a ticket (and any remaining stages in its flow). */
export interface CloseTicketInput {
  readonly ticketId: string
  readonly reason?: string | undefined
}

export const closeTicketInputSchema = zod.object({
  ticketId: zod.string().min(1),
  reason: zod.string().trim().max(1000).optional(),
})
