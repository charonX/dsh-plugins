/** Runtime monitoring page: persistent Steward status strip above Eval records and Steward activity sub-views. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { EvalRecordsPage } from './EvalRecordsPage.tsx'
import type { EvalsInjected } from './evals-source.ts'
import type { StewardPromptView } from '../evals/wire-types.ts'
import type { StewardInjected, StewardSnapshot } from './steward-source.ts'
import css from './MonitorPage.module.css'

export type MonitorSubView = 'evals' | 'activity'

export type MonitorPageProps = PropsRuntime<'main'>
  & InjectFace<StewardInjected & EvalsInjected>
  & PropsLocale<'dshManager'>

/** Render the Steward status strip and switch between Eval records and Steward activity. */
export function MonitorPage(props: MonitorPageProps) {
  const { useSteward, onStewardRetry, onStewardPrompt, t } = props
  const stewardSnapshot = useSteward(snapshot => snapshot)
  const [subView, setSubView] = useState<MonitorSubView>('evals')

  return (
    <div className={css.page}>
      <StewardStatusStrip snapshot={stewardSnapshot} onRetry={onStewardRetry} t={t} />
      <div className={css.subNav}>
        <SegmentedControl<MonitorSubView>
          id="dsh-monitor-view"
          value={subView}
          onChange={setSubView}
          label={t('monitor.panel')}
          options={[
            { value: 'evals', label: t('monitor.view.evals') },
            { value: 'activity', label: t('monitor.view.activity') },
          ]}
        />
      </div>
      <div
        id={`dsh-monitor-view-${subView}-panel`}
        className={css.panel}
        role="tabpanel"
        aria-labelledby={`dsh-monitor-view-${subView}`}
      >
        {subView === 'evals'
          ? <EvalRecordsPage {...props} variant="embedded" />
          : <StewardActivityFeed snapshot={stewardSnapshot} onStewardPrompt={onStewardPrompt} t={t} />}
      </div>
    </div>
  )
}

/** Compact always-visible Steward status bar; errors degrade inline without blocking Eval records below. */
function StewardStatusStrip({ snapshot, onRetry, t }: {
  snapshot: StewardSnapshot
  onRetry: () => void
  t: TranslateNS<'dshManager'>
}) {
  if (snapshot.status === 'error') {
    return (
      <div className={css.statusCard}>
        <span className={css.statusError}>{t('steward.error')}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>{t('steward.retry')}</Button>
      </div>
    )
  }
  if (snapshot.status === 'loading' || snapshot.steward === undefined) {
    return (
      <div className={css.statusCard}>
        <span className={css.statusState}>{t('steward.loading')}</span>
      </div>
    )
  }
  const steward = snapshot.steward
  return (
    <div className={css.statusCard}>
      <span className={css.statusState}>
        <StateDot state={steward.busy ? 'ongoing' : 'idle'} />
        {steward.busy ? t('steward.busy') : t('steward.idle')}
      </span>
      <span className={css.statusMeta}>
        <span>{t('steward.mode')}: {t(`steward.mode.${steward.mode}`)}</span>
        <span>{t('steward.backlog')}: {steward.backlog}</span>
      </span>
    </div>
  )
}

/** Chronological Steward activity timeline (newest first). */
function StewardActivityFeed({ snapshot, onStewardPrompt, t }: {
  snapshot: StewardSnapshot
  onStewardPrompt?: ((promptId: string) => Promise<StewardPromptView | undefined>) | undefined
  t: TranslateNS<'dshManager'>
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [promptsById, setPromptsById] = useState<Record<string, StewardPromptView | null>>({})
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({})
  const [errorIds, setErrorIds] = useState<Record<string, boolean>>({})

  if (snapshot.status === 'error') {
    return null
  }
  if (snapshot.status === 'loading' || snapshot.steward === undefined) {
    return <p className={css.empty}>{t('steward.loading')}</p>
  }
  const { activity } = snapshot.steward

  const togglePrompt = (promptId: string): void => {
    const nextOpen = !expanded[promptId]
    setExpanded(prev => ({ ...prev, [promptId]: nextOpen }))
    if (!nextOpen || promptsById[promptId] !== undefined || onStewardPrompt === undefined || loadingIds[promptId] === true) {
      return
    }
    setErrorIds(prev => ({ ...prev, [promptId]: false }))
    setLoadingIds(prev => ({ ...prev, [promptId]: true }))
    void onStewardPrompt(promptId)
      .then((prompt) => {
        setPromptsById(prev => ({ ...prev, [promptId]: prompt ?? null }))
      })
      .catch(() => {
        setErrorIds(prev => ({ ...prev, [promptId]: true }))
      })
      .finally(() => {
        setLoadingIds(prev => ({ ...prev, [promptId]: false }))
      })
  }

  return (
    <section className={css.feedSection} aria-label={t('steward.feed.title')}>
      <h2 className={css.feedTitle}>{t('steward.feed.title')}</h2>
      {activity.length === 0
        ? <p className={css.empty}>{t('steward.feed.empty')}</p>
        : (
          <ul className={css.feed}>
            {activity.map((entry, index) => {
              const promptId = entry.promptId
              const isOpen = promptId !== undefined && expanded[promptId] === true
              const loaded = promptId === undefined ? undefined : promptsById[promptId]
              const isLoading = promptId !== undefined && loadingIds[promptId] === true
              return (
                <li key={`${entry.at}-${index}`} className={css.entry}>
                  <div className={css.entryRow}>
                    <span className={css.entryTime}>{new Date(entry.at).toLocaleString()}</span>
                    <span className={css.entryKind}>
                      <span className={css.badge} data-kind={entry.kind}>{t(`steward.kind.${entry.kind}`)}</span>
                    </span>
                    <span className={css.entryText}>{entry.text}</span>
                    {promptId !== undefined && onStewardPrompt !== undefined
                      ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { togglePrompt(promptId) }}
                        >
                          {isOpen ? t('steward.feed.prompt.hide') : t('steward.feed.prompt.view')}
                        </Button>
                      )
                      : null}
                  </div>
                  {isOpen && promptId !== undefined
                    ? (
                      <div className={css.entryPromptBox}>
                        {isLoading
                          ? <span className={css.empty}>{t('steward.feed.prompt.loading')}</span>
                          : errorIds[promptId] === true
                            ? <span className={css.empty}>{t('steward.error')}</span>
                            : loaded === null || loaded === undefined
                              ? <span className={css.empty}>{t('steward.feed.prompt.expired')}</span>
                            : (
                              <>
                                <div className={css.entryPromptMeta}>
                                  <span>{loaded.turnId}</span>
                                  <span>{t('board.detail.dispatch.prompt.revision', { rev: loaded.templateRevision })}</span>
                                  {loaded.truncated
                                    ? <Tag tone="warning">{t('board.detail.dispatch.prompt.truncated')}</Tag>
                                    : null}
                                </div>
                                <pre className={css.entryPromptPre}>{loaded.text}</pre>
                              </>
                            )}
                      </div>
                    )
                    : null}
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
