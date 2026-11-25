/** The project-mapping config section: the mapping rows plus the add modal. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MappingSetInput, MappingView } from '../mappings/wire-types.ts'
import type { MappingsInjected } from './mappings-source.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './MappingsPage.module.css'


/** Mappings page props derived from the framework and the injected source. */
export type MappingsPageProps = PropsRuntime<'main'> & InjectFace<MappingsInjected> & PropsLocale<'dshManager'> & {
  /** `embedded` drops the page padding so the settings page can stack sections. */
  readonly variant?: 'page' | 'embedded'
}

/** Render the mapping rows; adding runs in a modal. */
export function MappingsPage(props: MappingsPageProps) {
  const { useMappings, onSet, onMappingRemove, onMappingsRetry, t, variant = 'page' } = props
  const snapshot = useMappings(snapshot => snapshot)
  const [connectionId, setConnectionId] = useState('')
  const [external, setExternal] = useState('')
  const [projectId, setProjectId] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const formValid = connectionId !== '' && external.trim() !== '' && projectId !== ''

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('mappings.error')}</p>
        <button type="button" className={css.retry} onClick={onMappingsRetry}>{t('mappings.retry')}</button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('mappings.loading')}</div>
  }
  const mappings = snapshot.mappings ?? []
  const connections = snapshot.connections ?? []
  const projects = snapshot.projects ?? []

  const closeForm = (): void => {
    setFormOpen(false)
    setConnectionId('')
    setExternal('')
    setProjectId('')
  }

  const submit = (): void => {
    if (!formValid) return
    const input: MappingSetInput = {
      connectionId,
      external: external.trim(),
      projectId,
    }
    void onSet(input).then((created) => {
      if (created !== undefined) closeForm()
    })
  }

  return (
    <div className={variant === 'embedded' ? css.embedded : css.page}>
      <header className={css.sectionHeader}>
        <h2 className={css.sectionTitle}>{t('mappings.panel')}</h2>
        <button type="button" className={css.submit} onClick={() => { setFormOpen(true) }}>
          {t('mappings.add.open')}
        </button>
      </header>
      {mappings.length === 0 ? <p className={css.emptyInline}>{t('mappings.empty')}</p> : null}
      <ul className={css.rows}>
        {mappings.map(mapping => (
          <li key={mapping.id} className={css.row} data-valid={mapping.valid}>
            <code className={css.external}>{mapping.external}</code>
            <span className={css.arrow}>→</span>
            <span className={css.project}>{projectName(projects, mapping.projectId)}</span>
            {!mapping.valid ? <span className={css.badge}>{t('mappings.invalid')}</span> : null}
            <button type="button" className={css.action} disabled={snapshot.busy === true}
              onClick={() => { void onMappingRemove(mapping.id) }}>
              {t('mappings.remove')}
            </button>
          </li>
        ))}
      </ul>
      {snapshot.busy === true ? <p className={css.busy}>{t('mappings.busy')}</p> : null}
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('mappings.add.title')}
        closeLabel={t('mappings.cancel')}
      >
        <label className={css.field}>
          <span>{t('mappings.add.connection')}</span>
          <DshSelect
            value={connectionId}
            options={[
              { value: '', label: t('mappings.add.select') },
              ...connections.map(connection => ({ value: connection.id, label: connection.name })),
            ]}
            onChange={setConnectionId}
          />
        </label>
        <label className={css.field}>
          <span>{t('mappings.add.external')}</span>
          <input className={css.input} value={external}
            onChange={event => setExternal(event.target.value)} />
        </label>
        <label className={css.field}>
          <span>{t('mappings.add.project')}</span>
          <DshSelect
            value={projectId}
            options={[
              { value: '', label: t('mappings.add.select') },
              ...projects.map(project => ({ value: project.id, label: project.name })),
            ]}
            onChange={setProjectId}
          />
        </label>
        {snapshot.lastError !== undefined && snapshot.lastError !== ''
          ? <p className={css.invalid}>{t('mappings.failed', { reason: snapshot.lastError })}</p>
          : null}
        <footer className={css.modalFooter}>
          <button type="button" className={css.action} onClick={closeForm}>{t('mappings.cancel')}</button>
          <button type="button" className={css.submit} disabled={!formValid || snapshot.busy === true} onClick={submit}>
            {t('mappings.add.submit')}
          </button>
        </footer>
      </Modal>
    </div>
  )
}

/** The display name of one mapped project; an unknown id renders as the id itself. */
function projectName(projects: readonly { readonly id: string; readonly name: string }[], projectId: string): string {
  return projects.find(project => project.id === projectId)?.name ?? projectId
}
