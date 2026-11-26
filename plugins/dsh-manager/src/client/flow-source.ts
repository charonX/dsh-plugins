/**
 * Unified Flow IR, Skill catalog, Playbook compiler, and Agent options source
 * for the simplified Team UI (replaces separate crew/pipeline/route/prompt sources).
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AgentKindOption,
  DiscoveredSkill,
  FlowDef,
  FlowImportPlaybookInput,
  FlowInput,
  FlowUpdateInput,
  ModelProviderOptions,
  PresetId,
} from '../flow/flow-ir.ts'
import type { TeamConfigStatusView } from '../team-config/team-config-core.ts'

export interface FlowSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly flows?: readonly FlowDef[]
  readonly skills?: readonly DiscoveredSkill[]
  readonly busy?: boolean
  readonly actionError?: string
}

export interface PlaybookCompileOutcome {
  readonly ok: boolean
  readonly flow?: FlowDef
  readonly cacheHit?: boolean
  readonly method?: 'cache' | 'frontmatter' | 'markdown' | 'llm'
  readonly error?: string
}

export interface FlowInjected {
  readonly hooks: { readonly flows: HostObservable<FlowSnapshot> }
  readonly onFlowAdd: (input: FlowInput) => Promise<{ readonly ok: boolean; readonly flow?: FlowDef; readonly error?: string }>
  readonly onFlowUpdate: (input: FlowUpdateInput) => Promise<{ readonly ok: boolean; readonly flow?: FlowDef; readonly error?: string }>
  readonly onFlowRemove: (flowId: string) => Promise<void>
  readonly onFlowRetry: () => Promise<void>
  readonly onFlowPresetApply: (presetId: PresetId) => Promise<{ readonly ok: boolean; readonly flow?: FlowDef; readonly error?: string }>
  readonly onFlowImportPlaybook: (input: FlowImportPlaybookInput) => Promise<PlaybookCompileOutcome>
  readonly onFlowSyncPlaybook: (flowId: string) => Promise<PlaybookCompileOutcome>
  readonly onSkillCatalogRefresh: () => Promise<void>
  readonly onAgentKindOptions: (refresh?: boolean) => Promise<readonly AgentKindOption[]>
  readonly onModelOptions: () => Promise<readonly ModelProviderOptions[]>
  readonly onTeamConfigExportYaml: () => Promise<string | undefined>
  readonly onTeamConfigImportYaml: (yaml: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
}

export interface FlowSourceDependencies {
  readonly list: () => Promise<{ ok: boolean; value?: { readonly flows: readonly FlowDef[] }; error?: unknown }>
  readonly add?: (input: FlowInput) => Promise<{ ok: boolean; value?: { readonly flow: FlowDef }; error?: unknown }>
  readonly update?: (input: FlowUpdateInput) => Promise<{ ok: boolean; value?: { readonly flow: FlowDef }; error?: unknown }>
  readonly remove?: (input: { readonly flowId: string }) => Promise<{ ok: boolean; error?: unknown }>
  readonly applyPreset?: (input: { readonly presetId: PresetId }) => Promise<{ ok: boolean; value?: { readonly flow: FlowDef; readonly status: TeamConfigStatusView }; error?: unknown }>
  readonly importPlaybook?: (input: FlowImportPlaybookInput) => Promise<{
    ok: boolean
    value?: { readonly flow: FlowDef; readonly cacheHit: boolean; readonly method: 'cache' | 'frontmatter' | 'markdown' | 'llm' }
    error?: unknown
  }>
  readonly syncPlaybook?: (input: { readonly flowId: string }) => Promise<{
    ok: boolean
    value?: { readonly flow: FlowDef; readonly cacheHit: boolean; readonly method: 'cache' | 'frontmatter' | 'markdown' | 'llm' }
    error?: unknown
  }>
  readonly skillCatalog?: () => Promise<{ ok: boolean; value?: { readonly skills: readonly DiscoveredSkill[] } }>
  readonly agentKindOptions?: (input?: { readonly refresh?: boolean }) => Promise<{ ok: boolean; value?: { readonly kinds: readonly AgentKindOption[] } }>
  readonly modelOptions?: () => Promise<{ ok: boolean; value?: { readonly providers: readonly ModelProviderOptions[] } }>
  readonly exportYaml?: () => Promise<{ ok: boolean; value?: { readonly yaml: string } }>
  readonly importYaml?: (input: { readonly yaml: string }) => Promise<{ ok: boolean; value?: { readonly flows: readonly FlowDef[] }; error?: unknown }>
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

export function createFlowSource(
  deps: FlowSourceDependencies,
): FlowInjected & { readonly invalidate: () => void } {
  let snapshot: FlowSnapshot = { status: 'loading' }
  let disposeReset: (() => void) | undefined
  const listeners = new Set<() => void>()

  const publish = (next: FlowSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const read = async (): Promise<void> => {
    try {
      const [flowRes, skillRes] = await Promise.all([
        deps.list(),
        deps.skillCatalog?.().catch(() => ({ ok: false, value: undefined })),
      ])
      const skills = skillRes?.ok && skillRes.value !== undefined ? skillRes.value.skills : snapshot.skills
      if (flowRes.ok && flowRes.value !== undefined) {
        publish({
          status: 'ready',
          flows: flowRes.value.flows,
          ...(skills === undefined ? {} : { skills }),
          busy: false,
        })
      } else {
        publish({
          status: snapshot.flows === undefined ? 'error' : 'ready',
          ...(snapshot.flows === undefined ? {} : { flows: snapshot.flows }),
          ...(skills === undefined ? {} : { skills }),
          busy: false,
          ...(flowRes.error === undefined ? {} : { actionError: errorText(flowRes.error) }),
        })
      }
    } catch (error) {
      publish({
        status: snapshot.flows === undefined ? 'error' : 'ready',
        ...(snapshot.flows === undefined ? {} : { flows: snapshot.flows }),
        ...(snapshot.skills === undefined ? {} : { skills: snapshot.skills }),
        busy: false,
        actionError: errorText(error),
      })
    }
  }

  return {
    hooks: {
      flows: {
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
    async onFlowRetry() {
      publish({ ...snapshot, status: 'loading' })
      await read()
    },
    async onSkillCatalogRefresh() {
      if (deps.skillCatalog === undefined) return
      try {
        const res = await deps.skillCatalog()
        if (res.ok && res.value !== undefined) {
          publish({ ...snapshot, skills: res.value.skills })
        }
      } catch {
        // Leave existing skill list intact on transient failure.
      }
    },
    async onFlowAdd(input) {
      if (deps.add === undefined) return { ok: false, error: 'flowAdd unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.add(input)
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'flowAdd failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true, flow: res.value.flow }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onFlowUpdate(input) {
      if (deps.update === undefined) return { ok: false, error: 'flowUpdate unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.update(input)
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'flowUpdate failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true, flow: res.value.flow }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onFlowRemove(flowId) {
      if (deps.remove === undefined) return
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.remove({ flowId })
        if (res.ok) {
          await read()
          deps.onMutated?.()
        } else {
          publish({ ...snapshot, busy: false, actionError: errorText(res.error ?? 'flowRemove failed') })
        }
      } catch (error) {
        publish({ ...snapshot, busy: false, actionError: errorText(error) })
      }
    },
    async onFlowPresetApply(presetId) {
      if (deps.applyPreset === undefined) return { ok: false, error: 'flowPresetApply unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.applyPreset({ presetId })
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'preset apply failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true, flow: res.value.flow }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onFlowImportPlaybook(input) {
      if (deps.importPlaybook === undefined) return { ok: false, error: 'flowImportPlaybook unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.importPlaybook(input)
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'playbook import failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true, flow: res.value.flow, cacheHit: res.value.cacheHit, method: res.value.method }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onFlowSyncPlaybook(flowId) {
      if (deps.syncPlaybook === undefined) return { ok: false, error: 'flowSyncPlaybook unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.syncPlaybook({ flowId })
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'playbook sync failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true, flow: res.value.flow, cacheHit: res.value.cacheHit, method: res.value.method }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
    async onAgentKindOptions(refresh) {
      if (deps.agentKindOptions === undefined) return []
      try {
        const res = await deps.agentKindOptions(refresh === undefined ? undefined : { refresh })
        return res.ok && res.value !== undefined ? res.value.kinds : []
      } catch {
        return []
      }
    },
    async onModelOptions() {
      if (deps.modelOptions === undefined) return []
      try {
        const res = await deps.modelOptions()
        return res.ok && res.value !== undefined ? res.value.providers : []
      } catch {
        return []
      }
    },
    async onTeamConfigExportYaml() {
      if (deps.exportYaml === undefined) return undefined
      try {
        const res = await deps.exportYaml()
        return res.ok && res.value !== undefined ? res.value.yaml : undefined
      } catch {
        return undefined
      }
    },
    async onTeamConfigImportYaml(yaml) {
      if (deps.importYaml === undefined) return { ok: false, error: 'teamConfigImportYaml unavailable' }
      publish({ ...snapshot, busy: true })
      try {
        const res = await deps.importYaml({ yaml })
        if (!res.ok || res.value === undefined) {
          const error = errorText(res.error ?? 'import failed')
          publish({ ...snapshot, busy: false, actionError: error })
          return { ok: false, error }
        }
        await read()
        deps.onMutated?.()
        return { ok: true }
      } catch (error) {
        const msg = errorText(error)
        publish({ ...snapshot, busy: false, actionError: msg })
        return { ok: false, error: msg }
      }
    },
  }
}
