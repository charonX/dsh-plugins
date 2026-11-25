/** The connections config section: the card list plus the add/edit modal. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthMethod, ConnectorKind } from '../connections/wire-types.ts'
import type { ConnectionAddInput, ConnectionView, ConnectivityResult } from '../connections/wire-types.ts'
import type { ConnectionsInjected } from './connections-source.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './ConnectionsPage.module.css'


/** Connections page props derived from the framework and the injected source. */
export type ConnectionsPageProps = PropsRuntime<'main'> & InjectFace<ConnectionsInjected> & PropsLocale<'dshManager'> & {
  /** `embedded` drops the page padding so the settings page can stack sections. */
  readonly variant?: 'page' | 'embedded'
}

/** The connector choices the add form offers. */
const CONNECTOR_OPTIONS = ['jira', 'gitlab'] as const satisfies readonly ConnectorKind[]

/** The auth methods the form offers; identity applies to Basic only. */
const AUTH_METHOD_OPTIONS = ['pat', 'basic'] as const satisfies readonly AuthMethod[]

/** The deployment choices, paired with their localized titles. */
const DEPLOYMENT_OPTIONS = ['server-dc', 'cloud'] as const

/** Reason keys for a failed connectivity verdict. */
const REASON_KEYS = {
  'dependency-missing': 'connections.test.dependency-missing',
  'unreachable': 'connections.test.unreachable',
  'invalid-credentials': 'connections.test.invalid-credentials',
  'insufficient-permission': 'connections.test.insufficient-permission',
} as const satisfies Record<Exclude<ConnectivityResult, { ok: true }>['reason'], `connections.test.${string}`>

const STATUS_KEYS = {
  'unconfigured': 'connections.status.unconfigured',
  'dependency-missing': 'connections.status.dependency-missing',
  'invalid-credentials': 'connections.status.invalid-credentials',
  'ok': 'connections.status.ok',
} as const satisfies Record<ConnectionView['status'], `connections.status.${ConnectionView['status']}`>

/** The mutable form fields; `secret` stays blank in edit mode unless retyped. */
interface FormState {
  readonly connector: ConnectorKind
  readonly name: string
  readonly deployment: ConnectionAddInput['deployment']
  readonly baseUrl: string
  readonly authMethod: AuthMethod
  readonly authIdentity: string
  readonly secret: string
}

const EMPTY_FORM: FormState = {
  connector: 'jira',
  name: '',
  deployment: 'server-dc',
  baseUrl: '',
  authMethod: 'pat',
  authIdentity: '',
  secret: '',
}

/** Render the connection cards; add and edit run in a modal. */
export function ConnectionsPage(props: ConnectionsPageProps) {
  const { useConnections, onAdd, onUpdate, onTest, onDeleteInfo, onConnectionRemove, onConnectionsRetry, t, variant = 'page' } = props
  const snapshot = useConnections(snapshot => snapshot)
  const [editingId, setEditingId] = useState<string>()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [addError, setAddError] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<{ id: string; sources: number; mappings: number }>()
  const editing = editingId !== undefined
  const identityNeeded = form.authMethod === 'basic'
  // In edit mode the secret is optional: blank keeps the stored credential.
  const formValid = form.name.trim() !== '' && isValidBaseUrl(form.baseUrl)
    && (editing || form.secret.trim() !== '')
    && (!identityNeeded || form.authIdentity.trim() !== '')

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('connections.error')}</p>
        <button type="button" className={css.retry} onClick={onConnectionsRetry}>{t('connections.retry')}</button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('connections.loading')}</div>
  }
  const connections = snapshot.connections ?? []

  const submit = (): void => {
    if (!formValid) {
      setAddError(true)
      return
    }
    setAddError(false)
    if (editingId !== undefined) {
      void onUpdate({
        id: editingId,
        name: form.name.trim(),
        deployment: form.deployment,
        baseUrl: form.baseUrl.trim(),
        authMethod: form.authMethod,
        ...(identityNeeded ? { authIdentity: form.authIdentity.trim() } : {}),
        ...(form.secret.trim() === '' ? {} : { secret: form.secret.trim() }),
      }).then((saved) => {
        if (saved === undefined) {
          setAddError(true)
          return
        }
        resetForm()
      })
      return
    }
    void onAdd({
      connector: form.connector,
      name: form.name.trim(),
      deployment: form.deployment,
      baseUrl: form.baseUrl.trim(),
      authMethod: form.authMethod,
      ...(identityNeeded ? { authIdentity: form.authIdentity.trim() } : {}),
      secret: form.secret.trim(),
    }).then((created) => {
      if (created === undefined) {
        setAddError(true)
        return
      }
      resetForm()
    })
  }

  const resetForm = (): void => {
    setEditingId(undefined)
    setForm(EMPTY_FORM)
    setPendingRemove(undefined)
    setFormOpen(false)
  }

  const startAdd = (): void => {
    setEditingId(undefined)
    setAddError(false)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const startEdit = (connection: ConnectionView): void => {
    setEditingId(connection.id)
    setAddError(false)
    setFormOpen(true)
    setForm({
      connector: connection.connector,
      name: connection.name,
      deployment: connection.deployment,
      baseUrl: connection.baseUrl,
      authMethod: connection.authMethod,
      authIdentity: connection.authIdentity ?? '',
      secret: '',
    })
  }

  const remove = (id: string): void => {
    if (pendingRemove?.id === id) {
      setPendingRemove(undefined)
      void onConnectionRemove(id)
      return
    }
    void onDeleteInfo(id).then((info) => {
      if (info.sources > 0 || info.mappings > 0) {
        setPendingRemove({ id, sources: info.sources, mappings: info.mappings })
        return
      }
      void onConnectionRemove(id)
    })
  }

  return (
    <div className={variant === 'embedded' ? css.embedded : css.page}>
      <header className={css.sectionHeader}>
        <h2 className={css.sectionTitle}>{t('connections.panel')}</h2>
        <button type="button" className={css.submit} onClick={startAdd}>
          {t('connections.add.open')}
        </button>
      </header>
      {connections.length === 0 ? <p className={css.emptyInline}>{t('connections.empty')}</p> : null}
      <ul className={css.cards}>
        {connections.map(connection => (
          <li key={connection.id} className={css.card} data-status={connection.status} data-enabled={connection.enabled}>
            <header className={css.cardHeader}>
              <strong>{connection.name}</strong>
              <span className={css.badge} data-status={connection.status}>{t(STATUS_KEYS[connection.status])}</span>
              {!connection.enabled ? <span className={css.badge}>{t('connections.disabled')}</span> : null}
            </header>
            <div className={css.meta}>{connection.deployment} · {connection.baseUrl}</div>
            {connection.status === 'dependency-missing' && connection.installCommand !== undefined
              ? <InstallHint command={connection.installCommand} t={t} />
              : null}
            <TestLine connection={connection} snapshot={snapshot} t={t} />
            <footer className={css.cardActions}>
              <button type="button" className={css.action} disabled={snapshot.busy === true}
                onClick={() => { void onTest(connection.id) }}>
                {t('connections.test.button')}
              </button>
              <button type="button" className={css.action} disabled={snapshot.busy === true}
                onClick={() => { startEdit(connection) }}>
                {t('connections.edit')}
              </button>
              <button type="button" className={css.action} disabled={snapshot.busy === true}
                onClick={() => { void onUpdate({ id: connection.id, enabled: !connection.enabled }) }}>
                {connection.enabled ? t('connections.disable') : t('connections.enable')}
              </button>
              <button type="button" className={css.action} disabled={snapshot.busy === true}
                onClick={() => { remove(connection.id) }}>
                {t('connections.remove')}
              </button>
              {pendingRemove?.id === connection.id
                ? (
                  <span className={css.invalid}>
                    {t('connections.delete.warning', {
                      sources: pendingRemove.sources,
                      mappings: pendingRemove.mappings,
                    })}
                  </span>
                )
                : null}
            </footer>
          </li>
        ))}
      </ul>
      {snapshot.busy === true ? <p className={css.busy}>{t('connections.busy')}</p> : null}
      <Modal
        open={formOpen}
        onClose={resetForm}
        title={editing ? t('connections.editing') : t('connections.add.title')}
        closeLabel={t('connections.cancel')}
      >
        {!editing
          ? (
            <label className={css.field}>
              <span>{t('connections.add.connector')}</span>
              <DshSelect
                value={form.connector}
                options={CONNECTOR_OPTIONS.map(kind => ({ value: kind, label: t(`connections.add.connector.${kind}`) }))}
                onChange={next => setForm({ ...form, connector: next as ConnectorKind })}
              />
            </label>
          )
          : null}
        <label className={css.field}>
          <span>{t('connections.add.name')}</span>
          <input className={css.input} value={form.name}
            onChange={event => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className={css.field}>
          <span>{t('connections.add.deployment')}</span>
          <DshSelect
            value={form.deployment}
            options={DEPLOYMENT_OPTIONS.map(kind => ({ value: kind, label: t(`connections.add.deployment.${kind}`) }))}
            onChange={next => setForm({ ...form, deployment: next as ConnectionAddInput['deployment'] })}
          />
        </label>
        <label className={css.field}>
          <span>{t('connections.add.authMethod')}</span>
          <DshSelect
            value={form.authMethod}
            options={AUTH_METHOD_OPTIONS.map(method => ({ value: method, label: t(`connections.add.authMethod.${method}`) }))}
            onChange={next => setForm({ ...form, authMethod: next as AuthMethod })}
          />
        </label>
        {identityNeeded
          ? (
            <label className={css.field}>
              <span>{t('connections.add.identity')}</span>
              <input className={css.input} value={form.authIdentity}
                onChange={event => setForm({ ...form, authIdentity: event.target.value })} />
            </label>
          )
          : null}
        <label className={css.field}>
          <span>{t('connections.add.baseUrl')}</span>
          <input className={css.input} value={form.baseUrl}
            onChange={event => setForm({ ...form, baseUrl: event.target.value })} />
        </label>
        <label className={css.field}>
          <span>{identityNeeded ? t('connections.add.secret') : t('connections.add.pat')}</span>
          <input className={css.input} type="password" value={form.secret}
            onChange={event => setForm({ ...form, secret: event.target.value })} />
        </label>
        {!formValid && (editing
          ? identityNeeded && form.authIdentity.trim() === ''
          : hasAnyInput(form.name, form.baseUrl, form.secret, form.authIdentity))
          ? <p className={css.invalid}>{t('connections.add.invalid')}</p>
          : null}
        {addError && (snapshot.actionError === undefined || snapshot.actionError === '')
          ? <p className={css.invalid}>{t('connections.add.failed')}</p>
          : null}
        {snapshot.actionError !== undefined && snapshot.actionError !== ''
          ? <p className={css.invalid}>{snapshot.actionError}</p>
          : null}
        <footer className={css.modalFooter}>
          <button type="button" className={css.action} onClick={resetForm}>{t('connections.cancel')}</button>
          <button type="button" className={css.submit} disabled={!formValid || snapshot.busy === true} onClick={submit}>
            {editing ? t('connections.save') : t('connections.add.submit')}
          </button>
        </footer>
      </Modal>
    </div>
  )
}

/** The per-card test verdict line: the last test of this connection, if any. */
function TestLine({ connection, snapshot, t }: {
  connection: ConnectionView
  snapshot: { readonly lastTest?: { readonly id: string; readonly result: ConnectivityResult } }
  t: TranslateNS<'dshManager'>
}) {
  const last = snapshot.lastTest
  if (last === undefined || last.id !== connection.id) return null
  if (last.result.ok) return <p className={css.verdictOk}>{t('connections.test.ok')}</p>
  return (
    <p className={css.verdictFail}>
      {t(REASON_KEYS[last.result.reason])}
      <span className={css.verdictDetail}>{last.result.detail}</span>
      {last.result.reason === 'dependency-missing' && last.result.installCommand !== undefined
        ? <InstallHint command={last.result.installCommand} t={t} />
        : null}
    </p>
  )
}

/** The `glab` install guidance: one copyable command, no shell required. */
function InstallHint({ command, t }: { command: string; t: TranslateNS<'dshManager'> }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true)
    }).catch(() => {
      setCopied(false)
    })
  }
  return (
    <span className={css.installHint}>
      <span>{t('connections.install.hint')}</span>
      <code>{command}</code>
      <button type="button" className={css.action} onClick={copy}>{t('connections.install.copy')}</button>
      {copied ? <span>{t('connections.install.copied')}</span> : null}
    </span>
  )
}

/** Whether an absolute URL parses. */
function isValidBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function hasAnyInput(...values: readonly string[]): boolean {
  return values.some(value => value.trim() !== '')
}
