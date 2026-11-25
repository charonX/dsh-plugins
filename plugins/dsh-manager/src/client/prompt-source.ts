/**
 * Prompt Studio client state source: fetches built-in turns, variable catalog,
 * 3-tier overrides, live preview rendering, and YAML import/save mutations.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TicketView } from '../board-domain.ts'
import type { CrewMemberView } from '../crew/wire-types.ts'
import type { ProjectRef } from '../mappings/wire-types.ts'
import type { PipelineView } from '../pipeline/wire-types.ts'
import type { PresetId } from '../team-config/presets.ts'
import type {
  PresetApplyInput,
  PromptPreviewInput,
  PromptPreviewView,
  PromptRegistryView,
  PromptSaveInput,
} from '../team-config/wire-types.ts'
import type { TeamConfigStatusView } from '../team-config/team-config-core.ts'

export interface PromptSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly registry?: PromptRegistryView
  readonly busy?: boolean
  readonly actionError?: string
}

export interface PromptInjected {
  readonly hooks: { readonly prompts: HostObservable<PromptSnapshot> }
  readonly onPromptRefresh: () => Promise<void>
  readonly onPromptSave: (input: PromptSaveInput) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly onPromptImportYaml: (yaml: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  readonly onPromptPreview: (input: PromptPreviewInput) => Promise<PromptPreviewView | undefined>
  readonly onPromptProjects: () => Promise<readonly ProjectRef[]>
  readonly onPromptTickets: () => Promise<readonly TicketView[]>
  readonly onPresetApply?: (presetId: PresetId) => Promise<{ readonly ok: boolean; readonly pipeline?: PipelineView; readonly error?: string }>
}

export interface PromptSourceDependencies {
  readonly registry?: () => Promise<{ ok: boolean; value?: PromptRegistryView; error?: unknown }>
  readonly save?: (input: PromptSaveInput) => Promise<{ ok: boolean; value?: { readonly status: TeamConfigStatusView; readonly registry: PromptRegistryView }; error?: unknown }>
  readonly importYaml?: (yaml: string) => Promise<{ ok: boolean; value?: { readonly status: TeamConfigStatusView; readonly registry: PromptRegistryView }; error?: unknown }>
  readonly preview?: (input: PromptPreviewInput) => Promise<{ ok: boolean; value?: PromptPreviewView; error?: unknown }>
  readonly applyPreset?: (input: PresetApplyInput) => Promise<{ ok: boolean; value?: { readonly pipeline: PipelineView; readonly createdMembers: readonly CrewMemberView[]; readonly status: TeamConfigStatusView }; error?: unknown }>
  readonly projects?: () => Promise<{ ok: boolean; value?: { readonly projects: readonly ProjectRef[] }; error?: unknown }>
  readonly tickets?: () => Promise<{ ok: boolean; value?: { readonly tickets: readonly TicketView[] }; error?: unknown }>
  readonly subscribeReset?: (listener: () => void) => () => void
  readonly onMutated?: () => void
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const rec = error as { message?: unknown; code?: unknown }
    if (typeof rec.message === 'string' && rec.message !== '') return rec.message
    if (typeof rec.code === 'string' && rec.code !== '') return rec.code
  }
  return String(error)
}

export function createPromptSource(
  deps: PromptSourceDependencies,
): PromptInjected & { readonly invalidate: () => void } {
  let snapshot: PromptSnapshot = { status: 'loading' }
  let disposeReset: (() => void) | undefined
  const listeners = new Set<() => void>()

  const publish = (next: PromptSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const read = async (): Promise<void> => {
    if (deps.registry === undefined) {
      publish({ status: 'error' })
      return
    }
    try {
      const result = await deps.registry()
      if (result.ok && result.value !== undefined) {
        publish({ status: 'ready', registry: result.value, busy: false })
      } else {
        publish({
          status: snapshot.registry === undefined ? 'error' : 'ready',
          ...(snapshot.registry === undefined ? {} : { registry: snapshot.registry }),
          busy: false,
          ...(result.error === undefined ? {} : { actionError: errorText(result.error) }),
        })
      }
    } catch (error) {
      publish({
        status: snapshot.registry === undefined ? 'error' : 'ready',
        ...(snapshot.registry === undefined ? {} : { registry: snapshot.registry }),
        busy: false,
        actionError: errorText(error),
      })
    }
  }

  return {
    hooks: {
      prompts: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            if (deps.subscribeReset !== undefined) {
              disposeReset = deps.subscribeReset(() => { void read() })
            }
            void read()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) {
              disposeReset?.()
              disposeReset = undefined
            }
          }
        },
      },
    },
    invalidate() {
      if (listeners.size > 0) void read()
    },
    async onPromptRefresh() {
      await read()
    },
    async onPromptSave(input) {
      if (deps.save === undefined) return { ok: false, error: 'promptSave unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.save(input)
        if (!result.ok || result.value === undefined) {
          const msg = errorText(result.error ?? 'save failed')
          publish({ ...snapshot, busy: false, actionError: msg })
          return { ok: false, error: msg }
        }
        publish({ status: 'ready', registry: result.value.registry, busy: false })
        deps.onMutated?.()
        return { ok: true }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onPromptImportYaml(yaml) {
      if (deps.importYaml === undefined) return { ok: false, error: 'teamConfigImportYaml unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const result = await deps.importYaml(yaml)
        if (!result.ok || result.value === undefined) {
          const msg = errorText(result.error ?? 'import failed')
          publish({ ...snapshot, busy: false, actionError: msg })
          return { ok: false, error: msg }
        }
        publish({ status: 'ready', registry: result.value.registry, busy: false })
        deps.onMutated?.()
        return { ok: true }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onPromptPreview(input) {
      if (deps.preview === undefined) return undefined
      try {
        const result = await deps.preview(input)
        return result.ok ? result.value : undefined
      } catch {
        return undefined
      }
    },
    async onPromptProjects() {
      if (deps.projects === undefined) return []
      try {
        const result = await deps.projects()
        return result.ok && result.value !== undefined ? result.value.projects : []
      } catch {
        return []
      }
    },
    async onPromptTickets() {
      if (deps.tickets === undefined) return []
      try {
        const result = await deps.tickets()
        return result.ok && result.value !== undefined ? result.value.tickets : []
      } catch {
        return []
      }
    },
    ...(deps.applyPreset === undefined ? {} : {
      async onPresetApply(presetId: PresetId) {
        publish({ ...snapshot, busy: true })
        try {
          const result = await deps.applyPreset!({ presetId })
          if (!result.ok || result.value === undefined) {
            const msg = errorText(result.error ?? 'preset apply failed')
            publish({ ...snapshot, busy: false, actionError: msg })
            return { ok: false, error: msg }
          }
          publish({ ...snapshot, busy: false })
          deps.onMutated?.()
          if (listeners.size > 0) void read()
          return { ok: true, pipeline: result.value.pipeline }
        } catch (error) {
          const msg = errorText(error)
          publish({ ...snapshot, busy: false, actionError: msg })
          return { ok: false, error: msg }
        }
      },
    }),
  }
}
