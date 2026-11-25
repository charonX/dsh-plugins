import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  Menu,
  PermissionIconAutoReviewMedium,
  PermissionIconAutoReviewRegular,
  PermissionIconFullAccessMedium,
  PermissionIconFullAccessRegular,
  PermissionIconReadOnlyMedium,
  PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteMedium,
  PermissionIconWorkspaceWriteRegular,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentDescriptor, SessionAgentId, SessionAgentState } from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'
import css from './AgentSwitcher.module.css'

export interface NativePermissionFallback {
  readonly component: ComponentType<Record<string, unknown>>
  readonly injectedProps: Record<string, unknown>
  readonly t: unknown
}

export interface PermissionGateInjected {
  readonly getAgentId: () => SessionAgentId
  readonly subscribeAgent: (listener: () => void) => () => void
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly fetchSessionState: () => Promise<SessionAgentState>
  readonly selectPermission: (mode: string) => Promise<SessionAgentState>
  readonly resolveNativeFallback: () => NativePermissionFallback | undefined
}

export type PermissionGateProps =
  PropsRuntime<'conversation.input.permission'>
  & InjectFace<PermissionGateInjected>
  & PropsLocale<'externalAgents'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    externalAgents: ExternalAgentsLocaleKey
  }
}

function externalPermissionGlyph(modeId: string, surface: 'trigger' | 'menu'): ReactNode {
  if (modeId === 'read-only' || modeId === 'plan' || modeId === 'dontAsk') {
    return surface === 'trigger' ? <PermissionIconReadOnlyMedium /> : <PermissionIconReadOnlyRegular />
  }
  if (modeId === 'bypass' || modeId === 'bypassPermissions' || modeId === 'danger-full-access') {
    return surface === 'trigger' ? <PermissionIconFullAccessMedium /> : <PermissionIconFullAccessRegular />
  }
  if (modeId === 'auto' || modeId === 'default') {
    return surface === 'trigger' ? <PermissionIconAutoReviewMedium /> : <PermissionIconAutoReviewRegular />
  }
  return surface === 'trigger' ? <PermissionIconWorkspaceWriteMedium /> : <PermissionIconWorkspaceWriteRegular />
}

function NativePermissionPassthrough({
  fallback,
  runtimeProps,
}: {
  readonly fallback: NativePermissionFallback
  readonly runtimeProps: Record<string, unknown>
}) {
  const Component = fallback.component
  return <Component {...runtimeProps} {...fallback.injectedProps} t={fallback.t} />
}

function ExternalPermissionControl({
  agentId,
  locked,
  getCachedCatalog,
  fetchCatalog,
  fetchSessionState,
  selectPermission,
  t,
}: {
  readonly agentId: Exclude<SessionAgentId, 'native'>
  readonly locked: boolean
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly fetchSessionState: () => Promise<SessionAgentState>
  readonly selectPermission: (mode: string) => Promise<SessionAgentState>
  readonly t: PermissionGateProps['t']
}) {
  const [descriptor, setDescriptor] = useState<AgentDescriptor | undefined>(() =>
    getCachedCatalog()?.find(item => item.id === agentId))
  const [currentMode, setCurrentMode] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void fetchCatalog().then((items) => {
      if (active) setDescriptor(items.find(item => item.id === agentId))
    }).catch(() => {})
    void fetchSessionState().then((state) => {
      if (active) setCurrentMode(state.permissionMode)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [agentId, fetchCatalog, fetchSessionState])

  useEffect(() => {
    if (locked && open) setOpen(false)
  }, [locked, open])

  const modes = descriptor?.permissionModes ?? []
  const effectiveId = currentMode ?? descriptor?.defaultPermissionMode ?? modes[0]?.id ?? ''
  const activeOption = modes.find(m => m.id === effectiveId) ?? modes[0]

  const items: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = modes.map(option => ({
      id: option.id,
      disabled: busy || locked,
      icon: externalPermissionGlyph(option.id, 'menu'),
      label: option.name,
    }))
    if (error !== null) {
      entries.push({ type: 'separator', id: 'ext-perm-error-sep' })
      entries.push({ type: 'label', id: 'ext-perm-error', text: error })
    }
    return entries
  }, [busy, error, locked, modes])

  if (descriptor !== undefined && modes.length === 0) {
    return (
      <span className={css.staticPill} title={t('permissionNoModesHint')}>
        <span className={css.triggerIcon} aria-hidden>
          <PermissionIconReadOnlyMedium />
        </span>
        <span className={css.triggerLabel}>{t('permissionNoModes')}</span>
      </span>
    )
  }

  if (modes.length === 0) {
    return null
  }

  const handleSelect = (modeId: string): void => {
    if (busy || locked) return
    setOpen(false)
    if (modeId === effectiveId) return
    setBusy(true)
    setError(null)
    void selectPermission(modeId).then((next) => {
      setCurrentMode(next.permissionMode ?? modeId)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setOpen(true)
    }).finally(() => {
      setBusy(false)
    })
  }

  return (
    <Menu
      open={open}
      items={items}
      selectedId={effectiveId}
      onSelect={handleSelect}
      onClose={() => { setOpen(false) }}
      side="top"
      portal
      anchor={
        <button
          type="button"
          className={`${css.trigger} ${css.triggerLeft}`}
          disabled={locked || busy}
          title={activeOption?.description}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            if (locked || busy) return
            setError(null)
            setOpen(prev => !prev)
          }}
        >
          <span className={css.triggerIcon} aria-hidden>
            {externalPermissionGlyph(effectiveId, 'trigger')}
          </span>
          <span className={css.triggerLabel}>
            {activeOption?.name ?? t('permissionLabel')}
          </span>
          <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden>
            <IconChevronDownOutlineRegular />
          </span>
        </button>
      }
    />
  )
}

export function PermissionGate(props: PermissionGateProps) {
  const {
    locked,
    useProjection,
    getAgentId,
    subscribeAgent,
    getCachedCatalog,
    fetchCatalog,
    fetchSessionState,
    selectPermission,
    resolveNativeFallback,
    t,
  } = props

  const preset = useProjection('agentPreset')
  const [agentId, setAgentId] = useState<SessionAgentId>(() => getAgentId())

  useEffect(() => {
    setAgentId(getAgentId())
    return subscribeAgent(() => {
      setAgentId(getAgentId())
    })
  }, [getAgentId, subscribeAgent, preset])

  if (agentId === 'native') {
    const fallback = resolveNativeFallback()
    if (fallback === undefined) return null
    const runtimeProps: Record<string, unknown> = {
      locked: props.locked,
      useProjection: props.useProjection,
    }
    return <NativePermissionPassthrough fallback={fallback} runtimeProps={runtimeProps} />
  }

  return (
    <ExternalPermissionControl
      agentId={agentId}
      locked={locked}
      getCachedCatalog={getCachedCatalog}
      fetchCatalog={fetchCatalog}
      fetchSessionState={fetchSessionState}
      selectPermission={selectPermission}
      t={t}
    />
  )
}
