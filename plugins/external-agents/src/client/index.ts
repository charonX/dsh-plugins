import { useSyncExternalStore, type ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDescriptor, ExternalAgentId, ExternalAgentsConfigSnapshot } from '../types.ts'
import remote from '../remote.ts'
import { AgentSwitcher, type AgentSwitcherInjected } from './AgentSwitcher.tsx'
import {
  ExternalAgentsSettings,
  ExternalAgentsSettingsIcon,
  type ExternalAgentsSettingsInjected,
} from './ExternalAgentsSettings.tsx'
import {
  ExternalTasksInputDock,
  ExternalTasksPanelIndicator,
  ExternalTasksPanelSection,
  createExternalTasksStore,
} from './ExternalTasksUi.tsx'
import {
  ExternalModelControl,
  type ExternalModelControlInjected,
} from './ModelControl.tsx'
import {
  PermissionGate,
  type NativePermissionFallback,
  type PermissionGateInjected,
} from './PermissionControl.tsx'
import { ClientSessionAgentStore } from './session-agent-store.ts'
import { WorktreeEnvironmentRow } from './WorktreeEnvironmentRow.tsx'
import { en, NS, zh } from './locales.ts'
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
  const agentStore = new ClientSessionAgentStore()

  const uiScope = ctx.inject(['remote.externalAgents', 'slots', 'sessions', 'locale'], (scope) => {
    const api = scope.remote.externalAgents
    const sessions = scope.sessions
    let cachedConfig: ExternalAgentsConfigSnapshot | undefined

    const fetchCatalog = async (): Promise<readonly AgentDescriptor[]> => {
      const res = await api.getCatalog()
      if (!res.ok) throw new Error(res.error.message)
      agentStore.setCatalog(res.value.agents)
      return res.value.agents
    }
    const refreshQuota = async (agentId?: ExternalAgentId): Promise<readonly AgentDescriptor[]> => {
      const res = await api.refreshQuota(agentId === undefined ? {} : { agentId })
      if (!res.ok) throw new Error(res.error.message)
      agentStore.setCatalog(res.value.agents)
      return res.value.agents
    }
    const fetchConfig = async (): Promise<ExternalAgentsConfigSnapshot> => {
      const res = await api.getConfig()
      if (!res.ok) throw new Error(res.error.message)
      cachedConfig = res.value
      return res.value
    }
    const updateConfig: ExternalAgentsSettingsInjected['updateConfig'] = async (input) => {
      const res = await api.updateConfig(input)
      if (!res.ok) throw new Error(res.error.message)
      cachedConfig = res.value
      return res.value
    }
    const tasksStore = createExternalTasksStore(async (sid) => {
      const res = await api.getSessionState(sid)
      if (!res.ok) throw new Error(res.error.message)
      agentStore.setSessionState(res.value)
      return res.value
    })
    const translate = scope.locale.bind(NS)

    scope.effect(() => scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'external-agents',
      order: 75,
      label: () => translate('settingsNavLabel'),
      locale: NS,
      inject: (): ExternalAgentsSettingsInjected => ({
        fetchCatalog,
        refreshQuota,
        fetchConfig,
        updateConfig,
      }),
    }, ExternalAgentsSettings)), 'external-agents: settings section')

    scope.effect(() => scope.slots.inject('settings.section.icon', () => scope.slots.register({
      name: 'settings.section.icon',
      id: 'external-agents',
    }, ExternalAgentsSettingsIcon)), 'external-agents: settings section icon')

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
        return {
          sessionId: sid,
          isBlank: () => sessions.list.getSnapshot().byId[sessionId]?.blank !== false,
          subscribeBlank: listener => sessions.list.subscribe(listener),
          getCachedCatalog: () => agentStore.getCachedCatalog(),
          subscribeCatalog: listener => agentStore.subscribeCatalog(listener),
          getCachedState: () => agentStore.getSessionState(sid),
          subscribeState: listener => agentStore.subscribeSession(sid, listener),
          fetchCatalog,
          fetchSessionState: async () => {
            const res = await api.getSessionState(sid)
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
            return res.value
          },
          selectAgent: async (agentId) => {
            const res = await api.selectSessionAgent({
              sessionId: sid,
              agentId,
            })
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
            return res.value
          },
        }
      },
    }, AgentSwitcher)), 'external-agents: composer switcher')

    scope.effect(() => scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'external-agents-model',
      order: 20,
      locale: NS,
      inject: (sessionId: SessionId): ExternalModelControlInjected => {
        const sid = String(sessionId)
        return {
          getAgentId: () => agentStore.getAgentId(sid),
          subscribeAgent: listener => agentStore.subscribeSession(sid, listener),
          getCachedCatalog: () => agentStore.getCachedCatalog(),
          subscribeCatalog: listener => agentStore.subscribeCatalog(listener),
          getCachedState: () => agentStore.getSessionState(sid),
          getCachedConfig: () => cachedConfig,
          fetchCatalog,
          fetchConfig,
          fetchSessionState: async () => {
            const res = await api.getSessionState(sid)
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
            return res.value
          },
          selectModel: async (input) => {
            const res = await api.selectSessionModel({
              sessionId: sid,
              ...input,
            })
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
            return res.value
          },
        }
      },
    }, ExternalModelControl)), 'external-agents: composer model picker')

    scope.effect(() => installExternalSlashCommands(scope, {
      getAgentId: sid => agentStore.getAgentId(sid),
      fetchSessionAgentId: async (sid) => {
        const res = await api.getSessionState(sid)
        if (!res.ok) throw new Error(res.error.message)
        agentStore.setSessionState(res.value)
        return res.value.agentId
      },
      getCachedCatalog: () => agentStore.getCachedCatalog(),
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
          getAgentId: () => agentStore.getAgentId(sid),
          subscribeAgent: listener => agentStore.subscribeSession(sid, listener),
          getCachedCatalog: () => agentStore.getCachedCatalog(),
          fetchCatalog,
          fetchSessionState: async () => {
            const res = await api.getSessionState(sid)
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
            return res.value
          },
          selectPermission: async (permissionMode) => {
            const res = await api.selectSessionPermission({
              sessionId: sid,
              permissionMode,
            })
            if (!res.ok) throw new Error(res.error.message)
            agentStore.setSessionState(res.value)
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
    agentStore.dispose()
    disposeLocale()
    await unmountRemote()
  }
}
