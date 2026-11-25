/**
 * Wi-Fi disconnect monitor and automatic power-cycle + reconnect watchdog.
 *
 * @module @charonx/dsh-system-dashboard/wifi/monitor
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type {
  WifiEventKind,
  WifiEventRecord,
  WifiSettings,
  WifiSettingsPatch,
  WifiStateView,
  WifiStatusSnapshot,
  WifiWatchdogPhase,
} from '../shared/types.ts'
import type { WifiDriver, WifiProbeResult } from './types.ts'
import type { WifiStateStore } from './store.ts'

export interface LoggerLike {
  info(msg: string): void
  warn(msg: string): void
}

export interface WifiMonitorOptions {
  readonly driver: WifiDriver
  readonly store: WifiStateStore
  readonly defaults: WifiSettings
  readonly logger?: LoggerLike
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
}

const MAX_EVENTS = 100

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class WifiMonitor {
  private readonly driver: WifiDriver
  private readonly store: WifiStateStore
  private readonly logger?: LoggerLike
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly nowFn: () => number

  private settings: WifiSettings
  private events: WifiEventRecord[] = []
  private recoveryCount = 0
  private lastRecoveryAt: number | null = null
  private cooldownUntil: number | null = null
  private consecutiveFailures = 0
  private lastCheckedAt: number | null = null
  private lastError: string | null = null
  private phase: WifiWatchdogPhase = 'disabled'
  private cachedInterface: string | null = null
  private latestProbe: WifiProbeResult | undefined

  private timer: NodeJS.Timeout | undefined
  private checking = false
  private recoveryPromise: Promise<WifiStateView> | undefined
  private abortController = new AbortController()

  constructor(options: WifiMonitorOptions) {
    this.driver = options.driver
    this.store = options.store
    this.logger = options.logger
    this.sleepFn = options.sleep ?? defaultSleep
    this.nowFn = options.now ?? (() => Date.now())

    const persisted = this.store.read()
    this.settings = sanitizeSettings({
      ...options.defaults,
      ...(persisted.settings ?? {}),
    })
    this.events = Array.isArray(persisted.events) ? [...persisted.events] : []
    this.recoveryCount = persisted.recoveryCount ?? 0
    this.lastRecoveryAt = persisted.lastRecoveryAt ?? null

    this.phase = !this.driver.isSupported
      ? 'unsupported'
      : this.settings.enabled
        ? 'healthy'
        : 'disabled'
  }

  start(): () => void {
    this.abortController = new AbortController()
    this.scheduleTimer()
    if (this.driver.isSupported && this.settings.enabled) {
      void this.checkOnce().catch(() => undefined)
    }
    return () => this.stop()
  }

  stop(): void {
    this.abortController.abort()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  getView(): WifiStateView {
    return {
      status: this.buildStatusSnapshot(),
      settings: { ...this.settings },
      events: [...this.events].reverse(),
    }
  }

  async refresh(): Promise<WifiStateView> {
    await this.checkOnce({ includeRadioDetails: true, allowRecover: false })
    return this.getView()
  }

  async updateSettings(patch: WifiSettingsPatch): Promise<WifiStateView> {
    const prevInterval = this.settings.checkIntervalMs
    const prevEnabled = this.settings.enabled
    this.settings = sanitizeSettings({
      ...this.settings,
      ...patch,
    })
    this.cachedInterface = null
    this.appendEvent('settings_updated', 'Updated Wi-Fi monitor settings')

    if (!this.driver.isSupported) {
      this.phase = 'unsupported'
    } else if (!this.settings.enabled) {
      this.phase = 'disabled'
      this.consecutiveFailures = 0
    } else if (this.phase === 'disabled') {
      this.phase = 'healthy'
    }

    this.persist()

    if (prevInterval !== this.settings.checkIntervalMs || prevEnabled !== this.settings.enabled) {
      this.scheduleTimer()
    }
    if (this.driver.isSupported && this.settings.enabled) {
      await this.checkOnce({ includeRadioDetails: true, allowRecover: false })
    }
    return this.getView()
  }

  clearEvents(): WifiStateView {
    this.events = []
    this.persist()
    return this.getView()
  }

  async setWifiPower(on: boolean): Promise<WifiStateView> {
    if (!this.driver.isSupported) {
      throw new Error('Wi-Fi control is not supported on this platform')
    }
    const iface = await this.resolveInterface()
    if (!iface) throw new Error('No Wi-Fi hardware interface detected')
    await this.driver.setPower(iface, on)
    this.appendEvent('power_toggled', `Turned Wi-Fi ${on ? 'on' : 'off'} on ${iface}`, { success: true })
    this.consecutiveFailures = 0
    this.persist()
    await this.checkOnce({ includeRadioDetails: true, allowRecover: false })
    return this.getView()
  }

  async connectToSsid(ssid: string): Promise<WifiStateView> {
    if (!this.driver.isSupported) {
      throw new Error('Wi-Fi control is not supported on this platform')
    }
    const trimmed = ssid.replace(/[\r\n]/g, '')
    if (!trimmed) throw new Error('SSID cannot be empty')
    const iface = await this.resolveInterface()
    if (!iface) throw new Error('No Wi-Fi hardware interface detected')

    // Ensure power is on first
    const pre = await this.driver.probeStatus(iface)
    if (pre.power === 'off') {
      await this.driver.setPower(iface, true)
      await this.sleepFn(1500, this.abortController.signal)
    }

    const res = await this.driver.joinNetwork(iface, trimmed)
    this.appendEvent(
      'manual_connect',
      res.ok ? `Connected to saved Wi-Fi "${trimmed}"` : `Failed to join "${trimmed}": ${res.error ?? 'unknown error'}`,
      { ssid: trimmed, success: res.ok },
    )
    if (!res.ok) {
      this.lastError = res.error ?? `Failed to join "${trimmed}"`
    } else {
      this.lastError = null
      this.consecutiveFailures = 0
    }
    this.persist()
    await this.checkOnce({ includeRadioDetails: true, allowRecover: false })
    return this.getView()
  }

  async triggerRecovery(explicitSsid?: string): Promise<WifiStateView> {
    if (!this.driver.isSupported) {
      throw new Error('Wi-Fi recovery is not supported on this platform')
    }
    return this.runRecovery('manual', explicitSsid)
  }

  async checkOnce(options: { includeRadioDetails?: boolean; allowRecover?: boolean } = {}): Promise<void> {
    if (!this.driver.isSupported || !this.settings.enabled) return
    if (this.checking || this.recoveryPromise) return

    this.checking = true
    try {
      const iface = await this.resolveInterface()
      if (!iface) {
        this.lastCheckedAt = this.nowFn()
        this.lastError = 'No Wi-Fi hardware interface detected'
        this.latestProbe = undefined
        return
      }

      const probe = await this.driver.probeStatus(iface, {
        includeRadioDetails: options.includeRadioDetails,
        pingCheck: this.settings.pingCheckEnabled,
        pingHost: this.settings.pingHost,
      })
      this.latestProbe = probe
      if (!this.settings.interfaceOverride.trim() && probe.interfaceName) {
        this.cachedInterface = probe.interfaceName
      }
      this.lastCheckedAt = this.nowFn()

      const now = this.nowFn()
      const inCooldown = this.cooldownUntil !== null && now < this.cooldownUntil
      if (this.cooldownUntil !== null && now >= this.cooldownUntil) {
        this.cooldownUntil = null
      }

      // Determine whether link is unhealthy
      const powerBlocked = probe.power === 'off' && !this.settings.recoverIfPowerOff
      const pingFailed = this.settings.pingCheckEnabled && probe.connected && probe.pingOk === false
      const unhealthy = !powerBlocked && (!probe.connected || pingFailed)

      if (!unhealthy) {
        this.consecutiveFailures = 0
        this.lastError = null
        this.phase = inCooldown ? 'cooldown' : 'healthy'
        return
      }

      // Disconnected or ping-blackholed
      this.consecutiveFailures += 1
      if (this.consecutiveFailures === 1) {
        const reason = probe.power === 'off'
          ? 'Wi-Fi power is off'
          : pingFailed
            ? 'Wi-Fi link up but ping check failed'
            : 'Wi-Fi disconnected from network'
        this.appendEvent('disconnected', `${reason} on ${iface}`)
        this.persist()
      }

      this.phase = inCooldown ? 'cooldown' : 'degraded'

      const allowRecover = options.allowRecover ?? true
      if (
        allowRecover &&
        this.settings.autoRecover &&
        !inCooldown &&
        this.consecutiveFailures >= this.settings.failureThreshold
      ) {
        this.logger?.warn?.(
          `[SystemDashboard] Wi-Fi unhealthy (${this.consecutiveFailures}/${this.settings.failureThreshold} checks) on ${iface}; starting auto-recovery`,
        )
        void this.runRecovery('auto').catch(() => undefined)
      }
    } finally {
      this.checking = false
    }
  }

  private runRecovery(trigger: 'auto' | 'manual', explicitSsid?: string): Promise<WifiStateView> {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.executeRecovery(trigger, explicitSsid).finally(() => {
      this.recoveryPromise = undefined
    })
    return this.recoveryPromise
  }

  private async executeRecovery(trigger: 'auto' | 'manual', explicitSsid?: string): Promise<WifiStateView> {
    const startedAt = this.nowFn()
    const signal = this.abortController.signal
    this.phase = 'recovering'
    this.lastError = null

    try {
      const iface = await this.resolveInterface()
      if (!iface) {
        throw new Error('No Wi-Fi hardware interface detected')
      }

      this.appendEvent(
        'recovery_started',
        `Started ${trigger} Wi-Fi recovery cycle on ${iface}`,
      )

      // Step 1: Turn Wi-Fi OFF
      await this.driver.setPower(iface, false)
      this.appendEvent('power_off', `Turned Wi-Fi off on ${iface}`)
      this.persist()

      await this.sleepFn(this.settings.powerCycleDelayMs, signal)

      // Step 2: Turn Wi-Fi ON
      await this.driver.setPower(iface, true)
      this.appendEvent('power_on', `Turned Wi-Fi back on on ${iface}`)
      this.persist()

      // Step 3: Wait briefly for macOS to re-associate automatically (unless explicit SSID requested)
      let connectedProbe: WifiProbeResult | undefined
      if (!explicitSsid) {
        const stepMs = 1000
        const maxChecks = Math.max(1, Math.ceil(this.settings.reconnectWaitMs / stepMs))
        for (let i = 0; i < maxChecks; i += 1) {
          await this.sleepFn(Math.min(stepMs, this.settings.reconnectWaitMs), signal)
          const probe = await this.driver.probeStatus(iface)
          this.latestProbe = probe
          if (probe.connected) {
            connectedProbe = probe
            break
          }
        }
      } else {
        await this.sleepFn(Math.min(1500, this.settings.reconnectWaitMs), signal)
      }

      // Step 4: Explicitly join target/preferred saved networks if not yet connected
      if (!connectedProbe) {
        const preferred = await this.driver.listPreferredNetworks(iface)
        const candidates = buildCandidateSsids(explicitSsid ?? this.settings.targetSsid, preferred)

        for (const ssid of candidates) {
          if (signal.aborted) throw new Error('Aborted')
          this.appendEvent('connect_attempt', `Attempting to join saved Wi-Fi "${ssid}"`, { ssid })
          const joinRes = await this.driver.joinNetwork(iface, ssid)
          if (joinRes.ok) {
            await this.sleepFn(1500, signal)
            const probe = await this.driver.probeStatus(iface, { includeRadioDetails: true })
            this.latestProbe = probe
            if (probe.connected) {
              connectedProbe = probe
              break
            }
          }
        }
      }

      const elapsedMs = Math.max(0, this.nowFn() - startedAt)
      this.lastRecoveryAt = this.nowFn()
      this.recoveryCount += 1

      if (connectedProbe?.connected) {
        const finalProbe = await this.driver.probeStatus(iface, {
          includeRadioDetails: true,
          pingCheck: this.settings.pingCheckEnabled,
          pingHost: this.settings.pingHost,
        })
        this.latestProbe = finalProbe
        this.consecutiveFailures = 0
        this.lastError = null
        this.cooldownUntil = this.nowFn() + this.settings.cooldownMs
        this.phase = 'cooldown'
        const joinedLabel = finalProbe.ssid ?? (explicitSsid || this.settings.targetSsid || 'saved network')
        this.appendEvent(
          'reconnected',
          `Wi-Fi reconnected (${joinedLabel}, IP ${finalProbe.ipv4 ?? 'assigned'}) in ${elapsedMs}ms`,
          { ssid: finalProbe.ssid ?? undefined, durationMs: elapsedMs, success: true },
        )
        this.logger?.info?.(`[SystemDashboard] Wi-Fi recovery succeeded in ${elapsedMs}ms`)
      } else {
        this.cooldownUntil = this.nowFn() + this.settings.cooldownMs
        this.phase = 'cooldown'
        this.lastError = 'Wi-Fi did not reconnect to any saved network after power cycle'
        this.appendEvent('recovery_failed', this.lastError, { durationMs: elapsedMs, success: false })
        this.logger?.warn?.(`[SystemDashboard] ${this.lastError}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'Aborted') {
        this.lastRecoveryAt = this.nowFn()
        this.cooldownUntil = this.nowFn() + this.settings.cooldownMs
        this.phase = 'cooldown'
        this.lastError = msg
        this.appendEvent('recovery_failed', `Wi-Fi recovery error: ${msg}`, {
          durationMs: Math.max(0, this.nowFn() - startedAt),
          success: false,
        })
      }
    }

    this.persist()
    return this.getView()
  }

  private async resolveInterface(): Promise<string | null> {
    const override = this.settings.interfaceOverride.trim()
    if (override) return override
    if (this.cachedInterface) return this.cachedInterface
    this.cachedInterface = await this.driver.detectInterface()
    return this.cachedInterface
  }

  private scheduleTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (!this.driver.isSupported || !this.settings.enabled) return
    this.timer = setInterval(() => {
      void this.checkOnce().catch(() => undefined)
    }, this.settings.checkIntervalMs)
    this.timer.unref?.()
  }

  private appendEvent(
    kind: WifiEventKind,
    message: string,
    extra: { ssid?: string; durationMs?: number; success?: boolean } = {},
  ): void {
    this.events.push({
      id: randomUUID(),
      timestamp: this.nowFn(),
      kind,
      message,
      ...(extra.ssid !== undefined ? { ssid: extra.ssid } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.success !== undefined ? { success: extra.success } : {}),
    })
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS)
    }
  }

  private persist(): void {
    this.store.write({
      settings: this.settings,
      events: this.events,
      recoveryCount: this.recoveryCount,
      lastRecoveryAt: this.lastRecoveryAt,
    })
  }

  private buildStatusSnapshot(): WifiStatusSnapshot {
    const probe = this.latestProbe
    const ifaceName = probe?.interfaceName ?? (this.settings.interfaceOverride.trim() || this.cachedInterface)
    const availableInterfaces = probe?.availableInterfaces && probe.availableInterfaces.length > 0
      ? probe.availableInterfaces
      : ifaceName
        ? [ifaceName]
        : []
    return {
      supported: this.driver.isSupported,
      platform: os.platform(),
      interfaceName: ifaceName,
      availableInterfaces,
      power: probe?.power ?? 'unknown',
      connected: probe?.connected ?? false,
      linkActive: probe?.linkActive ?? false,
      ssid: probe?.ssid ?? null,
      ssidRedacted: probe?.ssidRedacted ?? false,
      bssid: probe?.bssid ?? null,
      ipv4: probe?.ipv4 ?? null,
      routerIp: probe?.routerIp ?? null,
      security: probe?.security ?? null,
      phyMode: probe?.phyMode ?? null,
      channel: probe?.channel ?? null,
      rssiDbm: probe?.rssiDbm ?? null,
      noiseDbm: probe?.noiseDbm ?? null,
      txRateMbps: probe?.txRateMbps ?? null,
      pingOk: probe?.pingOk ?? null,
      pingLatencyMs: probe?.pingLatencyMs ?? null,
      preferredNetworks: probe?.preferredNetworks ?? [],
      phase: this.phase,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt,
      lastRecoveryAt: this.lastRecoveryAt,
      cooldownUntil: this.cooldownUntil,
      recoveryCount: this.recoveryCount,
      lastError: this.lastError,
    }
  }
}

export function buildCandidateSsids(target: string, preferred: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const trimmedTarget = target.trim()
  if (trimmedTarget) {
    result.push(trimmedTarget)
    seen.add(trimmedTarget)
  }
  for (const raw of preferred) {
    if (!raw || seen.has(raw)) continue
    result.push(raw)
    seen.add(raw)
    if (result.length >= 6) break
  }
  return result
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function sanitizeSettings(raw: WifiSettings): WifiSettings {
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    autoRecover: typeof raw.autoRecover === 'boolean' ? raw.autoRecover : true,
    recoverIfPowerOff: typeof raw.recoverIfPowerOff === 'boolean' ? raw.recoverIfPowerOff : false,
    interfaceOverride: typeof raw.interfaceOverride === 'string' ? raw.interfaceOverride.trim() : '',
    targetSsid: typeof raw.targetSsid === 'string' ? raw.targetSsid : '',
    checkIntervalMs: clampInt(raw.checkIntervalMs, 5000, 2000, 120000),
    failureThreshold: clampInt(raw.failureThreshold, 2, 1, 20),
    powerCycleDelayMs: clampInt(raw.powerCycleDelayMs, 2000, 500, 15000),
    reconnectWaitMs: clampInt(raw.reconnectWaitMs, 5000, 1000, 20000),
    cooldownMs: clampInt(raw.cooldownMs, 30000, 5000, 300000),
    pingCheckEnabled: typeof raw.pingCheckEnabled === 'boolean' ? raw.pingCheckEnabled : false,
    pingHost: typeof raw.pingHost === 'string' ? raw.pingHost.trim() : '',
  }
}
