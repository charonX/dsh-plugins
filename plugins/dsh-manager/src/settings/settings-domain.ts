/**
 * The settings domain: the mutable UI-settings record over storage-domain —
 * the persistence adapter behind the settings core (ADR-0003).
 */
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { uiSettingsRecord, type UiSettingsRecord } from './settings-core.ts'

/** Stable settings record identity (always `ui`). */
export type UiSettingsId = Branded<'UiSettingsId'>

/** Durable UI settings: one mutable record per id. */
export const settingsDomain = defineDomain({
  name: 'dsh_manager_settings',
  version: 1,
  tables: {
    records: domainTable<UiSettingsId, UiSettingsRecord>(uiSettingsRecord),
  },
})
