/** The UI-settings source: the panel's custom display name and its save path. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiSettingsView } from '../settings/wire-types.ts'

/** The UI-settings snapshot the source publishes; a failed read keeps the error state. */
export interface UiSettingsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly settings?: UiSettingsView
}

/** Remote face the source reads; the client entry injects the mounted namespace. */
export interface UiSettingsDependencies {
  readonly read: () => Promise<{ ok: boolean; value?: { readonly settings: UiSettingsView }; error?: unknown }>
  readonly save: (input: { title?: string; evalBatchSize?: number }) => Promise<{ ok: boolean; value?: { readonly settings: UiSettingsView }; error?: unknown }>
  /** Applied after a successful save or read: the shell overlays the name. */
  readonly onTitleApplied: (title: string | undefined) => void
}

/** Props injected through the UI-settings slot. */
export interface UiSettingsInjected {
  readonly hooks: { readonly uiSettings: HostObservable<UiSettingsSnapshot> }
  /** Save the custom display name; resolves `false` when the host rejected it. */
  readonly onTitleSave: (title: string) => Promise<boolean>
  /** Save the Steward triage batch size; resolves `false` when the host rejected it. */
  readonly onEvalBatchSizeSave: (evalBatchSize: number) => Promise<boolean>
  /** Re-read the settings after a failure. */
  readonly onUiSettingsRetry: () => void
}

/**
 * Create the UI-settings source: the settings read once per subscriber (they
 * rarely change), the save publishes immediately, and every applied title
 * reaches the shell's overlay callback.
 * @param deps - the remote reads, the save, and the title-apply callback.
 * @returns the injected UI-settings face.
 */
export function createUiSettingsSource(deps: UiSettingsDependencies): UiSettingsInjected {
  let snapshot: UiSettingsSnapshot = { status: 'loading' }
  const listeners = new Set<() => void>()
  const publish = (next: UiSettingsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const read = async (): Promise<void> => {
    let settings: UiSettingsView | undefined
    try {
      const result = await deps.read()
      settings = result.ok ? result.value?.settings : undefined
    } catch {
      settings = undefined
    }
    if (settings === undefined) {
      publish({ status: 'error' })
      return
    }
    deps.onTitleApplied(settings.title)
    publish({ status: 'ready', settings })
  }
  return {
    hooks: {
      uiSettings: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          // The settings read once per subscriber; there is no polling.
          if (listeners.size === 1) void read()
          return () => {
            listeners.delete(listener)
          }
        },
      },
    },
    async onTitleSave(title) {
      const trimmed = title.trim()
      try {
        const result = await deps.save(trimmed === '' ? { title: '' } : { title: trimmed })
        if (!result.ok) return false
        const applied = result.value?.settings.title
        deps.onTitleApplied(applied)
        publish({ status: 'ready', settings: result.value?.settings ?? {} })
        return true
      } catch {
        return false
      }
    },
    async onEvalBatchSizeSave(evalBatchSize) {
      if (!Number.isInteger(evalBatchSize) || evalBatchSize < 1 || evalBatchSize > 50) return false
      try {
        const result = await deps.save({ evalBatchSize })
        if (!result.ok) return false
        publish({ status: 'ready', settings: result.value?.settings ?? {} })
        return true
      } catch {
        return false
      }
    },
    onUiSettingsRetry: () => { void read() },
  }
}
