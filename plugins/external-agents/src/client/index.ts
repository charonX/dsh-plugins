import { useSyncExternalStore, type ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDescriptor } from '../types.ts'
import remote from '../remote.ts'
import { AgentSwitcher, type AgentSwitcherInjected } from './AgentSwitcher.tsx'
import {
  ExternalTasksInputDock,
  ExternalTasksPanelIndicator,
  ExternalTasksPanelSection,
  createExternalTasksStore,
} from './ExternalTasksUi.tsx'
import {
  PermissionGate,
  type NativePermissionFallback,
  type PermissionGateInjected,
} from './PermissionControl.tsx'
import { WorktreeEnvironmentRow } from './WorktreeEnvironmentRow.tsx'
import { en, NS, zh } from './locales.ts'
import { installSessionModelFilter } from './model-filter.ts'
import { installExternalSlashCommands } from './slash-commands.ts'

export const inject = ['remote', 'slots', 'locale', 'sessions']

interface ObservableLike<T = unknown> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}

const hookByObservable = new WeakMap<ObservableLike, unknown>()

function capitalizeHookProp(name: string): string {
  return name.length === 0 ? 'useValue' : `use${name[0]!.toUpperCase()}${name.slice(1)}`
}

function toObservableHook<T>(source: ObservableLike<T>) {
  const existing = hookByObservable.get(source)
  if (existing !== undefined) return existing
  const useObservable = <S = T>(selector?: (state: T) => S): S => {
    const snapshot = useSyncExternalStore(
      listener => source.subscribe(listener),
      () => source.getSnapshot(),
    )
    return selector === undefined ? (snapshot as unknown as S) : selector(snapshot)
  }
  hookByObservable.set(source, useObservable)
  return useObservable
}

export function bindInjectedHooks(face: Record<string, unknown>): Record<string, unknown> {
  const hooksRaw = face['hooks']
  if (typeof hooksRaw !== 'object' || hooksRaw === null) return face
  const { hooks: _hooks, keyedHooks: _keyedHooks, ...rest } = face
  const bound: Record<string, unknown> = { ...rest }
  for (const [key, source] of Object.entries(hooksRaw as Record<string, unknown>)) {
    if (
      typeof source === 'object'
      && source !== null
      && typeof (source as ObservableLike).subscribe === 'function'
      && typeof (source as ObservableLike).getSnapshot === 'function'
    ) {
      bound[capitalizeHookProp(key)] = toObservableHook(source as ObservableLike)
    }
  }
  return bound
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  const disposeLocale = ctx.locale.register(NS, { zh, en })
  const modelFilter = installSessionModelFilter(ctx)

  const uiScope = ctx.inject(['remote.externalAgents', 'slots', 'sessions', 'locale'], (scope) => {
    const api = scope.remote.externalAgents
    const sessions = scope.sessions

    let cachedCatalog: readonly AgentDescriptor[] | undefined
    const fetchCatalog = async (): Promise<readonly AgentDescriptor[]> => {
      const res = await api.getCatalog()
      if (!res.ok) throw new Error(res.error.message)
      cachedCatalog = res.value.agents
      return res.value.agents
    }
    const readCachedCatalog = (): readonly AgentDescriptor[] | undefined => cachedCatalog
    const tasksStore = createExternalTasksStore(async (sid) => {
      const res = await api.getSessionState(sid)
      if (!res.ok) throw new Error(res.error.message)
      return res.value
    })
    const translate = scope.locale.bind(NS)

    scope.effect(() => scope.slots.inject('conversation.session.panel.environment.row', () => scope.slots.register({
      name: 'conversation.session.panel.environment.row',
      id: 'external-agents-worktree',
      order: 20,
      locale: NS,
      inject: () => ({
        fetchWorkspaceStatus: async (sid: string) => {
          const res = await api.getWorkspaceStatus(sid)
          if (!res.ok) throw new Error(res.error.message)
          return res.value
        },
      }),
    }, WorktreeEnvironmentRow)), 'external-agents: session panel worktree row')

    scope.effect(() => scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock',
      id: 'external-agents-tasks',
      order: 15,
      locale: NS,
      inject: () => ({ store: tasksStore }),
    }, ExternalTasksInputDock)), 'external-agents: running tasks dock')

    scope.effect(() => scope.slots.inject('conversation.session.panel.section', () => scope.slots.register({
      name: 'conversation.session.panel.section',
      id: 'external-tasks',
      order: 210,
      label: () => translate('tasksSectionLabel'),
      locale: NS,
      inject: () => ({ store: tasksStore }),
    }, ExternalTasksPanelSection)), 'external-agents: session panel tasks section')

    scope.effect(() => scope.slots.inject('conversation.session.panel.indicator', () => scope.slots.register({
      name: 'conversation.session.panel.indicator',
      id: 'external-agents-tasks',
      order: 15,
      locale: NS,
      inject: () => ({ store: tasksStore }),
    }, ExternalTasksPanelIndicator)), 'external-agents: session panel tasks indicator')

    scope.effect(() => scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'external-agents-switcher',
      order: 10,
      locale: NS,
      inject: (sessionId: SessionId): AgentSwitcherInjected => {
        const sid = String(sessionId)
        modelFilter.registry.ensureFiltered(sid)
        return {
          sessionId: sid,
          isBlank: () => sessions.list.getSnapshot().byId[sessionId]?.blank !== false,
          subscribeBlank: listener => sessions.list.subscribe(listener),
          fetchCatalog,
          fetchSessionState: async () => {
            const res = await api.getSessionState(sid)
            if (!res.ok) throw new Error(res.error.message)
            modelFilter.registry.set(sid, res.value.agentId)
            return res.value
          },
          selectAgent: async (agentId) => {
            const res = await api.selectSessionAgent({
              sessionId: sid,
              agentId,
            })
            if (!res.ok) throw new Error(res.error.message)
            modelFilter.registry.set(sid, res.value.agentId)
            return res.value
          },
        }
      },
    }, AgentSwitcher)), 'external-agents: composer switcher')

    scope.effect(() => installExternalSlashCommands(scope, {
      getAgentId: sid => modelFilter.registry.get(sid),
      fetchSessionAgentId: async (sid) => {
        const res = await api.getSessionState(sid)
        if (!res.ok) throw new Error(res.error.message)
        modelFilter.registry.set(sid, res.value.agentId)
        return res.value.agentId
      },
      getCachedCatalog: readCachedCatalog,
      fetchCatalog,
      sectionLabel: agent => `${agent.label} ${scope.locale.bind(NS)('slashSectionSuffix')}`,
    }), 'external-agents: slash command source')

    scope.effect(() => scope.slots.inject('conversation.input.permission', () => scope.slots.register({
      name: 'conversation.input.permission',
      priority: -10,
      locale: NS,
      inject: (sessionId: SessionId): PermissionGateInjected => {
        const sid = String(sessionId)
        return {
          getAgentId: () => modelFilter.registry.get(sid),
          subscribeAgent: listener => modelFilter.registry.subscribe(sid, listener),
          getCachedCatalog: readCachedCatalog,
          fetchCatalog,
          fetchSessionState: async () => {
            const res = await api.getSessionState(sid)
            if (!res.ok) throw new Error(res.error.message)
            modelFilter.registry.set(sid, res.value.agentId)
            return res.value
          },
          selectPermission: async (permissionMode) => {
            const res = await api.selectSessionPermission({
              sessionId: sid,
              permissionMode,
            })
            if (!res.ok) throw new Error(res.error.message)
            return res.value
          },
          resolveNativeFallback: (): NativePermissionFallback | undefined => {
            const fallback = scope.slots.entries('conversation.input.permission')
              .find(entry => (entry.options.priority ?? 0) >= 0)
            if (fallback === undefined) return undefined
            const injectFn = fallback.inject as ((id: SessionId) => Record<string, unknown>) | undefined
            const rawInjected = injectFn === undefined ? {} : injectFn(sessionId)
            const injectedProps = bindInjectedHooks(rawInjected)
            const tFn = fallback.locale !== undefined
              ? (scope.locale.bind(fallback.locale as never) as unknown)
              : undefined
            return {
              component: fallback.component as ComponentType<Record<string, unknown>>,
              injectedProps,
              t: tFn,
            }
          },
        }
      },
    }, PermissionGate)), 'external-agents: permission gate')
  })

  return async () => {
    uiScope.dispose()
    modelFilter.dispose()
    disposeLocale()
    await unmountRemote()
  }
}
