import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  AgentDescriptor,
  AgentQuotaBucket,
  AgentQuotaSnapshot,
  ExternalAgentId,
  ExternalAgentSettings,
  ExternalAgentsConfigSnapshot,
  SessionAgentId,
} from '../types.ts'
import type { ExternalAgentsLocaleKey } from './locales.ts'
import { formatCustomModelsText, parseCustomModelsText } from './model-picker-core.ts'
import css from './ExternalAgentsSettings.module.css'

export interface ExternalAgentsSettingsInjected {
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly refreshQuota: (agentId?: ExternalAgentId) => Promise<readonly AgentDescriptor[]>
  readonly fetchConfig: () => Promise<ExternalAgentsConfigSnapshot>
  readonly updateConfig: (input: {
    readonly defaultAgent?: SessionAgentId
    readonly agentId?: ExternalAgentId
    readonly settings?: ExternalAgentSettings
  }) => Promise<ExternalAgentsConfigSnapshot>
}

export type ExternalAgentsSettingsProps =
  PropsRuntime<'settings.section'>
  & InjectFace<ExternalAgentsSettingsInjected>
  & PropsLocale<'externalAgents'>

function formatIsoShort(iso: string | undefined): string {
  if (iso === undefined) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return new Date(ms).toLocaleString([], {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function progressClassForBucket(bucket: AgentQuotaBucket): string {
  const base = css.progressFill ?? ''
  const remaining = bucket.remainingPercent
  if (bucket.status === 'rejected' || (remaining !== undefined && remaining <= 10)) {
    return `${base} ${css.progressError ?? ''}`
  }
  if (bucket.status === 'warning' || (remaining !== undefined && remaining <= 30)) {
    return `${base} ${css.progressWarn ?? ''}`
  }
  return base
}

function QuotaSection({
  agent,
  refreshing,
  onRefresh,
  t,
}: {
  readonly agent: AgentDescriptor
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly t: ExternalAgentsSettingsProps['t']
}) {
  const quota: AgentQuotaSnapshot | undefined = agent.quota
  const observedText = formatIsoShort(quota?.observedAt)

  return (
    <div className={css.quotaBox}>
      <div className={css.quotaHeader}>
        <span className={css.quotaTitle}>{t('settingsQuotaTitle')}</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {observedText !== '' && (
            <span className={css.quotaObserved}>{t('settingsQuotaObservedAt', { time: observedText })}</span>
          )}
          {agent.id !== 'pi' && (
            <button
              type="button"
              className={`${css.button} ${css.buttonSmall}`}
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshing ? t('settingsQuotaRefreshing') : t('settingsQuotaRefresh')}
            </button>
          )}
        </div>
      </div>

      {quota?.status === 'ok' && quota.groups !== undefined && quota.groups.length > 0 ? (
        quota.groups.map(group => (
          <div key={group.name} className={css.quotaGroup}>
            <span className={css.quotaGroupName}>{group.name}</span>
            {group.buckets.map((bucket) => {
              const remaining = bucket.remainingPercent
              const resetText = formatIsoShort(bucket.resetAt)
              return (
                <div key={bucket.id} className={css.bucketRow}>
                  <div className={css.bucketTop}>
                    <span className={css.bucketLabel}>{bucket.label}</span>
                    <span className={css.bucketStats}>
                      {remaining !== undefined && (
                        <span>{t('settingsQuotaRemaining', { pct: Math.round(remaining) })}</span>
                      )}
                      {resetText !== '' && (
                        <span className={css.bucketReset}>{t('settingsQuotaResetAt', { time: resetText })}</span>
                      )}
                    </span>
                  </div>
                  {remaining !== undefined && (
                    <div className={css.progressTrack}>
                      <div
                        className={progressClassForBucket(bucket)}
                        style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))
      ) : (
        <span className={css.fieldHint}>
          {quota?.status === 'unsupported' || agent.id === 'pi'
            ? t('settingsQuotaUnsupported')
            : quota?.note ?? (agent.id === 'agy' ? t('settingsQuotaActiveHint') : t('settingsQuotaPassiveHint'))}
        </span>
      )}
    </div>
  )
}

function AgentConfigCard({
  agent,
  settings,
  refreshing,
  saving,
  savedNotice,
  onRefresh,
  onSaveSettings,
  t,
}: {
  readonly agent: AgentDescriptor
  readonly settings: ExternalAgentSettings
  readonly refreshing: boolean
  readonly saving: boolean
  readonly savedNotice: boolean
  readonly onRefresh: () => void
  readonly onSaveSettings: (next: ExternalAgentSettings) => void
  readonly t: ExternalAgentsSettingsProps['t']
}) {
  const [customDraft, setCustomDraft] = useState<string>(() => formatCustomModelsText(settings.customModels))

  useEffect(() => {
    setCustomDraft(formatCustomModelsText(settings.customModels))
  }, [settings.customModels])

  const extId = agent.id as ExternalAgentId
  const efforts = agent.reasoning?.efforts ?? []
  const models = useMemo(() => {
    if (agent.models.length > 0) return agent.models
    return [{ id: 'default', name: t('modelDefaultLabel') }]
  }, [agent.models, t])

  return (
    <article className={css.card}>
      <div className={css.cardHeader}>
        <div className={css.cardTitleGroup}>
          <h3 className={css.cardTitle}>{agent.label}</h3>
          <span className={`${css.badge} ${agent.available ? css.badgeReady : css.badgeMissing}`}>
            {agent.available ? t('settingsStatusReady') : t('settingsStatusMissing')}
          </span>
          {agent.version !== undefined && (
            <span className={css.badge}>{`${t('settingsVersionLabel')}: ${agent.version}`}</span>
          )}
          {agent.authStatus?.summary !== undefined && (
            <span className={css.badge}>{`${t('settingsAuthLabel')}: ${agent.authStatus.summary}`}</span>
          )}
          <span className={css.badge}>{t('settingsModelsCount', { count: models.length })}</span>
        </div>
        {savedNotice && <span className={css.saveStatus}>{t('settingsSaved')}</span>}
      </div>

      <div className={css.metaGrid}>
        {agent.executablePath !== undefined && (
          <span className={css.metaItem}>
            <span className={css.metaKey}>{t('settingsPathLabel')}:</span>
            <span className={css.mono}>{agent.executablePath}</span>
          </span>
        )}
        {!agent.available && agent.reason !== undefined && (
          <span className={css.errorText}>{agent.reason}</span>
        )}
      </div>

      <QuotaSection agent={agent} refreshing={refreshing} onRefresh={onRefresh} t={t} />

      <div className={css.configGrid}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('settingsDefaultModelLabel')}</span>
          <select
            className={`${css.select} ${css.selectFull}`}
            disabled={saving}
            value={settings.defaultModel ?? agent.defaultModel ?? 'default'}
            onChange={(e) => {
              const value = e.target.value
              const { defaultModel: _removed, ...rest } = settings
              onSaveSettings(value === 'default' ? rest : { ...rest, defaultModel: value })
            }}
          >
            {models.map(item => (
              <option key={item.id} value={item.id}>
                {item.id === 'default' ? t('modelDefaultLabel') : item.name}
              </option>
            ))}
          </select>
        </label>

        {efforts.length > 0 && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('settingsDefaultEffortLabel')}</span>
            <select
              className={`${css.select} ${css.selectFull}`}
              disabled={saving}
              value={settings.defaultReasoningEffort ?? ''}
              onChange={(e) => {
                const value = e.target.value
                const { defaultReasoningEffort: _removed, ...rest } = settings
                onSaveSettings(value === '' ? rest : { ...rest, defaultReasoningEffort: value })
              }}
            >
              <option value="">{t('modelEffortDefault')}</option>
              {efforts.map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={css.customModelsRow}>
        <span className={css.fieldLabel}>{t('settingsCustomModelsLabel')}</span>
        <div className={css.customModelsControls}>
          <textarea
            className={css.textarea}
            placeholder={t('settingsCustomModelsPlaceholder')}
            value={customDraft}
            disabled={saving}
            onChange={e => setCustomDraft(e.target.value)}
          />
          <button
            type="button"
            className={`${css.button} ${css.buttonSmall}`}
            disabled={saving}
            onClick={() => {
              const parsed = parseCustomModelsText(customDraft)
              onSaveSettings({
                ...settings,
                customModels: parsed,
              })
            }}
          >
            {saving ? t('settingsSaving') : t('settingsCustomModelsSave')}
          </button>
        </div>
      </div>

      {/* Keep reference to extId to verify per-card identity in DOM inspections. */}
      <span data-external-agent={extId} hidden />
    </article>
  )
}

export function ExternalAgentsSettingsIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <IconAgentPresetOutlineRegular size={size} />
}

export function ExternalAgentsSettings({
  fetchCatalog,
  refreshQuota,
  fetchConfig,
  updateConfig,
  t,
}: ExternalAgentsSettingsProps) {
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>([])
  const [config, setConfig] = useState<ExternalAgentsConfigSnapshot>({ defaultAgent: 'native', agents: {} })
  const [refreshingTarget, setRefreshingTarget] = useState<'all' | ExternalAgentId | null>(null)
  const [savingTarget, setSavingTarget] = useState<string | null>(null)
  const [savedTarget, setSavedTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [catalogItems, cfg] = await Promise.all([fetchCatalog(), fetchConfig()])
      setAgents(catalogItems)
      setConfig(cfg)
      setError(null)
    } catch (err) {
      setError(t('settingsLoadError', { message: err instanceof Error ? err.message : String(err) }))
    }
  }, [fetchCatalog, fetchConfig, t])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const handleRefresh = (agentId?: ExternalAgentId): void => {
    setRefreshingTarget(agentId ?? 'all')
    setError(null)
    void refreshQuota(agentId).then((next) => {
      setAgents(next)
    }).catch((err: unknown) => {
      setError(t('settingsLoadError', { message: err instanceof Error ? err.message : String(err) }))
    }).finally(() => {
      setRefreshingTarget(null)
    })
  }

  const markSaved = (target: string): void => {
    setSavedTarget(target)
    setTimeout(() => {
      setSavedTarget(curr => (curr === target ? null : curr))
    }, 1800)
  }

  const handleDefaultAgentChange = (nextDefault: SessionAgentId): void => {
    setSavingTarget('defaultAgent')
    setError(null)
    void updateConfig({ defaultAgent: nextDefault }).then((next) => {
      setConfig(next)
      markSaved('defaultAgent')
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setSavingTarget(null)
    })
  }

  const handleSaveAgent = (agentId: ExternalAgentId, settings: ExternalAgentSettings): void => {
    setSavingTarget(agentId)
    setError(null)
    void updateConfig({ agentId, settings }).then(async (next) => {
      setConfig(next)
      const catalogItems = await fetchCatalog().catch(() => agents)
      setAgents(catalogItems)
      markSaved(agentId)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      setSavingTarget(null)
    })
  }

  const externalAgents = useMemo(
    () => agents.filter(item => item.id !== 'native'),
    [agents],
  )

  return (
    <section className={css.page}>
      <div className={css.header}>
        <div className={css.titleGroup}>
          <h2 className={css.title}>{t('settingsTitle')}</h2>
          <p className={css.subtitle}>{t('settingsSubtitle')}</p>
        </div>
        <button
          type="button"
          className={css.button}
          disabled={refreshingTarget !== null}
          onClick={() => handleRefresh()}
        >
          {refreshingTarget === 'all' ? t('settingsRefreshing') : t('settingsRefreshAll')}
        </button>
      </div>

      {error !== null && <p className={css.errorText} role="alert">{error}</p>}

      <div className={css.card}>
        <div className={css.globalRow}>
          <div className={css.globalCopy}>
            <span className={css.fieldTitle}>{t('settingsDefaultAgentLabel')}</span>
            <span className={css.fieldHint}>{t('settingsDefaultAgentHint')}</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {savedTarget === 'defaultAgent' && <span className={css.saveStatus}>{t('settingsSaved')}</span>}
            <select
              className={css.select}
              disabled={savingTarget === 'defaultAgent'}
              value={config.defaultAgent}
              onChange={e => handleDefaultAgentChange(e.target.value as SessionAgentId)}
            >
              <option value="native">{t('nativeName')}</option>
              {externalAgents.map(item => (
                <option key={item.id} value={item.id}>
                  {item.available ? item.label : `${item.label} (${t('unavailable')})`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {externalAgents.map((agent) => {
        const extId = agent.id as ExternalAgentId
        return (
          <AgentConfigCard
            key={extId}
            agent={agent}
            settings={config.agents[extId] ?? {}}
            refreshing={refreshingTarget === 'all' || refreshingTarget === extId}
            saving={savingTarget === extId}
            savedNotice={savedTarget === extId}
            onRefresh={() => handleRefresh(extId)}
            onSaveSettings={next => handleSaveAgent(extId, next)}
            t={t}
          />
        )
      })}
    </section>
  )
}
