/** The sources-and-triggers browse section: the Source rows, the trigger
    threads, and the add-source modal. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SourceAddInput, SourceUpdateInput, SourceView, ThreadView } from '../sources/wire-types.ts'
import { ACCEPT_MODES, SOURCE_KINDS, type AcceptModeSetting, type SourceKind } from '../sources/wire-types.ts'
import type { TriggersInjected } from './triggers-source.ts'
import { DshSelect } from './DshSelect.tsx'
import { hasExternalUrl } from './url.ts'
import css from './TriggersPage.module.css'


/** Triggers page props derived from the framework and the injected source. */
export type TriggersPageProps = PropsRuntime<'main'> & InjectFace<TriggersInjected> & PropsLocale<'dshManager'> & {
  /** `embedded` drops the page padding so the settings page can stack sections. */
  readonly variant?: 'page' | 'embedded'
}

/** Render the Source instances; adding runs in a modal, then the grouped trigger browse. */
export function TriggersPage(props: TriggersPageProps) {
  const { useTriggers, onAddSource, onUpdateSource, onPoll, onRemoveSource, onExpand, onCollapse, onTriggersRetry, t, variant = 'page' } = props
  const snapshot = useTriggers(snapshot => snapshot)
  const [kind, setKind] = useState<SourceKind>('jira')
  const [acceptMode, setAcceptMode] = useState<AcceptModeSetting>('auto')
  const [connectionId, setConnectionId] = useState('')
  const [jql, setJql] = useState('')
  const [projects, setProjects] = useState('')
  const [pollSeconds, setPollSeconds] = useState('')
  const [formOpen, setFormOpen] = useState(false)

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('triggers.error')}</p>
        <button type="button" className={css.retry} onClick={onTriggersRetry}>{t('triggers.retry')}</button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('triggers.loading')}</div>
  }
  const sources = snapshot.sources ?? []
  const connections = snapshot.connections ?? []
  const threads = snapshot.threads ?? []
  const formValid = connectionId !== ''
  const requiredConnector = kind === 'jira' ? 'jira' : 'gitlab'

  const closeForm = (): void => {
    setFormOpen(false)
    setConnectionId('')
    setJql('')
    setProjects('')
    setPollSeconds('')
  }

  const submit = (): void => {
    if (!formValid) return
    const watchedProjects = projects.split(',').map(path => path.trim()).filter(path => path !== '')
    const input: SourceAddInput = {
      connectionId,
      kind,
      acceptMode,
      ...(kind === 'jira' && jql.trim() !== '' ? { jql: jql.trim() } : {}),
      ...(kind === 'gitlab-pipeline' && watchedProjects.length > 0 ? { projects: watchedProjects } : {}),
      ...(pollSeconds.trim() === '' ? {} : { pollIntervalMs: Number(pollSeconds) * 1000 }),
    }
    void onAddSource(input).then((created) => {
      if (created !== undefined) closeForm()
    })
  }

  return (
    <div className={variant === 'embedded' ? css.embedded : css.page}>
      <section className={css.section}>
        <header className={css.sectionHeader}>
          <h2 className={css.sectionTitle}>{t('triggers.sources.title')}</h2>
          <button type="button" className={css.submit} onClick={() => { setFormOpen(true) }}>
            {t('triggers.sources.add.open')}
          </button>
        </header>
        {sources.length === 0 ? <p className={css.emptyInline}>{t('triggers.sources.empty')}</p> : null}
        <ul className={css.sources}>
          {sources.map(source => (
            <SourceRow key={source.id} source={source} snapshot={snapshot}
              connectionName={connections.find(connection => connection.id === source.connectionId)?.name ?? source.connectionId}
              t={t} onPoll={onPoll} onUpdate={onUpdateSource} onRemove={onRemoveSource} />
          ))}
        </ul>
        <Modal
          open={formOpen}
          onClose={closeForm}
          title={t('triggers.sources.add.title')}
          closeLabel={t('triggers.sources.cancel')}
        >
          <label className={css.field}>
            <span>{t('triggers.sources.kind')}</span>
            <DshSelect
              value={kind}
              options={SOURCE_KINDS.map(option => ({ value: option, label: t(`triggers.sources.kind.${option}`) }))}
              onChange={next => setKind(next as SourceKind)}
            />
          </label>
          <label className={css.field}>
            <span>{t('triggers.sources.acceptMode')}</span>
            <DshSelect
              value={acceptMode}
              options={ACCEPT_MODES.map(option => ({ value: option, label: t(`triggers.sources.acceptMode.${option}`) }))}
              onChange={next => setAcceptMode(next as AcceptModeSetting)}
            />
          </label>
          <label className={css.field}>
            <span>{t('triggers.sources.connection')}</span>
            <DshSelect
              value={connectionId}
              options={[
                { value: '', label: t('triggers.sources.select') },
                ...connections.filter(connection => connection.connector === requiredConnector).map(connection => ({
                  value: connection.id,
                  label: connection.name,
                })),
              ]}
              onChange={setConnectionId}
            />
          </label>
          {kind === 'jira'
            ? (
              <label className={css.field}>
                <span>{t('triggers.sources.jql')}</span>
                <input className={css.input} value={jql} onChange={event => setJql(event.target.value)}
                  placeholder={t('triggers.sources.jqlPlaceholder')} />
              </label>
            )
            : null}
          {kind === 'gitlab-pipeline'
            ? (
              <label className={css.field}>
                <span>{t('triggers.sources.projects')}</span>
                <input className={css.input} value={projects} onChange={event => setProjects(event.target.value)}
                  placeholder={t('triggers.sources.projectsPlaceholder')} />
              </label>
            )
            : null}
          <label className={css.field}>
            <span>{t('triggers.sources.interval')}</span>
            <input className={css.input} type="number" min={10} value={pollSeconds}
              onChange={event => setPollSeconds(event.target.value)} />
          </label>
          <footer className={css.modalFooter}>
            <button type="button" className={css.action} onClick={closeForm}>{t('triggers.sources.cancel')}</button>
            <button type="button" className={css.submit} disabled={!formValid || snapshot.busy === true} onClick={submit}>
              {t('triggers.sources.add')}
            </button>
          </footer>
        </Modal>
      </section>
      <section className={css.section}>
        <h2 className={css.sectionTitle}>{t('triggers.threads.title')}</h2>
        {threads.length === 0 ? <p className={css.emptyInline}>{t('triggers.threads.empty')}</p> : null}
        <ul className={css.threads}>
          {threads.map(thread => (
            <ThreadRow key={thread.id} thread={thread} snapshot={snapshot} t={t}
              onExpand={onExpand} onCollapse={onCollapse} />
          ))}
        </ul>
      </section>
    </div>
  )
}

/** One Source instance row with its affordances. */
function SourceRow({ source, snapshot, connectionName, t, onPoll, onUpdate, onRemove }: {
  source: SourceView
  snapshot: { readonly busy?: boolean; readonly lastPoll?: { readonly sourceId: string; readonly added: number; readonly duplicates: number; readonly error?: string } }
  connectionName: string
  t: TranslateNS<'dshManager'>
  onPoll: (id: string) => Promise<unknown>
  onUpdate: (input: { id: string; enabled?: boolean }) => Promise<unknown>
  onRemove: (id: string) => Promise<unknown>
}) {
  const lastPoll = snapshot.lastPoll?.sourceId === source.id ? snapshot.lastPoll : undefined
  return (
    <li className={css.source} data-enabled={source.enabled}>
      <strong>{connectionName}</strong>
      {source.jql !== undefined
        ? <code className={css.jql}>{source.jql}</code>
        : source.projects !== undefined
          ? <code className={css.jql}>{source.projects.join(', ')}</code>
          : null}
      <span className={css.meta}>{t(`triggers.sources.acceptMode.${source.acceptMode}`)}</span>
      <span className={css.meta}>{Math.round(source.pollIntervalMs / 1000)}s</span>
      {source.enabled
        ? <button type="button" className={css.action} disabled={snapshot.busy === true}
          onClick={() => { void onUpdate({ id: source.id, enabled: false }) }}>{t('triggers.sources.disable')}</button>
        : <button type="button" className={css.action} disabled={snapshot.busy === true}
          onClick={() => { void onUpdate({ id: source.id, enabled: true }) }}>{t('triggers.sources.enable')}</button>}
      <button type="button" className={css.action} disabled={snapshot.busy === true}
        onClick={() => { void onPoll(source.id) }}>{t('triggers.sources.pollNow')}</button>
      <button type="button" className={css.action} disabled={snapshot.busy === true}
        onClick={() => { void onRemove(source.id) }}>{t('triggers.sources.remove')}</button>
      {lastPoll !== undefined && lastPoll.error === undefined
        ? <span className={css.pollOk}>{t('triggers.sources.polled', { added: lastPoll.added, duplicates: lastPoll.duplicates })}</span>
        : null}
      {lastPoll?.error !== undefined ? <span className={css.invalid}>{lastPoll.error}</span> : null}
      {source.lastError !== undefined ? <span className={css.invalid}>{source.lastError}</span> : null}
    </li>
  )
}

/** One thread with its expandable trigger list. */
function ThreadRow({ thread, snapshot, t, onExpand, onCollapse }: {
  thread: ThreadView
  snapshot: { readonly expanded?: { readonly threadId: string; readonly triggers: readonly { id: string; url: string; occurredAt?: number; collectedAt: number }[] } }
  t: TranslateNS<'dshManager'>
  onExpand: (threadId: string) => Promise<unknown>
  onCollapse: () => unknown
}) {
  const expanded = snapshot.expanded?.threadId === thread.id
  return (
    <li className={css.thread}>
      <header className={css.threadHeader}>
        {hasExternalUrl(thread.url)
          ? <a className={css.threadLink} href={thread.url} target="_blank" rel="noreferrer">{thread.title}</a>
          : <strong className={css.threadLink}>{thread.title}</strong>}
        <span className={css.meta}>{thread.externalKey}</span>
        <button type="button" className={css.action} onClick={() => {
          if (expanded) onCollapse()
          else void onExpand(thread.id)
        }}>
          {expanded ? t('triggers.threads.collapse') : t('triggers.threads.expand')}
        </button>
      </header>
      {expanded && snapshot.expanded !== undefined
        ? (
          <ul className={css.triggerList}>
            {snapshot.expanded.triggers.map(trigger => (
              <li key={trigger.id} className={css.trigger}>
                {hasExternalUrl(trigger.url)
                  ? <a href={trigger.url} target="_blank" rel="noreferrer">{t('triggers.threads.viewOnJira')}</a>
                  : null}
                <span className={css.meta}>{formatTime(trigger.occurredAt ?? trigger.collectedAt)}</span>
              </li>
            ))}
          </ul>
        )
        : null}
    </li>
  )
}

/** Epoch millis as a locale time; a missing clock renders as the bare tick. */
function formatTime(millis: number): string {
  return new Date(millis).toISOString()
}
