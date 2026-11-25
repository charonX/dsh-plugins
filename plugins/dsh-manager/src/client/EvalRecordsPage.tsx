/** The eval records browse page occupying a main panel. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ConnectionView } from '../connections/wire-types.ts'
import { DECISION_ACTIONS, type DecisionAction, type EvalRecordView } from '../evals/wire-types.ts'
import type { EvalsInjected } from './evals-source.ts'
import { DshSelect } from './DshSelect.tsx'
import { hasExternalUrl } from './url.ts'
import css from './EvalRecordsPage.module.css'


/** Eval records page props derived from the framework and the injected source. */
export type EvalRecordsPageProps = PropsRuntime<'main'> & InjectFace<EvalsInjected> & PropsLocale<'dshManager'> & {
  /** `embedded` drops the page padding so the eval page can stack sections. */
  readonly variant?: 'page' | 'embedded'
}

/** Render the eval records with decision-type and source filters. */
export function EvalRecordsPage(props: EvalRecordsPageProps) {
  const { useEvals, onEvalFilter, onEvalsRetry, t, variant = 'page' } = props
  const snapshot = useEvals(snapshot => snapshot)

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('records.error')}</p>
        <button type="button" className={css.retry} onClick={onEvalsRetry}>{t('records.retry')}</button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('records.loading')}</div>
  }
  const evals = snapshot.evals ?? []
  const connections = snapshot.connections ?? []

  const changeAction = (value: string): void => {
    onEvalFilter({ ...(value === '' ? {} : { action: value as DecisionAction }), ...(snapshot.connectionId === undefined ? {} : { connectionId: snapshot.connectionId }) })
  }
  const changeConnection = (value: string): void => {
    onEvalFilter({ ...(snapshot.action === undefined ? {} : { action: snapshot.action }), ...(value === '' ? {} : { connectionId: value }) })
  }

  return (
    <div className={variant === 'embedded' ? css.embedded : css.page}>
      <div className={css.filterRow}>
        <label className={css.field}>
          <span>{t('records.filter.action')}</span>
          <DshSelect
            value={snapshot.action ?? ''}
            options={[
              { value: '', label: t('records.filter.all') },
              ...DECISION_ACTIONS.map(action => ({ value: action, label: t(`records.action.${action}`) })),
            ]}
            onChange={changeAction}
          />
        </label>
        <label className={css.field}>
          <span>{t('records.filter.connection')}</span>
          <DshSelect
            value={snapshot.connectionId ?? ''}
            options={[
              { value: '', label: t('records.filter.all') },
              ...connections.map(connection => ({ value: connection.id, label: connection.name })),
            ]}
            onChange={changeConnection}
          />
        </label>
      </div>
      {evals.length === 0 ? <p className={css.emptyInline}>{t('records.empty')}</p> : null}
      <ul className={css.records}>
        {evals.map(record => (
          <EvalRow key={record.id} record={record}
            connectionName={connections.find(connection => connection.id === record.sourceConnectionId)?.name ?? record.sourceConnectionId}
            t={t} />
        ))}
      </ul>
    </div>
  )
}

/** One eval row: decision badge, rationale, batch, thread, and policy facts. */
function EvalRow({ record, connectionName, t }: {
  record: EvalRecordView
  connectionName: string | undefined
  t: TranslateNS<'dshManager'>
}) {
  const decision = record.decision
  return (
    <li className={css.record}>
      <header className={css.recordHeader}>
        {decision !== undefined
          ? <span className={css.badge} data-action={decision.action}>{t(`records.action.${decision.action}`)}</span>
          : <span className={css.badge} data-action="running">{t('records.status.running')}</span>}
        {record.flow !== undefined
          ? <span className={css.badge} data-action="flow">{t('records.flow', { pipeline: record.flow.pipelineName, stage: record.flow.stageIndex + 1, count: record.flow.stageCount })}</span>
          : null}
        <span className={css.meta}>{connectionName === undefined ? record.threadId : connectionName}</span>
        <span className={css.meta}>{formatTime(decision?.decidedAt ?? record.startedAt)}</span>
      </header>
      {decision !== undefined ? <p className={css.rationale}>{decision.rationale}</p> : null}
      {decision?.scope !== undefined ? <p className={css.meta}>{t('records.scope')}: {decision.scope}</p> : null}
      <p className={css.meta}>
        {t('records.thread')}: {record.threadId} · {t('records.policy')}: {record.policyVersion}
        {decision?.strength === undefined ? '' : ` · ${t(`records.strength.${decision.strength}`)}`}
      </p>
      {record.triggers.length > 0
        ? (
          <ul className={css.batch}>
            {record.triggers.map(trigger => (
              <li key={trigger.id} className={css.trigger}>
                {hasExternalUrl(trigger.url)
                  ? (
                    <a className={css.triggerLink} href={trigger.url} target="_blank" rel="noreferrer">
                      {t('records.viewOnExternal', { external: trigger.externalKey })}
                    </a>
                  )
                  : <span className={css.meta}>{trigger.externalKey}</span>}
              </li>
            ))}
          </ul>
        )
        : null}
    </li>
  )
}

/** Epoch millis as an ISO time. */
function formatTime(millis: number): string {
  return new Date(millis).toISOString()
}
