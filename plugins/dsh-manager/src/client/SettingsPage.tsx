/** The settings page: 2-column DSH card layout for general, IM bridge, connections, mappings, and triggers. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectionsPage } from './ConnectionsPage.tsx'
import { MappingsPage } from './MappingsPage.tsx'
import { TriggersPage } from './TriggersPage.tsx'
import type { ConnectionsInjected } from './connections-source.ts'
import type { ImSettingsInjected } from './im-settings-source.ts'
import type { MappingsInjected } from './mappings-source.ts'
import type { TriggersInjected } from './triggers-source.ts'
import type { UiSettingsInjected } from './ui-settings-source.ts'
import { DshSelect } from './DshSelect.tsx'
import css from './SettingsPage.module.css'


/** Settings page props: the merged injection the tabbed panel already holds. */
export type SettingsPageProps = PropsRuntime<'main'> & InjectFace<ConnectionsInjected & MappingsInjected & TriggersInjected & UiSettingsInjected & ImSettingsInjected> & PropsLocale<'dshManager'>

/** Render the 2-column config cards; every add/edit runs in a modal. */
export function SettingsPage(props: SettingsPageProps) {
  const { t } = props
  return (
    <div className={css.page}>
      <section className={`${css.section} ${css.sectionFull}`}>
        <GeneralSettingsSection {...props} />
      </section>
      <section className={`${css.section} ${css.sectionFull}`}>
        <ImSettingsSection {...props} />
      </section>
      <section className={css.section}>
        <p className={css.sectionDesc}>{t('settings.connections.desc')}</p>
        <ConnectionsPage {...props} variant="embedded" />
      </section>
      <section className={css.section}>
        <p className={css.sectionDesc}>{t('settings.mappings.desc')}</p>
        <MappingsPage {...props} variant="embedded" />
      </section>
      <section className={`${css.section} ${css.sectionFull}`}>
        <p className={css.sectionDesc}>{t('settings.triggers.desc')}</p>
        <TriggersPage {...props} variant="embedded" />
      </section>
    </div>
  )
}

/** The general section: the panel's custom display name, Steward batch limit, and save paths. */
function GeneralSettingsSection({ useUiSettings, onTitleSave, onEvalBatchSizeSave, t }: SettingsPageProps) {
  const settings = useUiSettings(snapshot => snapshot)
  const [title, setTitle] = useState('')
  const [saved, setSaved] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batchSize, setBatchSize] = useState(String(settings.settings?.evalBatchSize ?? 10))
  const [batchDirty, setBatchDirty] = useState(false)
  const [batchSaved, setBatchSaved] = useState(false)
  const [batchFailed, setBatchFailed] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const stored = settings.settings?.title ?? ''

  useEffect(() => {
    if (settings.status !== 'ready' || batchDirty) return
    setBatchSize(String(settings.settings?.evalBatchSize ?? 10))
  }, [settings.status, settings.settings?.evalBatchSize, batchDirty])

  const submit = (): void => {
    if (busy) return
    setBusy(true)
    setSaved(false)
    setFailed(false)
    void onTitleSave(title.trim() === '' ? '' : title.trim())
      .then((accepted) => {
        if (accepted) {
          setTitle('')
          setSaved(true)
        } else {
          setFailed(true)
        }
      })
      .finally(() => { setBusy(false) })
  }

  const submitBatchSize = (): void => {
    if (batchBusy) return
    const parsed = Number.parseInt(batchSize, 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
      setBatchFailed(true)
      return
    }
    setBatchBusy(true)
    setBatchSaved(false)
    setBatchFailed(false)
    void onEvalBatchSizeSave(parsed)
      .then(ok => {
        if (ok) {
          setBatchSaved(true)
          setBatchDirty(false)
        } else {
          setBatchFailed(true)
        }
      })
      .finally(() => { setBatchBusy(false) })
  }

  return (
    <>
      <div className={css.sectionLead}>
        <h2 className={css.sectionTitle}>{t('settings.general')}</h2>
        <p className={css.sectionDesc}>{t('settings.general.desc')}</p>
      </div>
      <div className={css.general}>
        <label className={css.generalField}>
          <span>{t('settings.general.title')}</span>
          <input
            className={css.generalInput}
            value={title}
            placeholder={stored !== '' ? stored : t('settings.general.titlePlaceholder')}
            onChange={event => { setTitle(event.target.value); setSaved(false); setFailed(false) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
          />
        </label>
        <Button variant="primary" size="sm" disabled={busy} onClick={submit}>
          {t('settings.general.save')}
        </Button>
        {saved ? <span className={css.generalSaved}>{t('settings.general.saved')}</span> : null}
        {failed ? <span className={css.generalFailed}>{t('settings.general.failed')}</span> : null}
      </div>
      <div className={css.general}>
        <label className={css.generalField}>
          <span>{t('settings.general.batchSize')}</span>
          <input
            type="number"
            min={1}
            max={50}
            className={css.generalInput}
            value={batchSize}
            onChange={event => { setBatchSize(event.target.value); setBatchDirty(true); setBatchSaved(false); setBatchFailed(false) }}
            onKeyDown={event => { if (event.key === 'Enter') submitBatchSize() }}
          />
        </label>
        <Button variant="outline" size="sm" disabled={batchBusy} onClick={submitBatchSize}>
          {t('settings.general.batchSizeSave')}
        </Button>
        {batchSaved ? <span className={css.generalSaved}>{t('settings.general.batchSizeSaved')}</span> : null}
        {batchFailed ? <span className={css.generalFailed}>{t('settings.general.failed')}</span> : null}
      </div>
    </>
  )
}

function ImSettingsSection({ useImSettings, onImSettingsSave, onImSettingsRefresh, onImTestSend, t }: SettingsPageProps) {
  const snapshot = useImSettings(value => value)
  const [enabled, setEnabled] = useState(snapshot.settings.enabled)
  const [botId, setBotId] = useState(snapshot.settings.botId ?? '')
  const [targetId, setTargetId] = useState(snapshot.settings.targetId ?? '')
  const [notifyAttention, setNotifyAttention] = useState(snapshot.settings.notifyAttention)
  const [notifyProgress, setNotifyProgress] = useState(snapshot.settings.notifyProgress)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<'saved' | 'failed' | undefined>()
  const [testFeedback, setTestFeedback] = useState<{ readonly ok: boolean; readonly message?: string } | undefined>()

  useEffect(() => {
    if (snapshot.status !== 'ready') return
    setEnabled(snapshot.settings.enabled)
    setBotId(snapshot.settings.botId ?? snapshot.bots[0]?.botId ?? '')
    setTargetId(snapshot.settings.targetId ?? '')
    setNotifyAttention(snapshot.settings.notifyAttention)
    setNotifyProgress(snapshot.settings.notifyProgress)
  }, [snapshot.status, snapshot.settings, snapshot.bots])

  const selectedBot = snapshot.bots.find(bot => bot.botId === botId)
  const targets = selectedBot?.targets ?? []

  useEffect(() => {
    if (selectedBot === undefined) return
    if (targetId !== '' && targets.some(item => item.targetId === targetId)) return
    setTargetId(targets[0]?.targetId ?? '')
  }, [botId, selectedBot, targets, targetId])

  const save = (): void => {
    if (busy) return
    setBusy(true)
    setSaveFeedback(undefined)
    void onImSettingsSave({
      enabled,
      botId,
      targetId,
      notifyAttention,
      notifyProgress,
    })
      .then(ok => { setSaveFeedback(ok ? 'saved' : 'failed') })
      .finally(() => { setBusy(false) })
  }

  const sendTest = (): void => {
    if (testing || botId === '' || targetId === '') return
    setTesting(true)
    setTestFeedback(undefined)
    void onImTestSend({ botId, targetId })
      .then(result => {
        setTestFeedback(result.sent ? { ok: true } : { ok: false, message: result.error ?? 'unknown error' })
      })
      .finally(() => { setTesting(false) })
  }

  return (
    <>
      <div className={css.sectionLead}>
        <h2 className={css.sectionTitle}>{t('settings.im')}</h2>
        <p className={css.sectionDesc}>{t('settings.im.desc')}</p>
      </div>
      {snapshot.status === 'ready' && !snapshot.available ? (
        <p className={css.imNotice}>{t('settings.im.unavailable')}</p>
      ) : (
        <div className={css.imStack}>
          <label className={css.imCheck}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={event => { setEnabled(event.target.checked); setSaveFeedback(undefined) }}
            />
            <span>{t('settings.im.enabled')}</span>
          </label>
          <div className={css.imRow}>
            <label className={css.generalField}>
              <span>{t('settings.im.bot')}</span>
              <DshSelect
                value={botId}
                options={[
                  { value: '', label: t('settings.im.botPlaceholder') },
                  ...snapshot.bots.map(bot => ({ value: bot.botId, label: `${bot.channel} (${bot.botId})` })),
                ]}
                onChange={(nextBotId) => {
                  const nextBot = snapshot.bots.find(item => item.botId === nextBotId)
                  setBotId(nextBotId)
                  setTargetId(nextBot?.targets[0]?.targetId ?? '')
                  setSaveFeedback(undefined)
                }}
              />
            </label>
            <label className={css.generalField}>
              <span>{t('settings.im.target')}</span>
              <DshSelect
                value={targetId}
                disabled={targets.length === 0}
                options={[
                  { value: '', label: t('settings.im.targetPlaceholder') },
                  ...targets.map(target => ({
                    value: target.targetId,
                    label: target.name ? `${target.name} (${target.targetId})` : `${target.targetId} [${target.kind}]`,
                  })),
                ]}
                onChange={(next) => { setTargetId(next); setSaveFeedback(undefined) }}
              />
            </label>
            <Button variant="outline" size="sm" onClick={onImSettingsRefresh}>
              {t('settings.im.refresh')}
            </Button>
          </div>
          {selectedBot !== undefined && targets.length === 0 ? (
            <p className={css.imNotice}>{t('settings.im.targetHint')}</p>
          ) : null}
          <div className={css.imRow}>
            <span className={css.imNotice}>{t('settings.im.scopes')}</span>
            <div className={css.imCheckList}>
              <label className={css.imCheck}>
                <input
                  type="checkbox"
                  checked={notifyAttention}
                  onChange={event => { setNotifyAttention(event.target.checked); setSaveFeedback(undefined) }}
                />
                <span>{t('settings.im.scopeAttention')}</span>
              </label>
              <label className={css.imCheck}>
                <input
                  type="checkbox"
                  checked={notifyProgress}
                  onChange={event => { setNotifyProgress(event.target.checked); setSaveFeedback(undefined) }}
                />
                <span>{t('settings.im.scopeProgress')}</span>
              </label>
            </div>
          </div>
          <div className={css.imActions}>
            <Button variant="primary" size="sm" disabled={busy} onClick={save}>
              {t('settings.im.save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={testing || !snapshot.available || botId === '' || targetId === ''}
              onClick={sendTest}
            >
              {t('settings.im.test')}
            </Button>
            {saveFeedback === 'saved' ? <span className={css.generalSaved}>{t('settings.im.saved')}</span> : null}
            {saveFeedback === 'failed' ? <span className={css.generalFailed}>{t('settings.im.failed')}</span> : null}
            {testFeedback?.ok ? <span className={css.generalSaved}>{t('settings.im.testOk')}</span> : null}
            {testFeedback && !testFeedback.ok ? (
              <span className={css.generalFailed}>{t('settings.im.testFailed', { error: testFeedback.message ?? '' })}</span>
            ) : null}
          </div>
          {snapshot.lastError ? (
            <p className={css.imError}>{t('settings.im.lastError', { error: snapshot.lastError })}</p>
          ) : null}
        </div>
      )}
    </>
  )
}
