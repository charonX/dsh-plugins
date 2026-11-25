import { useEffect, useMemo, useState } from 'react'
import {
  IconAgentPresetOutlineRegular,
  IconChevronDownOutlineRegular,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentDescriptor, SessionAgentId, SessionAgentState } from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'
import css from './AgentSwitcher.module.css'

export interface AgentSwitcherInjected {
  readonly sessionId: string
  readonly isBlank: () => boolean
  readonly subscribeBlank: (listener: () => void) => () => void
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly fetchSessionState: () => Promise<SessionAgentState>
  readonly selectAgent: (agentId: SessionAgentId) => Promise<SessionAgentState>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    externalAgents: ExternalAgentsLocaleKey
  }
}

export type AgentSwitcherProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<AgentSwitcherInjected>
  & PropsLocale<'externalAgents'>

const COMPACT_LABELS: Record<SessionAgentId, string> = {
  native: 'Native',
  agy: 'Antigravity',
  'claude-code': 'Claude',
  pi: 'Pi',
  codex: 'Codex',
}

export function AgentSwitcher({
  useProjection,
  isBlank,
  subscribeBlank,
  fetchCatalog,
  fetchSessionState,
  selectAgent,
  t,
}: AgentSwitcherProps) {
  const preset = useProjection('agentPreset')
  const [blank, setBlank] = useState<boolean>(() => isBlank())
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>([])
  const [sessionState, setSessionState] = useState<SessionAgentState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBlank(isBlank())
    return subscribeBlank(() => {
      setBlank(isBlank())
    })
  }, [isBlank, subscribeBlank])

  useEffect(() => {
    let active = true
    void fetchCatalog().then((items) => {
      if (active) setAgents(items)
    }).catch(() => {})
    void fetchSessionState().then((state) => {
      if (active) setSessionState(state)
    }).catch(() => {})
    return () => {
      active = false
    }
  }, [fetchCatalog, fetchSessionState, preset, blank])

  const activeAgentId: SessionAgentId = (() => {
    if (sessionState !== null) return sessionState.agentId
    if (typeof preset === 'string' && preset.startsWith('ext-')) {
      const candidate = preset.slice(4)
      if (candidate === 'agy' || candidate === 'claude-code' || candidate === 'pi' || candidate === 'codex') {
        return candidate
      }
    }
    return 'native'
  })()

  const locked = !blank || sessionState?.locked === true

  useEffect(() => {
    if (locked && open) setOpen(false)
  }, [locked, open])

  const catalogList = agents.length > 0
    ? agents
    : [{ id: 'native', label: t('nativeName'), command: '', available: true, models: [], permissionModes: [], commands: [] } satisfies AgentDescriptor]

  const items: MenuEntry[] = useMemo(() => {
    const entries: MenuEntry[] = catalogList.map(item => ({
      id: item.id,
      disabled: !item.available || busy || locked,
      label: (
        <span className={css.optionLabel}>
          <span className={css.optionLabelText}>{item.label}</span>
          {!item.available ? <span className={css.optionMeta}>{t('unavailable')}</span> : null}
        </span>
      ),
    }))
    if (error !== null) {
      entries.push({ type: 'separator', id: 'ext-agents-error-sep' })
      entries.push({ type: 'label', id: 'ext-agents-error', text: error })
    }
    return entries
  }, [busy, catalogList, error, locked, t])

  const handleSelect = (id: string): void => {
    const agentId = id as SessionAgentId
    if (locked || busy) return
    setOpen(false)
    if (agentId === activeAgentId) return
    setBusy(true)
    setError(null)
    void selectAgent(agentId).then((next) => {
      setSessionState(next)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setOpen(true)
    }).finally(() => {
      setBusy(false)
    })
  }

  const label = COMPACT_LABELS[activeAgentId]

  return (
    <div className={css.root}>
      <Menu
        open={open}
        items={items}
        selectedId={activeAgentId}
        onSelect={handleSelect}
        onClose={() => { setOpen(false) }}
        side="top"
        align="end"
        portal
        anchor={
          <button
            type="button"
            className={css.trigger}
            disabled={locked || busy}
            title={locked ? t('lockedHint') : t('switchHint')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => {
              if (locked || busy) return
              setError(null)
              setOpen(prev => !prev)
              void fetchCatalog().then(setAgents).catch(() => {})
            }}
          >
            <span className={css.triggerIcon} aria-hidden>
              <IconAgentPresetOutlineRegular />
            </span>
            <span className={css.triggerLabel}>{busy ? t('switching') : label}</span>
            {locked
              ? <span className={css.lockedTag}>{t('lockedBadge')}</span>
              : (
                <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden>
                  <IconChevronDownOutlineRegular />
                </span>
              )}
          </button>
        }
      />
    </div>
  )
}
