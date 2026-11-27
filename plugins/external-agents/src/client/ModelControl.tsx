import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseFillRegular,
  IconDataOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AgentDescriptor,
  ExternalAgentsConfigSnapshot,
  SelectSessionModelInput,
  SessionAgentId,
  SessionAgentState,
} from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'
import { filterExternalModels, resolveActiveModelAndEffort } from './model-picker-core.ts'
import css from './ModelControl.module.css'

export interface ExternalModelControlInjected {
  readonly getAgentId: () => SessionAgentId
  readonly subscribeAgent: (listener: () => void) => () => void
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly subscribeCatalog: (listener: () => void) => () => void
  readonly getCachedState: () => SessionAgentState | undefined
  readonly getCachedConfig: () => ExternalAgentsConfigSnapshot | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly fetchConfig: () => Promise<ExternalAgentsConfigSnapshot>
  readonly fetchSessionState: () => Promise<SessionAgentState>
  readonly selectModel: (input: Omit<SelectSessionModelInput, 'sessionId'>) => Promise<SessionAgentState>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    externalAgents: ExternalAgentsLocaleKey
  }
}

export type ExternalModelControlProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<ExternalModelControlInjected>
  & PropsLocale<'externalAgents'>

function ExternalModelPicker({
  agentId,
  locked,
  getCachedCatalog,
  subscribeCatalog,
  getCachedState,
  subscribeAgent,
  getCachedConfig,
  fetchCatalog,
  fetchConfig,
  fetchSessionState,
  selectModel,
  t,
}: {
  readonly agentId: Exclude<SessionAgentId, 'native'>
  readonly locked: boolean
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly subscribeCatalog: (listener: () => void) => () => void
  readonly getCachedState: () => SessionAgentState | undefined
  readonly subscribeAgent: (listener: () => void) => () => void
  readonly getCachedConfig: () => ExternalAgentsConfigSnapshot | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly fetchConfig: () => Promise<ExternalAgentsConfigSnapshot>
  readonly fetchSessionState: () => Promise<SessionAgentState>
  readonly selectModel: (input: Omit<SelectSessionModelInput, 'sessionId'>) => Promise<SessionAgentState>
  readonly t: ExternalModelControlProps['t']
}) {
  const [catalog, setCatalog] = useState<readonly AgentDescriptor[]>(() => getCachedCatalog() ?? [])
  const [sessionState, setSessionState] = useState<SessionAgentState | null>(() => getCachedState() ?? null)
  const [config, setConfig] = useState<ExternalAgentsConfigSnapshot | undefined>(() => getCachedConfig())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})

  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let active = true
    const syncCatalog = (): void => {
      const next = getCachedCatalog()
      if (active && next !== undefined) setCatalog(next)
    }
    const syncState = (): void => {
      const next = getCachedState()
      if (active && next !== undefined) setSessionState(next)
    }
    syncCatalog()
    syncState()
    const unsubCatalog = subscribeCatalog(syncCatalog)
    const unsubAgent = subscribeAgent(syncState)
    void fetchCatalog().then((items) => {
      if (active) setCatalog(items)
    }).catch(() => {})
    void fetchSessionState().then((state) => {
      if (active) setSessionState(state)
    }).catch(() => {})
    void fetchConfig().then((cfg) => {
      if (active) setConfig(cfg)
    }).catch(() => {})
    return () => {
      active = false
      unsubCatalog()
      unsubAgent()
    }
  }, [agentId, fetchCatalog, fetchConfig, fetchSessionState, getCachedCatalog, getCachedState, subscribeAgent, subscribeCatalog])

  const descriptor = useMemo(
    () => catalog.find(item => item.id === agentId),
    [catalog, agentId],
  )
  const models = descriptor?.models ?? []
  const agentSettings = config?.agents[agentId]
  const resolved = useMemo(
    () => resolveActiveModelAndEffort(descriptor, sessionState, agentSettings),
    [agentSettings, descriptor, sessionState],
  )
  const filteredModels = useMemo(
    () => filterExternalModels(models, query),
    [models, query],
  )
  const showSearch = models.length > 4

  useEffect(() => {
    if (locked && open) setOpen(false)
  }, [locked, open])

  useEffect(() => {
    setHighlighted(0)
  }, [query, open])

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const width = Math.min(356, window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      const bottom = Math.max(8, window.innerHeight - rect.top + 6)
      setPopoverStyle({
        left: `${left}px`,
        bottom: `${bottom}px`,
        width: `${width}px`,
        maxHeight: `${Math.max(180, rect.top - 16)}px`,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, filteredModels.length, resolved.efforts.length])

  useEffect(() => {
    if (!open) return
    const handleOutside = (event: Event): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (rootRef.current?.contains(target) === true) return
      if (popoverRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handleOutside)
    document.addEventListener('mousedown', handleOutside)
    return () => {
      document.removeEventListener('pointerdown', handleOutside)
      document.removeEventListener('mousedown', handleOutside)
    }
  }, [open])

  useEffect(() => {
    if (open && showSearch) {
      queueMicrotask(() => {
        searchRef.current?.focus()
      })
    }
  }, [open, showSearch])

  const commitModel = (modelId: string): void => {
    if (busy || locked) return
    setOpen(false)
    if (modelId === resolved.modelId) return
    setBusy(true)
    setError(null)
    void selectModel({ model: modelId }).then((next) => {
      setSessionState(next)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setOpen(true)
    }).finally(() => {
      setBusy(false)
    })
  }

  const commitEffort = (effortId: string | null): void => {
    if (busy || locked) return
    if ((effortId ?? undefined) === resolved.effortId) return
    setBusy(true)
    setError(null)
    void selectModel({ reasoningEffort: effortId }).then((next) => {
      setSessionState(next)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setBusy(false)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || !open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' && filteredModels.length > 0) {
      event.preventDefault()
      setHighlighted(prev => (prev + 1) % filteredModels.length)
      return
    }
    if (event.key === 'ArrowUp' && filteredModels.length > 0) {
      event.preventDefault()
      setHighlighted(prev => (prev - 1 + filteredModels.length) % filteredModels.length)
      return
    }
    if (event.key === 'Enter' && event.target === searchRef.current && filteredModels.length > 0) {
      event.preventDefault()
      const chosen = filteredModels[Math.min(highlighted, filteredModels.length - 1)]
      if (chosen !== undefined) commitModel(chosen.id)
    }
  }

  return (
    <div ref={rootRef} className={css.root} data-ext-agent-control="" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        disabled={locked}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('modelPickerAria')}
        title={resolved.effortLabel === undefined ? resolved.modelLabel : `${resolved.modelLabel} · ${resolved.effortLabel}`}
        onClick={() => {
          if (locked) return
          setError(null)
          setQuery('')
          setOpen(prev => !prev)
          if (!open) {
            void fetchCatalog().then(setCatalog).catch(() => {})
            void fetchConfig().then(setConfig).catch(() => {})
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{resolved.modelLabel}</span>
        {resolved.effortLabel !== undefined && (
          <span className={css.triggerEffort}>{resolved.effortLabel}</span>
        )}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />}
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className={css.popover}
          style={popoverStyle}
          role="dialog"
          aria-label={t('modelPickerAria')}
          onMouseDown={(event) => {
            if (event.target instanceof Element && event.target.closest('button') !== null) {
              event.preventDefault()
            }
          }}
        >
          {resolved.efforts.length > 0 && (
            <>
              <div className={css.section}>
                <div className={css.sectionHeader}>
                  <span className={css.sectionTitle}>{t('modelEffortSection')}</span>
                  <span className={css.sectionMeta}>
                    {resolved.effortLabel ?? t('modelEffortDefault')}
                  </span>
                </div>
                <div className={css.effortStrip} role="radiogroup" aria-label={t('modelEffortSection')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={resolved.effortId === undefined}
                    className={resolved.effortId === undefined ? `${css.effortPill} ${css.effortPillActive}` : css.effortPill}
                    disabled={busy}
                    onClick={() => commitEffort(null)}
                  >
                    {t('modelEffortDefault')}
                  </button>
                  {resolved.efforts.map((effort) => {
                    const active = resolved.effortId === effort.id
                    return (
                      <button
                        key={effort.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={active ? `${css.effortPill} ${css.effortPillActive}` : css.effortPill}
                        disabled={busy}
                        title={effort.description}
                        onClick={() => commitEffort(effort.id)}
                      >
                        {effort.name}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className={css.divider} />
            </>
          )}

          <div className={css.section}>
            <div className={css.sectionHeader}>
              <span className={css.sectionTitle}>{t('modelSectionLabel')}</span>
              <span className={css.sectionMeta}>
                {agentId === 'cursor' && resolved.efforts.length === 0
                  ? t('modelParameterizedEffortHint')
                  : descriptor?.label}
              </span>
            </div>

            {showSearch && (
              <div className={css.searchRow}>
                <input
                  ref={searchRef}
                  type="text"
                  className={css.searchInput}
                  placeholder={t('modelSearchPlaceholder')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('modelSearchClear')}
                    onClick={() => {
                      setQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>
            )}

            <div className={css.modelList} role="listbox" aria-label={t('modelSectionLabel')}>
              {filteredModels.length === 0
                ? <div className={css.empty}>{t('modelEmpty')}</div>
                : filteredModels.map((item, idx) => {
                  const selected = item.id === resolved.modelId
                  const isHighlighted = idx === highlighted
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={[
                        css.modelOption,
                        selected ? css.modelOptionActive : '',
                        isHighlighted ? css.modelOptionHighlighted : '',
                      ].filter(Boolean).join(' ')}
                      disabled={busy}
                      onMouseEnter={() => setHighlighted(idx)}
                      onClick={() => commitModel(item.id)}
                    >
                      <span className={css.modelOptionCopy}>
                        <span className={css.modelName}>
                          {item.id === 'default' ? t('modelDefaultLabel') : item.name}
                        </span>
                        {item.id !== 'default' && item.name !== item.id && (
                          <span className={css.modelId}>{item.id}</span>
                        )}
                      </span>
                      {selected && (
                        <span className={css.checkIcon}>
                          <IconCheckOutlineRegular />
                        </span>
                      )}
                    </button>
                  )
                })}
            </div>
          </div>

          {error !== null && (
            <div className={css.errorBanner} role="alert">{error}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

export function ExternalModelControl(props: ExternalModelControlProps) {
  const {
    useProjection,
    getAgentId,
    subscribeAgent,
    getCachedCatalog,
    subscribeCatalog,
    getCachedState,
    getCachedConfig,
    fetchCatalog,
    fetchConfig,
    fetchSessionState,
    selectModel,
    t,
  } = props

  const preset = useProjection('agentPreset')
  const [agentId, setAgentId] = useState<SessionAgentId>(() => getAgentId())
  const markerRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let active = true
    setAgentId(getAgentId())
    const unsub = subscribeAgent(() => {
      setAgentId(getAgentId())
    })
    void fetchSessionState().then((state) => {
      if (active) setAgentId(state.agentId)
    }).catch(() => {})
    return () => {
      active = false
      unsub()
    }
  }, [fetchSessionState, getAgentId, subscribeAgent, preset])

  // Hide the adjacent native ModelSelect seat inside composer `.standardControls`
  // whenever this session is bound to an external CLI so native sessions retain
  // unmodified `ModelSelect` + child slot rendering (`label` / `options` / `pane`).
  useLayoutEffect(() => {
    const marker = markerRef.current
    if (marker === null) return

    const findStandardControls = (): HTMLElement | null => {
      let cur: HTMLElement | null = marker.parentElement
      for (let depth = 0; cur !== null && depth < 4; depth += 1) {
        if (cur.querySelector('[data-ext-agent-control]') !== null && cur.parentElement !== null) {
          // Stop at the first ancestor that holds multiple slot controls (i.e. `.standardControls`),
          // ensuring we don't walk all the way up to `.row` where `.modes` / `PermissionControl` sits.
          const hasNonExtMenu = Array.from(cur.querySelectorAll('button[aria-haspopup="menu"]'))
            .some(btn => btn.closest('[data-ext-agent-control]') === null)
          if (hasNonExtMenu) return cur
        }
        cur = cur.parentElement
      }
      return null
    }

    const syncNativeSeatVisibility = (): void => {
      const container = findStandardControls()
      if (container === null) return
      const hideNative = agentId !== 'native'
      for (const btn of Array.from(container.querySelectorAll('button[aria-haspopup="menu"]'))) {
        if (btn.closest('[data-ext-agent-control]') !== null) continue
        const seat = btn.parentElement
        if (seat instanceof HTMLElement) {
          seat.hidden = hideNative
          seat.style.display = hideNative ? 'none' : ''
        }
      }
    }

    syncNativeSeatVisibility()
    const container = findStandardControls() ?? marker.parentElement?.parentElement ?? null
    const observer = container != null && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { syncNativeSeatVisibility() })
      : null
    observer?.observe(container!, { childList: true, subtree: true })

    return () => {
      observer?.disconnect()
      const restoreContainer = findStandardControls()
      if (restoreContainer === null) return
      for (const btn of Array.from(restoreContainer.querySelectorAll('button[aria-haspopup="menu"]'))) {
        if (btn.closest('[data-ext-agent-control]') !== null) continue
        const seat = btn.parentElement
        if (seat instanceof HTMLElement) {
          seat.hidden = false
          seat.style.display = ''
        }
      }
    }
  }, [agentId])

  if (agentId === 'native') {
    return <span ref={markerRef} style={{ display: 'none' }} aria-hidden />
  }

  return (
    <>
      <span ref={markerRef} style={{ display: 'none' }} aria-hidden />
      <ExternalModelPicker
        agentId={agentId}
        locked={false}
        getCachedCatalog={getCachedCatalog}
        subscribeCatalog={subscribeCatalog}
        getCachedState={getCachedState}
        subscribeAgent={subscribeAgent}
        getCachedConfig={getCachedConfig}
        fetchCatalog={fetchCatalog}
        fetchConfig={fetchConfig}
        fetchSessionState={fetchSessionState}
        selectModel={selectModel}
        t={t}
      />
    </>
  )
}
