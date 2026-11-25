/**
 * Wire-level types and input schemas of the UI-settings API — shared by the
 * host service and the client contribution.
 */
import { z as zod } from 'zod'

/** The UI settings the page renders. */
export interface UiSettingsView {
  /** The custom panel display name; absent means the localized default. */
  readonly title?: string
  /** Configured Steward batch size for eval + route triage (defaults to 10). */
  readonly evalBatchSize?: number
}

export const uiSettingsUpdateInputSchema = zod.object({
  /** The custom display name; empty clears it back to the localized default. */
  title: zod.string().trim().max(40).optional(),
  /** Maximum backlog threads evaluated together in one Steward triage batch. */
  evalBatchSize: zod.number().int().min(1).max(50).optional(),
})

export type UiSettingsUpdateInput = zod.infer<typeof uiSettingsUpdateInputSchema>
