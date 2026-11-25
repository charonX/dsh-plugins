/** The Policy page: standing decision records, approval categories, and version history. */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ACTION_CATEGORIES, type ActionCategory } from '../approval/approval-policy.ts'
import { POLICY_ENTRY_KINDS, type PolicyEntryKind } from '../policy/policy-core.ts'
import type { PolicyInjected } from './policy-source.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './PolicyPage.module.css'

/** Policy page props derived from the framework and the injected policy source. */
export type PolicyPageProps = PropsRuntime<'main'> & InjectFace<PolicyInjected> & PropsLocale<'dshManager'>

/** Render the active Policy version, decision rules, approval gates, and version history. */
export function PolicyPage(props: PolicyPageProps) {
  const { usePolicy, onPolicyAddEntry, onPolicyRemoveEntry, onPolicyToggleCategory, onPolicyRetry, t } = props
  const snapshot = usePolicy(state => state)
  const [modalOpen, setModalOpen] = useState(false)
  const [kind, setKind] = useState<PolicyEntryKind>('preference')
  const [statement, setStatement] = useState('')

  if (snapshot.status === 'error') {
    return (
      <div className={css.empty}>
        <p>{t('policy.error')}</p>
        <Button variant="outline" size="sm" onClick={onPolicyRetry}>{t('policy.retry')}</Button>
      </div>
    )
  }
  if (snapshot.status === 'loading') {
    return <div className={css.empty}>{t('policy.loading')}</div>
  }

  const policies = snapshot.policies ?? []
  const active = policies[0]
  const decisions = active?.decisions ?? []
  const categories = active?.approvalCategories ?? []
  const busy = snapshot.busy === true
  const valid = statement.trim() !== ''

  const submit = (): void => {
    if (!valid || busy) return
    void onPolicyAddEntry({ kind, statement: statement.trim() }).then((saved) => {
      if (saved === undefined) return
      setStatement('')
      setKind('preference')
      setModalOpen(false)
    })
  }

  return (
    <div className={css.page}>
      <section className={css.summaryBar}>
        <div className={css.summaryLeft}>
          <div className={css.summaryHeading}>
            <h2 className={css.summaryTitle}>{t('policy.decisions.title')}</h2>
            {active !== undefined
              ? <Tag tone="info">{t('policy.versionBadge', { version: active.version })}</Tag>
              : null}
          </div>
          <p className={css.summarySubtitle}>{t('policy.subtitle')}</p>
        </div>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { setModalOpen(true) }}>
          {t('policy.add.open')}
        </Button>
      </section>

      {snapshot.actionError !== undefined && snapshot.actionError !== ''
        ? <p className={css.errorText}>{snapshot.actionError}</p>
        : null}

      <div className={css.grid}>
        <section className={css.panelCard} aria-label={t('policy.decisions.title')}>
          <header className={css.panelHeader}>
            <h3 className={css.panelTitle}>{t('policy.decisions.title')}</h3>
            <Tag tone="neutral">{decisions.length}</Tag>
          </header>
          {decisions.length === 0
            ? <p className={css.emptyInline}>{t('policy.decisions.empty')}</p>
            : (
              <ul className={css.decisionList}>
                {decisions.map(entry => (
                  <li key={entry.id} className={css.decisionCard}>
                    <header className={css.decisionHeader}>
                      <Tag tone={entry.kind === 'rejection' ? 'danger' : 'success'}>
                        {t(`policy.kind.${entry.kind}`)}
                      </Tag>
                      <Button variant="ghost" size="sm" disabled={busy}
                        onClick={() => { void onPolicyRemoveEntry(entry.id) }}>
                        {t('policy.decisions.remove')}
                      </Button>
                    </header>
                    <p className={css.decisionStatement}>{entry.statement}</p>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className={css.panelCard} aria-label={t('policy.approvals.title')}>
          <header className={css.panelHeader}>
            <h3 className={css.panelTitle}>{t('policy.approvals.title')}</h3>
            <Tag tone="warning">{categories.length}/{ACTION_CATEGORIES.length}</Tag>
          </header>
          <p className={css.panelHint}>{t('policy.approvals.hint')}</p>
          <ul className={css.categoryList}>
            {ACTION_CATEGORIES.map((category: ActionCategory) => {
              const required = categories.includes(category)
              return (
                <li key={category} className={css.categoryRow}>
                  <div className={css.categoryMeta}>
                    <span className={css.categoryLabel}>{t(`policy.category.${category}`)}</span>
                    <code className={css.categoryCode}>{category}</code>
                  </div>
                  <Button
                    variant={required ? 'outline' : 'ghost'}
                    size="sm"
                    disabled={busy || active === undefined}
                    onClick={() => { void onPolicyToggleCategory(category) }}
                  >
                    {required ? t('policy.approvals.required') : t('policy.approvals.auto')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      {policies.length > 0
        ? (
          <section className={css.panelCard} aria-label={t('policy.history.title')}>
            <header className={css.panelHeader}>
              <h3 className={css.panelTitle}>{t('policy.history.title')}</h3>
              <Tag tone="neutral">{policies.length}</Tag>
            </header>
            <ul className={css.historyList}>
              {policies.map((policy, idx) => (
                <li key={policy.version} className={css.historyCard}>
                  <div className={css.historyHeader}>
                    <Tag tone={idx === 0 ? 'info' : 'outline'}>v{policy.version}</Tag>
                    <span className={css.meta}>{new Date(policy.createdAt).toLocaleString()}</span>
                  </div>
                  <span className={css.meta}>
                    {t('policy.history.summary', {
                      decisions: policy.decisions.length,
                      categories: policy.approvalCategories.length,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
        : null}

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false) }}
        title={t('policy.add.title')}
        closeLabel={t('policy.cancel')}
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => { setModalOpen(false) }}>{t('policy.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={!valid || busy} onClick={submit}>{t('policy.add.submit')}</Button>
          </>
        )}
      >
        <label className={css.field}>
          <span>{t('policy.add.kind')}</span>
          <DshSelect
            value={kind}
            options={POLICY_ENTRY_KINDS.map(option => ({ value: option, label: t(`policy.kind.${option}`) }))}
            onChange={next => { setKind(next as PolicyEntryKind) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('policy.add.statement')}</span>
          <textarea
            className={css.textArea}
            value={statement}
            placeholder={t('policy.add.statementPlaceholder')}
            onChange={event => { setStatement(event.target.value) }}
          />
        </label>
      </Modal>
    </div>
  )
}
