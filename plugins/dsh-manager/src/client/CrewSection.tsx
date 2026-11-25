/** The crew roster section: multi-column member cards, executor probing, and add/edit modal. */
import { useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrewInjected } from './crew-source.ts'
import type { PipelineInjected } from './pipeline-source.ts'
import type { AgentKindOption, CrewMemberView, ModelProviderOptions } from '../crew/wire-types.ts'
import { AGENT_KINDS, type AgentKind } from '../crew/crew-core.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './TeamPage.module.css'

export type CrewSectionProps = InjectFace<CrewInjected>
  & Pick<InjectFace<PipelineInjected>, 'onPipelineReferencesOf'>
  & PropsLocale<'dshManager'>

interface MemberForm {
  readonly name: string
  readonly role: string
  readonly agentKind: AgentKind
  readonly provider: string
  readonly model: string
}

const EMPTY_FORM: MemberForm = { name: '', role: '', agentKind: 'builtin', provider: '', model: '' }

/** The crew roster: multi-column member cards, with add and edit running in a modal. */
export function CrewSection({
  useCrew,
  onCrewAdd,
  onCrewUpdate,
  onCrewRemove,
  onModelOptions,
  onAgentKindOptions,
  onPipelineReferencesOf,
  onCrewRetry,
  t,
}: CrewSectionProps) {
  const snapshot = useCrew(s => s)
  const [editingId, setEditingId] = useState<string>()
  const [form, setForm] = useState<MemberForm>(EMPTY_FORM)
  const [formOpen, setFormOpen] = useState(false)
  const [options, setOptions] = useState<readonly ModelProviderOptions[]>([])
  const [kindOptions, setKindOptions] = useState<readonly AgentKindOption[]>([])
  const [probingKinds, setProbingKinds] = useState(false)
  const [submitFailed, setSubmitFailed] = useState(false)
  // Two-step remove: first click checks pipeline references; second click confirms.
  const [pendingRemove, setPendingRemove] = useState<{ id: string; references: readonly string[] }>()

  const editing = editingId !== undefined
  const formValid = form.name.trim() !== '' && form.role.trim() !== ''
  const providerOptions = options.find(entry => entry.provider === form.provider)
  const selectedKindOption = kindOptions.find(entry => entry.kind === form.agentKind)
  const editingKind = editingId !== undefined
    ? (snapshot.members ?? []).find(member => member.id === editingId)?.agentKind
    : undefined

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('crew.error')}</p>
        <Button variant="outline" size="sm" onClick={onCrewRetry}>{t('crew.retry')}</Button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('crew.loading')}</div>
  }
  const members = snapshot.members ?? []

  const close = (): void => {
    setEditingId(undefined)
    setForm(EMPTY_FORM)
    setSubmitFailed(false)
    setFormOpen(false)
  }
  const loadKindOptions = (refresh = false): void => {
    setProbingKinds(true)
    void onAgentKindOptions(refresh)
      .then(setKindOptions)
      .finally(() => { setProbingKinds(false) })
  }
  const startAdd = (): void => {
    setEditingId(undefined)
    setSubmitFailed(false)
    setForm(EMPTY_FORM)
    setFormOpen(true)
    void onModelOptions().then(setOptions)
    loadKindOptions(false)
  }
  const startEdit = (member: CrewMemberView): void => {
    setEditingId(member.id)
    setSubmitFailed(false)
    setFormOpen(true)
    setForm({
      name: member.name,
      role: member.role,
      agentKind: member.agentKind ?? 'builtin',
      provider: member.provider ?? '',
      model: member.model ?? '',
    })
    void onModelOptions().then(setOptions)
    loadKindOptions(false)
  }
  const submit = (): void => {
    if (!formValid || snapshot.busy === true) return
    const kindFacts = form.agentKind === 'builtin'
      ? (editingKind !== undefined && editingKind !== 'builtin' ? { agentKind: null as null } : {})
      : { agentKind: form.agentKind }
    const facts = {
      name: form.name.trim(),
      role: form.role.trim(),
      ...kindFacts,
      ...(form.provider.trim() === '' ? (editing && (snapshot.members ?? []).find(member => member.id === editingId)?.provider !== undefined ? { provider: null as null } : {}) : { provider: form.provider.trim() }),
      ...(form.model.trim() === '' ? (editing && (snapshot.members ?? []).find(member => member.id === editingId)?.model !== undefined ? { model: null as null } : {}) : { model: form.model.trim() }),
    }
    const saved = editingId !== undefined
      ? onCrewUpdate({ memberId: editingId, ...facts })
      : onCrewAdd(facts)
    void saved.then((savedMember) => {
      if (savedMember === undefined) {
        setSubmitFailed(true)
        return
      }
      close()
    })
  }
  const remove = (member: CrewMemberView): void => {
    if (pendingRemove?.id === member.id) {
      setPendingRemove(undefined)
      void onCrewRemove(member.id)
      return
    }
    void onPipelineReferencesOf(member.id).then((references) => {
      if (references.length > 0) {
        setPendingRemove({ id: member.id, references })
        return
      }
      void onCrewRemove(member.id)
    })
  }

  return (
    <>
      <header className={css.sectionHeader}>
        <div className={css.sectionTitleGroup}>
          <h2 className={css.sectionTitle}>{t('crew.section')}</h2>
          <Tag tone="neutral">{members.length}</Tag>
        </div>
        <Button variant="primary" size="sm" onClick={startAdd}>
          {t('crew.add.open')}
        </Button>
      </header>
      {members.length === 0 ? <p className={css.emptyInline}>{t('crew.empty')}</p> : null}
      <ul className={css.crewGrid}>
        {members.map(member => (
          <li key={member.id} className={css.card}>
            <header className={css.cardHeader}>
              <span className={css.avatarBadge} aria-hidden="true">{member.name.slice(0, 1)}</span>
              <strong>{member.name}</strong>
              <Tag tone={member.enabled ? 'success' : 'warning'}>
                {member.enabled ? t('crew.enabled') : t('crew.disabled')}
              </Tag>
              {member.agentKind !== undefined && member.agentKind !== 'builtin'
                ? <Tag tone="info">{t(`crew.agentKind.${member.agentKind}`)}</Tag>
                : null}
              {member.model !== undefined ? <Tag tone="outline">{member.model}</Tag> : null}
            </header>
            <p className={css.roleText}>{member.role}</p>
            <footer className={css.cardActions}>
              <Button variant="outline" size="sm" disabled={snapshot.busy === true}
                onClick={() => { startEdit(member) }}>
                {t('crew.edit')}
              </Button>
              <Button variant="outline" size="sm" disabled={snapshot.busy === true}
                onClick={() => { void onCrewUpdate({ memberId: member.id, enabled: !member.enabled }) }}>
                {member.enabled ? t('crew.disable') : t('crew.enable')}
              </Button>
              <Button variant="ghost" size="sm" disabled={snapshot.busy === true}
                onClick={() => { remove(member) }}>
                {t('crew.remove')}
              </Button>
            </footer>
            {pendingRemove?.id === member.id
              ? <p className={css.invalid}>{t('crew.removeReferenced', { references: pendingRemove.references.join('、') })}</p>
              : null}
          </li>
        ))}
      </ul>
      {snapshot.busy === true ? <p className={css.busy}>{t('crew.busy')}</p> : null}
      {snapshot.actionError !== undefined && snapshot.actionError !== ''
        ? <p className={css.invalid}>{snapshot.actionError}</p>
        : null}
      <Modal
        open={formOpen}
        onClose={close}
        title={editing ? t('crew.editing') : t('crew.add.title')}
        closeLabel={t('crew.cancel')}
        {...(css.memberModal === undefined ? {} : { className: css.memberModal })}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={close}>{t('crew.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={!formValid || snapshot.busy === true} onClick={submit}>
              {editing ? t('crew.save') : t('crew.add.submit')}
            </Button>
          </>
        )}
      >
        <label className={css.field}>
          <span>{t('crew.name')}</span>
          <input className={css.input} value={form.name} placeholder={t('crew.namePlaceholder')}
            onChange={event => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className={css.field}>
          <span>{t('crew.role')}</span>
          <textarea className={css.textArea} value={form.role} placeholder={t('crew.rolePlaceholder')}
            onChange={event => setForm({ ...form, role: event.target.value })} />
        </label>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <div className={css.fieldLabelRow}>
              <label htmlFor="dsh-crew-agent-kind">{t('crew.agentKind')}</label>
              <Button variant="ghost" size="sm" disabled={probingKinds} onClick={() => { loadKindOptions(true) }}>
                {probingKinds ? t('crew.agentKind.probing') : t('crew.agentKind.refresh')}
              </Button>
            </div>
            <DshSelect
              id="dsh-crew-agent-kind"
              value={form.agentKind}
              options={AGENT_KINDS.map(kind => {
                const probed = kindOptions.find(entry => entry.kind === kind)
                const label = t(`crew.agentKind.${kind}`)
                const text = probed !== undefined && !probed.available
                  ? t('crew.agentKind.notFoundOption', { name: label })
                  : label
                return { value: kind, label: text }
              })}
              onChange={next => {
                const nextKind = next as AgentKind
                setForm({ ...form, agentKind: nextKind, ...(nextKind === 'builtin' ? {} : { provider: '' }) })
              }}
            />
          </div>
          {form.agentKind !== 'builtin'
            ? (
              <label className={css.field}>
                <span>{t('crew.externalModelLabel')}</span>
                <input className={css.input} value={form.model} placeholder={t('crew.externalModelPlaceholder')}
                  onChange={event => setForm({ ...form, model: event.target.value })} />
              </label>
            )
            : options.length > 0
              ? (
                <label className={css.field}>
                  <span>{t('crew.provider')}</span>
                  <DshSelect
                    value={form.provider}
                    options={[
                      { value: '', label: t('crew.providerInherit') },
                      ...options.map(entry => ({ value: entry.provider, label: entry.providerName })),
                    ]}
                    onChange={next => setForm({ ...form, provider: next, model: '' })}
                  />
                </label>
              )
              : (
                <label className={css.field}>
                  <span>{t('crew.provider')}</span>
                  <input className={css.input} value={form.provider} placeholder={t('crew.providerPlaceholder')}
                    onChange={event => setForm({ ...form, provider: event.target.value })} />
                </label>
              )}
        </div>
        {form.agentKind !== 'builtin'
          ? (
            <div className={css.field}>
              {selectedKindOption !== undefined
                ? (selectedKindOption.available
                  ? (
                    <p className={css.fieldHint}>
                      {t('crew.agentKind.detected', {
                        path: selectedKindOption.executablePath ?? selectedKindOption.command,
                        version: selectedKindOption.version !== undefined ? ` (${selectedKindOption.version})` : '',
                      })}
                    </p>
                  )
                  : (
                    <p className={css.fieldWarn}>
                      {t('crew.agentKind.unavailable', { command: selectedKindOption.command })}
                    </p>
                  ))
                : null}
              <p className={css.fieldHint}>{t('crew.agentKindExternalHint', { kind: t(`crew.agentKind.${form.agentKind}`) })}</p>
              <p className={css.fieldHint}>{t('crew.externalModelHint', { kind: t(`crew.agentKind.${form.agentKind}`) })}</p>
            </div>
          )
          : (
            <label className={css.field}>
              <span>{t('crew.model')}</span>
              {options.length > 0 && form.provider !== ''
                ? (
                  <DshSelect
                    value={form.model}
                    options={[
                      { value: '', label: t('crew.modelInherit') },
                      ...(providerOptions?.models ?? []).map(model => ({ value: model.id, label: model.name })),
                    ]}
                    onChange={next => setForm({ ...form, model: next })}
                  />
                )
                : options.length > 0
                  ? <p className={css.fieldHint}>{t('crew.modelHintProviderFirst')}</p>
                  : (
                    <input className={css.input} value={form.model} placeholder={t('crew.modelPlaceholder')}
                      onChange={event => setForm({ ...form, model: event.target.value })} />
                  )}
            </label>
          )}
        {!formValid
          ? <p className={css.formError}>{t('crew.invalid')}</p>
          : null}
        {submitFailed && (snapshot.actionError === undefined || snapshot.actionError === '')
          ? <p className={css.formError}>{t('crew.failed')}</p>
          : null}
        {snapshot.actionError !== undefined && snapshot.actionError !== ''
          ? <p className={css.formError}>{snapshot.actionError}</p>
          : null}
      </Modal>
    </>
  )
}
