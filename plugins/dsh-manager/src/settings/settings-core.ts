/**
 * The UI settings core: small face-level preferences the shell renders —
 * currently the panel's display name, which the client overlays onto its
 * locale dictionary. One mutable record, id `ui`; absent fields mean default.
 */
import { z } from 'zod'

/** The durable UI-settings record. */
export const uiSettingsRecord = z.object({
  id: z.literal('ui'),
  /** The custom panel display name; absent means the localized default. */
  title: z.string().trim().min(1).max(40).optional(),
  /** Maximum backlog threads evaluated together per Steward batch pass. */
  evalBatchSize: z.number().int().min(1).max(50).optional(),
  updatedAt: z.number(),
})

export type UiSettingsRecord = z.infer<typeof uiSettingsRecord>

/** The default record before any save. */
export function defaultUiSettings(now: number): UiSettingsRecord {
  return uiSettingsRecord.parse({ id: 'ui', updatedAt: now })
}
