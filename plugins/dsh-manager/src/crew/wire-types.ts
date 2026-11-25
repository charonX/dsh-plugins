/**
 * Wire-level types and input schemas of the crew API — shared by the host
 * service and the client contribution.
 */
import { z as zod } from 'zod'
import { AGENT_KINDS, type AgentKind, type CrewMember } from './crew-core.ts'

export type CrewMemberView = CrewMember

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
  /** Optional slash commands discovered from an external-agents service when loaded. */
  readonly slashCommands?: readonly AgentSlashCommand[]
}

export const agentKindOptionsInputSchema = zod.object({
  refresh: zod.boolean().optional(),
})

export type AgentKindOptionsInput = zod.infer<typeof agentKindOptionsInputSchema>

/** One provider's selectable models, as the member form's dropdown reads them. */
export interface ModelProviderOptions {
  /** The provider route (the value a model override stores). */
  readonly provider: string
  /** The provider's display name. */
  readonly providerName: string
  /** The advertised models in adapter-preferred order. */
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** The facts a create or edit carries; edits address the member separately.
    A `null` provider, model, or agentKind clears the override (back to inheriting). */
export const crewInputSchema = zod.object({
  name: zod.string().trim().min(1).max(40),
  role: zod.string().trim().min(1).max(4000),
  agentKind: zod.enum(AGENT_KINDS).nullable().optional(),
  provider: zod.string().trim().min(1).nullable().optional(),
  model: zod.string().trim().min(1).nullable().optional(),
  enabled: zod.boolean().optional(),
})

export type CrewInput = zod.infer<typeof crewInputSchema>

export const crewMemberIdSchema = zod.object({
  memberId: zod.string().min(1),
})

export type CrewMemberIdInput = zod.infer<typeof crewMemberIdSchema>

export const crewUpdateInputSchema = crewMemberIdSchema.extend(crewInputSchema.partial().shape)

export type CrewUpdateInput = zod.infer<typeof crewUpdateInputSchema>
