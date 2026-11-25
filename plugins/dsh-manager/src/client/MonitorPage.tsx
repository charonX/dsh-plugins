/** Runtime monitoring page: persistent Steward status strip above Eval records and Steward activity sub-views. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, SegmentedControl, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { EvalRecordsPage } from './EvalRecordsPage.tsx'
import type { EvalsInjected } from './evals-source.ts'
import type { StewardInjected, StewardSnapshot } from './steward-source.ts'
import css from './MonitorPage.module.css'

export type MonitorSubView = 'evals' | 'activity'

export type MonitorPageProps = PropsRuntime<'main'>
  & InjectFace<StewardInjected & EvalsInjected>
  & PropsLocale<'dshManager'>

/** Render the Steward status strip and switch between Eval records and Steward activity. */
export function MonitorPage(props: MonitorPageProps) {
  const { useSteward, onStewardRetry, t } = props
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
          : <StewardActivityFeed snapshot={stewardSnapshot} t={t} />}
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
function StewardActivityFeed({ snapshot, t }: {
  snapshot: StewardSnapshot
  t: TranslateNS<'dshManager'>
}) {
  if (snapshot.status === 'error') {
    return null
  }
  if (snapshot.status === 'loading' || snapshot.steward === undefined) {
    return <p className={css.empty}>{t('steward.loading')}</p>
  }
  const { activity } = snapshot.steward
  return (
    <section className={css.feedSection} aria-label={t('steward.feed.title')}>
      <h2 className={css.feedTitle}>{t('steward.feed.title')}</h2>
      {activity.length === 0
        ? <p className={css.empty}>{t('steward.feed.empty')}</p>
        : (
          <ul className={css.feed}>
            {activity.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className={css.entry}>
                <span className={css.entryTime}>{new Date(entry.at).toLocaleString()}</span>
                <span className={css.entryKind}>
                  <span className={css.badge} data-kind={entry.kind}>{t(`steward.kind.${entry.kind}`)}</span>
                </span>
                <span className={css.entryText}>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
