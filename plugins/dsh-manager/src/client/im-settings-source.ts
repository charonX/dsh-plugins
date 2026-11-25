/** The IM settings source: dsh-im availability, bots/targets discovery, binding, and test delivery. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ImBotOption,
  ImSettingsSnapshotView,
  ImSettingsUpdateInput,
  ImSettingsView,
  ImTestSendInput,
} from '../im/wire-types.ts'

export interface ImSettingsSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly available: boolean
  readonly settings: ImSettingsView
  readonly bots: readonly ImBotOption[]
  readonly lastError?: string
}

export interface ImSettingsDependencies {
  readonly read: () => Promise<{ ok: boolean; value?: ImSettingsSnapshotView; error?: unknown }>
  readonly save: (input: ImSettingsUpdateInput) => Promise<{ ok: boolean; value?: ImSettingsSnapshotView; error?: unknown }>
  readonly testSend: (input?: ImTestSendInput) => Promise<{ ok: boolean; value?: { readonly sent: boolean; readonly error?: string }; error?: unknown }>
}

export interface ImSettingsInjected {
  readonly hooks: { readonly imSettings: HostObservable<ImSettingsSnapshot> }
  readonly onImSettingsSave: (input: ImSettingsUpdateInput) => Promise<boolean>
  readonly onImSettingsRefresh: () => void
  readonly onImTestSend: (input?: ImTestSendInput) => Promise<{ readonly sent: boolean; readonly error?: string }>
}

const DEFAULT_SETTINGS: ImSettingsView = {
  enabled: false,
  notifyAttention: true,
  notifyProgress: false,
}

export function createImSettingsSource(deps: ImSettingsDependencies): ImSettingsInjected {
  let snapshot: ImSettingsSnapshot = {
    status: 'loading',
    available: false,
    settings: DEFAULT_SETTINGS,
    bots: [],
  }
  const listeners = new Set<() => void>()
  const publish = (next: ImSettingsSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const applyView = (view: ImSettingsSnapshotView): void => {
    publish({
      status: 'ready',
      available: view.available,
      settings: view.settings,
      bots: view.bots,
      ...(view.lastError === undefined ? {} : { lastError: view.lastError }),
    })
  }
  const read = async (): Promise<void> => {
    try {
      const result = await deps.read()
      if (!result.ok || result.value === undefined) {
        publish({ ...snapshot, status: 'error' })
        return
      }
      applyView(result.value)
    } catch {
      publish({ ...snapshot, status: 'error' })
    }
  }
  return {
    hooks: {
      imSettings: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) void read()
          return () => {
            listeners.delete(listener)
          }
        },
      },
    },
    async onImSettingsSave(input) {
      try {
        const result = await deps.save(input)
        if (!result.ok || result.value === undefined) return false
        applyView(result.value)
        return true
      } catch {
        return false
      }
    },
    onImSettingsRefresh: () => { void read() },
    async onImTestSend(input) {
      try {
        const result = await deps.testSend(input)
        if (!result.ok || result.value === undefined) {
          return { sent: false, error: 'request failed' }
        }
        return result.value
      } catch (error) {
        return { sent: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
