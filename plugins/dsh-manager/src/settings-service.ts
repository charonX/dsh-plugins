/**
 * The UI-settings facility: the small face-level preferences (panel display
 * name) over the durable settings domain. One mutable record; absent fields
 * mean the localized default.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defaultUiSettings, type UiSettingsRecord } from './settings/settings-core.ts'
import { settingsDomain } from './settings/settings-domain.ts'
import { uiSettingsUpdateInputSchema, type UiSettingsUpdateInput, type UiSettingsView } from './settings/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The UI-settings API served to the Dsh Manager client. */
    dshManagerSettings: DshManagerSettings
  }
}

/** Settings facet configuration. */
export interface SettingsConfig {}

export const SettingsConfig: z<SettingsConfig> = z.object({})

export class DshManagerSettings extends TypertRemoteService {
  /** Host facilities the settings read. */
  static inject = ['storageDomain']

  static Config: z<SettingsConfig> = SettingsConfig

  private domain?: Domain<typeof settingsDomain>

  constructor(ctx: Context, config: SettingsConfig) {
    super(ctx, 'dshManagerSettings', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(settingsDomain)
    this.domain = domain
    // Seed the record so the first update is a plain overwrite.
    if (this.domain.table('records').get('ui' as never) === undefined) {
      await this.putRecord(defaultUiSettings(Date.now()))
    }
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close settings domain')
  }

  /** The current UI settings. */
  @Remote
  async uiSettings(): Promise<{ readonly settings: UiSettingsView }> {
    return { settings: this.view() }
  }

  /** The user's own edit: an empty title clears the custom name. */
  @Remote
  async uiSettingsUpdate(rawInput: UiSettingsUpdateInput): Promise<{ readonly settings: UiSettingsView }> {
    const input = uiSettingsUpdateInputSchema.parse(rawInput)
    const prev = this.record()
    // An empty title clears the custom name back to the localized default.
    const title = input.title === undefined
      ? prev.title
      : (input.title === '' ? undefined : input.title)
    const evalBatchSize = input.evalBatchSize ?? prev.evalBatchSize
    const next: UiSettingsRecord = {
      id: 'ui',
      ...(title === undefined ? {} : { title }),
      ...(evalBatchSize === undefined ? {} : { evalBatchSize }),
      updatedAt: Date.now(),
    }
    await this.putRecord(next)
    return { settings: this.view() }
  }

  /** Configured Steward triage batch size, if overridden from the UI. */
  configuredEvalBatchSize(): number | undefined {
    return this.record().evalBatchSize
  }

  /** The stored record, or the default shape before any save. */
  private record(): UiSettingsRecord {
    const stored = this.domain?.table('records').get('ui' as never)
    return stored ?? defaultUiSettings(0)
  }

  private async putRecord(record: UiSettingsRecord): Promise<void> {
    await this.domain!.table('records').put(record.id as never, record)
  }

  /** Project the record onto the wire view. */
  private view(): UiSettingsView {
    const record = this.record()
    return {
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.evalBatchSize === undefined ? {} : { evalBatchSize: record.evalBatchSize }),
    }
  }
}

export default DshManagerSettings
