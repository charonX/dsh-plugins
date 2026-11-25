/**
 * System & DSH Dashboard main-panel page.
 *
 * @module @charonx/dsh-system-dashboard/client/DashboardPage
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DashboardSnapshot,
  WifiSettings,
  WifiSettingsPatch,
  WifiStateView,
  WifiWatchdogPhase,
} from '../shared/types.ts'
import {
  clearWifiEvents,
  connectWifiSsid,
  fetchDashboardSnapshot,
  refreshWifiStatus,
  setWifiPower,
  triggerWifiRecovery,
  updateWifiSettings,
} from './api.ts'
import { DshSelect } from './DshSelect.tsx'
import { DualSparkline } from './Sparkline.tsx'
import {
  buttonStyle,
  cardStyle,
  COLORS,
  inputStyle,
  monoStyle,
  primaryButtonStyle,
  subCardStyle,
} from './tokens.ts'

export type Translate = TranslateNS<'system-dashboard'>

export interface DashboardPageProps {
  readonly t: Translate
  readonly onOpenSession?: (sessionId: string) => void
}

type TabKey = 'overview' | 'wifi' | 'dsh' | 'system'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const val = bytes / (1024 ** idx)
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const days = Math.floor(s / 86400)
  const hrs = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days}d ${hrs}h ${mins}m`
  if (hrs > 0) return `${hrs}h ${mins}m`
  return `${mins}m ${s % 60}s`
}

function formatTime(ts: number | null | undefined, neverLabel: string): string {
  if (!ts) return neverLabel
  return new Date(ts).toLocaleTimeString([], { hour12: false })
}

function StatusBadge({
  label,
  tone,
}: {
  readonly label: string
  readonly tone: 'success' | 'warn' | 'error' | 'brand' | 'neutral'
}): ReactElement {
  const toneColor =
    tone === 'success' ? COLORS.success
      : tone === 'warn' ? COLORS.warn
        : tone === 'error' ? COLORS.error
          : tone === 'brand' ? COLORS.brand
            : COLORS.secondary

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '2px 8px',
        borderRadius: COLORS.radiusSm,
        fontSize: '11px',
        fontWeight: 500,
        border: `0.5px solid ${toneColor}`,
        color: toneColor,
        background: COLORS.bgLayer1,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '999px',
          background: toneColor,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  )
}

function ProgressBar({
  pct,
  color,
}: {
  readonly pct: number
  readonly color: string
}): ReactElement {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      style={{
        width: '100%',
        height: '6px',
        borderRadius: '999px',
        background: COLORS.bgLayer3,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${clamped}%`,
          height: '100%',
          background: color,
          transition: 'width 0.25s ease',
        }}
      />
    </div>
  )
}

export function DashboardPage({ t, onOpenSession }: DashboardPageProps): ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [livePoll, setLivePoll] = useState(true)
  const [tab, setTab] = useState<TabKey>('overview')

  // Wi-Fi action states
  const [wifiBusy, setWifiBusy] = useState(false)
  const [wifiNotice, setWifiNotice] = useState<string | null>(null)
  const [draftSettings, setDraftSettings] = useState<WifiSettings | null>(null)
  const [settingsDirty, setSettingsDirty] = useState(false)

  const loadSnapshot = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const next = await fetchDashboardSnapshot()
      setSnapshot(next)
      setError(null)
      setDraftSettings((prev) => (prev === null || !settingsDirty ? next.wifi.settings : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      if (manual) setRefreshing(false)
    }
  }, [settingsDirty])

  useEffect(() => {
    void loadSnapshot(false)
  }, [loadSnapshot])

  useEffect(() => {
    if (!livePoll) return undefined
    const id = setInterval(() => {
      void loadSnapshot(false)
    }, 2000)
    return () => clearInterval(id)
  }, [livePoll, loadSnapshot])

  const applyWifiView = (view: WifiStateView, notice?: string) => {
    setSnapshot((prev) => (prev ? { ...prev, wifi: view } : prev))
    setDraftSettings(view.settings)
    setSettingsDirty(false)
    if (notice) setWifiNotice(notice)
  }

  const handleSaveSettings = async (patch?: WifiSettingsPatch) => {
    setWifiBusy(true)
    setWifiNotice(null)
    try {
      const payload: WifiSettingsPatch = patch ?? (draftSettings ?? {})
      const view = await updateWifiSettings(payload)
      applyWifiView(view, t('wifiSavedNotice'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const handleTriggerRecovery = async (ssid?: string) => {
    setWifiBusy(true)
    setWifiNotice(null)
    try {
      const view = await triggerWifiRecovery(ssid)
      applyWifiView(view)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const handleConnectSsid = async (ssid: string) => {
    setWifiBusy(true)
    setWifiNotice(null)
    try {
      const view = await connectWifiSsid(ssid)
      applyWifiView(view)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const handleTogglePower = async (on: boolean) => {
    setWifiBusy(true)
    setWifiNotice(null)
    try {
      const view = await setWifiPower(on)
      applyWifiView(view)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const handleRefreshWifi = async () => {
    setWifiBusy(true)
    try {
      const view = await refreshWifiStatus()
      applyWifiView(view)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const handleClearEvents = async () => {
    setWifiBusy(true)
    try {
      const view = await clearWifiEvents()
      applyWifiView(view)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWifiBusy(false)
    }
  }

  const chartData = useMemo(() => {
    const pts = snapshot?.system.history ?? []
    return {
      cpu: pts.map(p => p.cpuPct),
      mem: pts.map(p => p.memPct),
      rx: pts.map(p => p.rxBytesPerSec),
      tx: pts.map(p => p.txBytesPerSec),
    }
  }, [snapshot])

  const phaseMeta = (phase: WifiWatchdogPhase, failures: number, threshold: number): {
    label: string
    tone: 'success' | 'warn' | 'error' | 'brand' | 'neutral'
  } => {
    switch (phase) {
      case 'healthy':
        return { label: t('phaseHealthy'), tone: 'success' }
      case 'degraded':
        return { label: t('phaseDegraded', { count: failures, threshold }), tone: 'warn' }
      case 'recovering':
        return { label: t('phaseRecovering'), tone: 'brand' }
      case 'cooldown':
        return { label: t('phaseCooldown'), tone: 'warn' }
      case 'disabled':
        return { label: t('phaseDisabled'), tone: 'neutral' }
      case 'unsupported':
        return { label: t('phaseUnsupported'), tone: 'neutral' }
    }
  }

  const wifiStatus = snapshot?.wifi.status
  const wifiSettings = draftSettings ?? snapshot?.wifi.settings
  const wifiPhase = wifiStatus
    ? phaseMeta(wifiStatus.phase, wifiStatus.consecutiveFailures, wifiSettings?.failureThreshold ?? 2)
    : { label: '-', tone: 'neutral' as const }

  const usageColor = (pct: number): string =>
    pct >= 85 ? COLORS.error : pct >= 65 ? COLORS.warn : COLORS.brand

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: COLORS.bgBase,
        color: COLORS.text,
        boxSizing: 'border-box',
        padding: 'calc(18px + var(--dsh-frame-top-clearance, 0px)) 24px 28px',
      }}
    >
      <div style={{ maxWidth: '1280px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: COLORS.text }}>
                {t('title')}
              </h1>
              {snapshot && (
                <span
                  style={{
                    ...monoStyle,
                    fontSize: '11px',
                    color: COLORS.secondary,
                    background: COLORS.bgLayer2,
                    border: `0.5px solid ${COLORS.border}`,
                    borderRadius: COLORS.radiusSm,
                    padding: '2px 8px',
                  }}
                >
                  {snapshot.system.hostname} · {snapshot.system.osVersion ?? `${snapshot.system.platform} ${snapshot.system.release}`} · {t('uptime')} {formatDuration(snapshot.system.uptimeSec)}
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: '12px', color: COLORS.secondary }}>
              {t('subtitle')}
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => setLivePoll(v => !v)}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '999px',
                  background: livePoll ? COLORS.success : COLORS.tertiary,
                }}
              />
              {livePoll ? t('liveOn') : t('livePaused')}
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => void loadSnapshot(true)}
              disabled={refreshing}
            >
              {refreshing ? t('refreshing') : t('refresh')}
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            borderBottom: `0.5px solid ${COLORS.border}`,
            paddingBottom: '10px',
            flexWrap: 'wrap',
          }}
        >
          {(
            [
              ['overview', t('tabOverview')],
              ['wifi', t('tabWifi')],
              ['dsh', t('tabDsh')],
              ['system', t('tabSystem')],
            ] as const
          ).map(([key, label]) => {
            const active = tab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  ...buttonStyle,
                  background: active ? COLORS.brand : COLORS.bgLayer2,
                  borderColor: active ? COLORS.brand : COLORS.border,
                  color: active ? COLORS.onBrand : COLORS.secondary,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: COLORS.radiusMd,
              border: `0.5px solid ${COLORS.error}`,
              background: COLORS.bgLayer2,
              color: COLORS.error,
              fontSize: '13px',
            }}
          >
            {t('errorLoad', { message: error })}
          </div>
        )}

        {loading && !snapshot ? (
          <div style={{ padding: '40px', textAlign: 'center', color: COLORS.tertiary, fontSize: '13px' }}>
            {t('chartWaiting')}
          </div>
        ) : snapshot && (
          <>
            {/* Top 4 KPI Cards (always visible on Overview, also concise summary) */}
            {tab === 'overview' && (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {/* CPU KPI */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: COLORS.secondary }}>{t('cpuTitle')}</span>
                      <span style={{ fontSize: '11px', color: COLORS.tertiary }}>
                        {t('cores', { count: snapshot.system.cpu.cores })} · {snapshot.system.cpu.arch}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ ...monoStyle, fontSize: '24px', fontWeight: 700, color: COLORS.text }}>
                        {snapshot.system.cpu.usagePct.toFixed(1)}%
                      </span>
                      <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.secondary }}>
                        {t('cpuUserSys', {
                          user: snapshot.system.cpu.userPct.toFixed(1),
                          sys: snapshot.system.cpu.sysPct.toFixed(1),
                        })}
                      </span>
                    </div>
                    <ProgressBar pct={snapshot.system.cpu.usagePct} color={usageColor(snapshot.system.cpu.usagePct)} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: COLORS.tertiary }}>
                      <span>{t('loadAvg')}</span>
                      <span style={monoStyle}>
                        {snapshot.system.cpu.loadAvg.map(v => v.toFixed(2)).join(' / ')}
                      </span>
                    </div>
                  </div>

                  {/* Memory KPI */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: COLORS.secondary }}>{t('memTitle')}</span>
                      <span style={{ fontSize: '11px', color: COLORS.tertiary }}>
                        {snapshot.system.memory.source === 'darwin-vm-stat'
                          ? t('memSourceVm')
                          : snapshot.system.memory.source === 'linux-proc-meminfo'
                            ? t('memSourceLinux')
                            : t('memSourceOs')}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ ...monoStyle, fontSize: '24px', fontWeight: 700, color: COLORS.text }}>
                        {snapshot.system.memory.usedPct.toFixed(1)}%
                      </span>
                      <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.secondary }}>
                        {formatBytes(snapshot.system.memory.usedBytes)} / {formatBytes(snapshot.system.memory.totalBytes)}
                      </span>
                    </div>
                    <ProgressBar pct={snapshot.system.memory.usedPct} color={usageColor(snapshot.system.memory.usedPct)} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: COLORS.tertiary }}>
                      <span>{t('memSwap')}</span>
                      <span style={monoStyle}>
                        {snapshot.system.memory.swapTotalBytes !== undefined
                          ? `${formatBytes(snapshot.system.memory.swapUsedBytes ?? 0)} / ${formatBytes(snapshot.system.memory.swapTotalBytes)}`
                          : '-'}
                      </span>
                    </div>
                  </div>

                  {/* Network KPI */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: COLORS.secondary }}>{t('netTitle')}</span>
                      <span style={{ fontSize: '11px', color: COLORS.tertiary }}>
                        {snapshot.system.network.interfaces.filter(i => !i.internal).length} NICs
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('netDown')}</div>
                        <div style={{ ...monoStyle, fontSize: '16px', fontWeight: 700, color: COLORS.brand }}>
                          {formatRate(snapshot.system.network.rxBytesPerSec)}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('netUp')}</div>
                        <div style={{ ...monoStyle, fontSize: '16px', fontWeight: 700, color: COLORS.success }}>
                          {formatRate(snapshot.system.network.txBytesPerSec)}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: COLORS.tertiary, marginTop: 'auto' }}>
                      <span>{t('netTotalRx')}: <span style={monoStyle}>{formatBytes(snapshot.system.network.totalRxBytes)}</span></span>
                      <span>{t('netTotalTx')}: <span style={monoStyle}>{formatBytes(snapshot.system.network.totalTxBytes)}</span></span>
                    </div>
                  </div>

                  {/* Wi-Fi Guard KPI */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: COLORS.secondary }}>{t('wifiTitle')}</span>
                      <StatusBadge label={wifiPhase.label} tone={wifiPhase.tone} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '16px', fontWeight: 700, color: wifiStatus?.connected ? COLORS.success : COLORS.error }}>
                        {wifiStatus?.connected ? t('wifiConnected') : t('wifiDisconnected')}
                      </span>
                      <span style={{ ...monoStyle, fontSize: '12px', color: COLORS.secondary }}>
                        {wifiStatus?.interfaceName ?? '-'} · {wifiStatus?.ipv4 ?? '-'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: COLORS.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {wifiStatus?.ssid
                        ? wifiStatus.ssid
                        : wifiStatus?.ssidRedacted
                          ? t('wifiSsidRedacted')
                          : t('wifiDisconnected')}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: COLORS.tertiary, marginTop: 'auto' }}>
                      <span>{t('wifiRecoveries')}: <strong style={{ ...monoStyle, color: COLORS.text }}>{wifiStatus?.recoveryCount ?? 0}</strong></span>
                      <span>{wifiStatus?.rssiDbm !== null && wifiStatus?.rssiDbm !== undefined ? `${wifiStatus.rssiDbm} dBm` : ''}</span>
                    </div>
                  </div>
                </div>

                {/* Live Telemetry Charts */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                    gap: '12px',
                  }}
                >
                  <div style={cardStyle}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.text }}>
                      {t('chartCpuMemTitle')}
                    </div>
                    <DualSparkline
                      series={[
                        { label: t('chartCpu'), color: COLORS.brand, values: chartData.cpu },
                        { label: t('chartMem'), color: COLORS.warn, values: chartData.mem },
                      ]}
                      maxY={100}
                      formatValue={v => `${v.toFixed(1)}%`}
                      emptyLabel={t('chartWaiting')}
                    />
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.text }}>
                      {t('chartNetTitle')}
                    </div>
                    <DualSparkline
                      series={[
                        { label: t('chartRx'), color: COLORS.brand, values: chartData.rx },
                        { label: t('chartTx'), color: COLORS.success, values: chartData.tx },
                      ]}
                      formatValue={v => formatRate(v)}
                      emptyLabel={t('chartWaiting')}
                    />
                  </div>
                </div>

                {/* Overview Bottom Row: Wi-Fi Guard Quick Panel & DSH Runtime Quick Panel */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {/* Wi-Fi Quick Card */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('wifiTitle')}</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => setTab('wifi')}
                        >
                          {t('tabWifi')}
                        </button>
                        <button
                          type="button"
                          style={primaryButtonStyle}
                          disabled={wifiBusy || !wifiStatus?.supported}
                          onClick={() => void handleTriggerRecovery()}
                        >
                          {wifiBusy ? t('wifiCycling') : t('wifiCycleNow')}
                        </button>
                      </div>
                    </div>

                    {wifiSettings && (
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          fontSize: '12px',
                          color: COLORS.text,
                          cursor: 'pointer',
                          padding: '8px 10px',
                          borderRadius: COLORS.radiusMd,
                          background: COLORS.bgLayer1,
                          border: `0.5px solid ${COLORS.borderSubtle}`,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={wifiSettings.autoRecover}
                          disabled={wifiBusy}
                          onChange={(e) => void handleSaveSettings({ autoRecover: e.target.checked })}
                        />
                        <span>{t('wifiEnableAutoRecover')}</span>
                      </label>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 500, color: COLORS.secondary }}>
                        {t('wifiEventsTitle')}
                      </div>
                      {snapshot.wifi.events.length === 0 ? (
                        <div style={{ fontSize: '12px', color: COLORS.tertiary, padding: '8px 0' }}>
                          {t('wifiNoEvents')}
                        </div>
                      ) : (
                        snapshot.wifi.events.slice(0, 4).map((ev) => (
                          <div
                            key={ev.id}
                            style={{
                              ...subCardStyle,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '10px',
                              padding: '7px 10px',
                            }}
                          >
                            <span style={{ fontSize: '12px', color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ev.message}
                            </span>
                            <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary, flexShrink: 0 }}>
                              {formatTime(ev.timestamp, t('never'))}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* DSH Quick Card */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('dshTitle')}</span>
                      <button type="button" style={buttonStyle} onClick={() => setTab('dsh')}>
                        {t('tabDsh')}
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshDefaultModel')}</div>
                        <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600, marginTop: '3px', overflowWrap: 'anywhere' }}>
                          {snapshot.dsh.defaultModel
                            ? `${snapshot.dsh.defaultModel.provider} / ${snapshot.dsh.defaultModel.model}`
                            : t('none')}
                        </div>
                      </div>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshRss')}</div>
                        <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600, marginTop: '3px' }}>
                          {formatBytes(snapshot.dsh.process.rssBytes)} (PID {snapshot.dsh.process.pid})
                        </div>
                      </div>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshAgents')}</div>
                        <div style={{ fontSize: '12px', fontWeight: 600, marginTop: '3px' }}>
                          {t('dshAgentsSummary', {
                            running: snapshot.dsh.agents.running,
                            idle: snapshot.dsh.agents.idle,
                          })}
                        </div>
                      </div>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshPlugins')}</div>
                        <div style={{ fontSize: '12px', fontWeight: 600, marginTop: '3px' }}>
                          {t('dshPluginsSummary', {
                            active: snapshot.dsh.plugins.active,
                            total: snapshot.dsh.plugins.total,
                            failed: snapshot.dsh.plugins.failed,
                          })}
                        </div>
                      </div>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshSessions')} / {t('dshWorkspaces')}</div>
                        <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600, marginTop: '3px' }}>
                          {snapshot.dsh.sessions.total} / {snapshot.dsh.workspaces.total}
                        </div>
                      </div>
                      <div style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{t('dshMcp')} / {t('dshSkills')}</div>
                        <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600, marginTop: '3px' }}>
                          {snapshot.dsh.mcp.available ? `${snapshot.dsh.mcp.connected}/${snapshot.dsh.mcp.total}` : t('dshUnavailable')} · {snapshot.dsh.skills.available ? snapshot.dsh.skills.total : '-'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Wi-Fi Guard Tab */}
            {tab === 'wifi' && wifiStatus && wifiSettings && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {wifiNotice && (
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: COLORS.radiusMd,
                      border: `0.5px solid ${COLORS.success}`,
                      background: COLORS.bgLayer2,
                      color: COLORS.success,
                      fontSize: '12px',
                    }}
                  >
                    {wifiNotice}
                  </div>
                )}

                {/* Status & Controls Card */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '15px', fontWeight: 600 }}>{t('wifiTitle')}</span>
                      <StatusBadge
                        label={wifiStatus.connected ? t('wifiConnected') : t('wifiDisconnected')}
                        tone={wifiStatus.connected ? 'success' : 'error'}
                      />
                      <StatusBadge label={wifiPhase.label} tone={wifiPhase.tone} />
                      <StatusBadge
                        label={wifiStatus.supported ? `${t('wifiSupported')} (${wifiStatus.platform})` : t('wifiUnsupported')}
                        tone={wifiStatus.supported ? 'brand' : 'neutral'}
                      />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={wifiBusy || !wifiStatus.supported}
                        onClick={() => void handleRefreshWifi()}
                      >
                        {t('refresh')}
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={wifiBusy || !wifiStatus.supported}
                        onClick={() => void handleTogglePower(wifiStatus.power !== 'on')}
                      >
                        {wifiStatus.power === 'on' ? t('wifiTurnOff') : t('wifiTurnOn')}
                      </button>
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        disabled={wifiBusy || !wifiStatus.supported}
                        onClick={() => void handleTriggerRecovery()}
                      >
                        {wifiBusy ? t('wifiCycling') : t('wifiCycleNow')}
                      </button>
                    </div>
                  </div>

                  {wifiStatus.lastError && (
                    <div style={{ fontSize: '12px', color: COLORS.error }}>
                      {wifiStatus.lastError}
                    </div>
                  )}

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                      gap: '8px',
                    }}
                  >
                    {[
                      [t('wifiInterface'), wifiStatus.interfaceName ?? '-'],
                      [
                        t('wifiPower'),
                        wifiStatus.power === 'on'
                          ? t('wifiPowerOn')
                          : wifiStatus.power === 'off'
                            ? t('wifiPowerOff')
                            : t('wifiPowerUnknown'),
                      ],
                      [
                        t('wifiSsid'),
                        wifiStatus.ssid
                          ? wifiStatus.ssid
                          : wifiStatus.ssidRedacted
                            ? t('wifiSsidRedacted')
                            : '-',
                      ],
                      [t('wifiIp'), wifiStatus.ipv4 ?? '-'],
                      [t('wifiRouter'), wifiStatus.routerIp ?? '-'],
                      [t('wifiSecurity'), wifiStatus.security ?? '-'],
                      [t('wifiChannel'), [wifiStatus.channel, wifiStatus.phyMode].filter(Boolean).join(' · ') || '-'],
                      [
                        t('wifiSignal'),
                        wifiStatus.rssiDbm !== null
                          ? `${wifiStatus.rssiDbm} dBm / ${wifiStatus.noiseDbm ?? '-'} dBm`
                          : '-',
                      ],
                      [t('wifiRate'), wifiStatus.txRateMbps !== null ? `${wifiStatus.txRateMbps} Mbps` : '-'],
                      [t('wifiRecoveries'), String(wifiStatus.recoveryCount)],
                      [t('wifiLastCheck'), formatTime(wifiStatus.lastCheckedAt, t('never'))],
                      [t('wifiLastRecovery'), formatTime(wifiStatus.lastRecoveryAt, t('never'))],
                    ].map(([label, val]) => (
                      <div key={label} style={subCardStyle}>
                        <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{label}</div>
                        <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600, marginTop: '3px', overflowWrap: 'anywhere' }}>
                          {val}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Saved Networks + Policy Settings */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
                    gap: '12px',
                  }}
                >
                  {/* Saved Wi-Fi Networks */}
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('wifiSavedTitle')}</span>
                      <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary }}>
                        {wifiStatus.preferredNetworks.length}
                      </span>
                    </div>

                    {wifiStatus.preferredNetworks.length === 0 ? (
                      <div style={{ fontSize: '12px', color: COLORS.tertiary, padding: '12px 0' }}>
                        {t('wifiNoSaved')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '360px', overflowY: 'auto' }}>
                        {wifiStatus.preferredNetworks.map((ssid, index) => {
                          const isTarget = wifiSettings.targetSsid === ssid
                          return (
                            <div
                              key={`${index}-${ssid}`}
                              style={{
                                ...subCardStyle,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                                padding: '8px 10px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary, width: '20px' }}>
                                  #{index + 1}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {ssid}
                                </span>
                                {isTarget && <StatusBadge label={t('wifiTargetBadge')} tone="brand" />}
                              </div>
                              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                <button
                                  type="button"
                                  style={buttonStyle}
                                  disabled={wifiBusy}
                                  onClick={() => void handleSaveSettings({ targetSsid: isTarget ? '' : ssid })}
                                >
                                  {t('wifiSetTargetBtn')}
                                </button>
                                <button
                                  type="button"
                                  style={primaryButtonStyle}
                                  disabled={wifiBusy}
                                  onClick={() => void handleConnectSsid(ssid)}
                                >
                                  {t('wifiConnectBtn')}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Policy Form */}
                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{t('wifiSettingsTitle')}</div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {(
                        [
                          ['enabled', t('wifiEnableMonitor')],
                          ['autoRecover', t('wifiEnableAutoRecover')],
                          ['recoverIfPowerOff', t('wifiRecoverPowerOff')],
                          ['pingCheckEnabled', t('wifiPingCheck')],
                        ] as const
                      ).map(([field, label]) => (
                        <label
                          key={field}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            color: COLORS.text,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(wifiSettings[field])}
                            onChange={(e) => {
                              setDraftSettings({ ...wifiSettings, [field]: e.target.checked })
                              setSettingsDirty(true)
                            }}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: COLORS.secondary }}>{t('wifiInterfaceLabel')}</label>
                      <DshSelect
                        ariaLabel={t('wifiInterfaceLabel')}
                        value={wifiSettings.interfaceOverride}
                        options={[
                          { value: '', label: t('wifiInterfaceAuto') },
                          ...wifiStatus.availableInterfaces.map(iface => ({ value: iface, label: iface })),
                        ]}
                        onChange={(next) => {
                          setDraftSettings({ ...wifiSettings, interfaceOverride: next })
                          setSettingsDirty(true)
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: COLORS.secondary }}>{t('wifiTargetSsidLabel')}</label>
                      <DshSelect
                        ariaLabel={t('wifiTargetSsidLabel')}
                        value={wifiSettings.targetSsid}
                        options={[
                          { value: '', label: t('wifiTargetSsidAuto') },
                          ...wifiStatus.preferredNetworks.map(ssid => ({ value: ssid, label: ssid })),
                        ]}
                        onChange={(next) => {
                          setDraftSettings({ ...wifiSettings, targetSsid: next })
                          setSettingsDirty(true)
                        }}
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      {(
                        [
                          ['checkIntervalMs', t('wifiCheckIntervalLabel'), 2000, 120000],
                          ['failureThreshold', t('wifiThresholdLabel'), 1, 20],
                          ['powerCycleDelayMs', t('wifiPowerDelayLabel'), 500, 15000],
                          ['reconnectWaitMs', t('wifiReconnectWaitLabel'), 1000, 20000],
                          ['cooldownMs', t('wifiCooldownLabel'), 5000, 300000],
                        ] as const
                      ).map(([field, label, min, max]) => (
                        <div key={field} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label style={{ fontSize: '11px', color: COLORS.secondary }}>{label}</label>
                          <input
                            type="number"
                            min={min}
                            max={max}
                            style={inputStyle}
                            value={wifiSettings[field]}
                            onChange={(e) => {
                              setDraftSettings({ ...wifiSettings, [field]: Number(e.target.value) })
                              setSettingsDirty(true)
                            }}
                          />
                        </div>
                      ))}

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: COLORS.secondary }}>{t('wifiPingHostLabel')}</label>
                        <input
                          type="text"
                          style={inputStyle}
                          placeholder={wifiStatus.routerIp ?? '223.5.5.5'}
                          value={wifiSettings.pingHost}
                          onChange={(e) => {
                            setDraftSettings({ ...wifiSettings, pingHost: e.target.value })
                            setSettingsDirty(true)
                          }}
                        />
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        disabled={wifiBusy}
                        onClick={() => void handleSaveSettings()}
                      >
                        {wifiBusy ? t('wifiSaving') : t('wifiSaveSettings')}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Event Log */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('wifiEventsTitle')}</span>
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={wifiBusy || snapshot.wifi.events.length === 0}
                      onClick={() => void handleClearEvents()}
                    >
                      {t('wifiClearEvents')}
                    </button>
                  </div>
                  {snapshot.wifi.events.length === 0 ? (
                    <div style={{ fontSize: '12px', color: COLORS.tertiary, padding: '8px 0' }}>
                      {t('wifiNoEvents')}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '280px', overflowY: 'auto' }}>
                      {snapshot.wifi.events.map((ev) => (
                        <div
                          key={ev.id}
                          style={{
                            ...subCardStyle,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            padding: '8px 10px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                            <StatusBadge
                              label={ev.kind}
                              tone={
                                ev.kind === 'reconnected' ? 'success'
                                  : ev.kind === 'recovery_failed' || ev.kind === 'disconnected' ? 'error'
                                    : ev.kind === 'recovery_started' ? 'brand'
                                      : 'neutral'
                              }
                            />
                            <span style={{ fontSize: '12px', color: COLORS.text }}>{ev.message}</span>
                          </div>
                          <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary, flexShrink: 0 }}>
                            {formatTime(ev.timestamp, t('never'))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* DSH Runtime Tab */}
            {tab === 'dsh' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* Process & Services KPIs */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                    gap: '10px',
                  }}
                >
                  {[
                    [t('dshPid'), String(snapshot.dsh.process.pid)],
                    [t('dshNode'), snapshot.dsh.process.nodeVersion],
                    [t('dshRss'), formatBytes(snapshot.dsh.process.rssBytes)],
                    [t('dshHeap'), `${formatBytes(snapshot.dsh.process.heapUsedBytes)} / ${formatBytes(snapshot.dsh.process.heapTotalBytes)}`],
                    [t('uptime'), formatDuration(snapshot.dsh.process.uptimeSec)],
                    [
                      t('dshDefaultModel'),
                      snapshot.dsh.defaultModel
                        ? `${snapshot.dsh.defaultModel.provider} / ${snapshot.dsh.defaultModel.model}`
                        : t('none'),
                    ],
                    [
                      t('dshPlugins'),
                      t('dshPluginsSummary', {
                        active: snapshot.dsh.plugins.active,
                        total: snapshot.dsh.plugins.total,
                        failed: snapshot.dsh.plugins.failed,
                      }),
                    ],
                    [
                      t('dshSchedules'),
                      snapshot.dsh.schedules.available
                        ? t('dshSchedulesSummary', {
                            active: snapshot.dsh.schedules.active,
                            total: snapshot.dsh.schedules.total,
                          })
                        : t('dshUnavailable'),
                    ],
                    [
                      t('dshSkills'),
                      snapshot.dsh.skills.available ? String(snapshot.dsh.skills.total) : t('dshUnavailable'),
                    ],
                    [t('dshHome'), snapshot.dsh.process.dshHome],
                  ].map(([label, val]) => (
                    <div key={label} style={cardStyle}>
                      <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{label}</div>
                      <div style={{ ...monoStyle, fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' }}>
                        {val}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Providers & MCP */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '12px' }}>
                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{t('dshProviders')} ({snapshot.dsh.providers.length})</div>
                    {snapshot.dsh.providers.length === 0 ? (
                      <div style={{ fontSize: '12px', color: COLORS.tertiary }}>{t('none')}</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {snapshot.dsh.providers.map((p) => (
                          <div key={p.id} style={{ ...subCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '12px', fontWeight: 500 }}>{p.name}</span>
                            <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary }}>
                              {p.id}{p.modelCount !== undefined ? ` · ${p.modelCount} models` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>
                      {t('dshMcp')} ({snapshot.dsh.mcp.connected}/{snapshot.dsh.mcp.total})
                    </div>
                    {!snapshot.dsh.mcp.available || snapshot.dsh.mcp.servers.length === 0 ? (
                      <div style={{ fontSize: '12px', color: COLORS.tertiary }}>
                        {snapshot.dsh.mcp.available ? t('dshNoMcp') : t('dshUnavailable')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {snapshot.dsh.mcp.servers.map((srv) => (
                          <div key={srv.name} style={{ ...subCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '12px', fontWeight: 500 }}>{srv.name}</div>
                              {srv.error && <div style={{ fontSize: '11px', color: COLORS.error }}>{srv.error}</div>}
                            </div>
                            <StatusBadge
                              label={srv.state}
                              tone={
                                srv.state === 'ready' || srv.state === 'connected' ? 'success'
                                  : srv.state === 'failed' || srv.state === 'error' ? 'error'
                                    : 'neutral'
                              }
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Live Agents & Sessions */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '12px' }}>
                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>
                      {t('dshAgents')} ({snapshot.dsh.agents.total})
                    </div>
                    {snapshot.dsh.agents.items.length === 0 ? (
                      <div style={{ fontSize: '12px', color: COLORS.tertiary }}>{t('dshNoAgents')}</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {snapshot.dsh.agents.items.map((agent) => (
                          <div key={agent.id} style={{ ...subCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ ...monoStyle, fontSize: '12px', fontWeight: 600 }}>{agent.id}</div>
                              {agent.cwd && (
                                <div style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {agent.cwd}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                              <StatusBadge
                                label={agent.status === 'running' ? t('dshStatusRunning') : t('dshStatusIdle')}
                                tone={agent.status === 'running' ? 'brand' : 'neutral'}
                              />
                              {onOpenSession && (
                                <button type="button" style={buttonStyle} onClick={() => onOpenSession(agent.id)}>
                                  {t('dshOpenSession')}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>
                      {t('dshSessions')} ({snapshot.dsh.sessions.total})
                    </div>
                    {snapshot.dsh.sessions.items.length === 0 ? (
                      <div style={{ fontSize: '12px', color: COLORS.tertiary }}>{t('dshNoSessions')}</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                        {snapshot.dsh.sessions.items.map((sess) => (
                          <div key={sess.id} style={{ ...subCardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {sess.title}
                              </div>
                              <div style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary }}>
                                {sess.id} · {sess.eventCount} events
                              </div>
                            </div>
                            {onOpenSession && (
                              <button type="button" style={buttonStyle} onClick={() => onOpenSession(sess.id)}>
                                {t('dshOpenSession')}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Workspaces */}
                <div style={cardStyle}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>
                    {t('dshWorkspaces')} ({snapshot.dsh.workspaces.total})
                  </div>
                  {snapshot.dsh.workspaces.items.length === 0 ? (
                    <div style={{ fontSize: '12px', color: COLORS.tertiary }}>{t('dshNoWorkspaces')}</div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
                      {snapshot.dsh.workspaces.items.map((ws) => (
                        <div key={ws.id} style={subCardStyle}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600 }}>{ws.title}</span>
                            <span style={{ ...monoStyle, fontSize: '11px', color: COLORS.secondary }}>
                              {ws.sessionCount} sessions
                            </span>
                          </div>
                          <div style={{ ...monoStyle, fontSize: '11px', color: COLORS.tertiary, marginTop: '4px', overflowWrap: 'anywhere' }}>
                            {ws.path}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* CPU & Network Details Tab */}
            {tab === 'system' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* Per-Core CPU + Memory Breakdown */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '12px' }}>
                  <div style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('dshCoreUsage')}</span>
                      <span style={{ fontSize: '11px', color: COLORS.tertiary }}>{snapshot.system.cpu.model}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
                      {snapshot.system.cpu.perCore.map((core) => (
                        <div key={core.core} style={subCardStyle}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '4px' }}>
                            <span style={{ color: COLORS.secondary }}>Core {core.core}</span>
                            <span style={{ ...monoStyle, fontWeight: 600 }}>{core.usagePct.toFixed(1)}%</span>
                          </div>
                          <ProgressBar pct={core.usagePct} color={usageColor(core.usagePct)} />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={cardStyle}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{t('memTitle')}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      {[
                        [t('memActive'), snapshot.system.memory.activeBytes],
                        [t('memWired'), snapshot.system.memory.wiredBytes],
                        [t('memCompressed'), snapshot.system.memory.compressedBytes],
                        [t('memCached'), snapshot.system.memory.cachedBytes ?? snapshot.system.memory.freeBytes],
                        [t('memSwap'), snapshot.system.memory.swapUsedBytes],
                      ].map(([label, bytes]) => (
                        <div key={String(label)} style={subCardStyle}>
                          <div style={{ fontSize: '11px', color: COLORS.tertiary }}>{label}</div>
                          <div style={{ ...monoStyle, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
                            {typeof bytes === 'number' ? formatBytes(bytes) : '-'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Network Interfaces Table */}
                <div style={cardStyle}>
                  <div style={{ fontSize: '14px', fontWeight: 600 }}>{t('dshInterfacesTitle')}</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: COLORS.tertiary, borderBottom: `0.5px solid ${COLORS.border}` }}>
                          <th style={{ padding: '8px 6px', fontWeight: 500 }}>{t('dshIfaceName')}</th>
                          <th style={{ padding: '8px 6px', fontWeight: 500 }}>{t('dshIfaceAddr')}</th>
                          <th style={{ padding: '8px 6px', fontWeight: 500 }}>{t('dshIfaceRate')}</th>
                          <th style={{ padding: '8px 6px', fontWeight: 500 }}>{t('dshIfaceTotal')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.system.network.interfaces.map((nic) => (
                          <tr key={nic.name} style={{ borderBottom: `0.5px solid ${COLORS.borderSubtle}` }}>
                            <td style={{ padding: '8px 6px', ...monoStyle, fontWeight: 600 }}>
                              {nic.name}
                              {nic.internal && (
                                <span style={{ marginLeft: '6px', fontSize: '10px', color: COLORS.tertiary }}>loopback</span>
                              )}
                            </td>
                            <td style={{ padding: '8px 6px', ...monoStyle, color: COLORS.secondary }}>
                              {nic.addresses.join(', ') || nic.mac || '-'}
                            </td>
                            <td style={{ padding: '8px 6px', ...monoStyle }}>
                              <span style={{ color: COLORS.brand }}>{formatRate(nic.rxBytesPerSec)}</span>
                              {' / '}
                              <span style={{ color: COLORS.success }}>{formatRate(nic.txBytesPerSec)}</span>
                            </td>
                            <td style={{ padding: '8px 6px', ...monoStyle, color: COLORS.secondary }}>
                              {formatBytes(nic.rxBytes)} / {formatBytes(nic.txBytes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
