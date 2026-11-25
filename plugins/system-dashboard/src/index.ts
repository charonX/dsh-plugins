/**
 * System Dashboard Cordis plugin entry.
 * Collects live OS telemetry (CPU, Memory, Network), DSH runtime status,
 * and monitors macOS Wi-Fi connectivity with automatic off/on/reconnect recovery.
 *
 * @module @charonx/dsh-system-dashboard
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SystemCollector } from './collectors/system.js'
import { Config, type Config as ConfigShape } from './config.js'
import { createRequestHandler } from './http/routes.js'
import { DEFAULT_ROUTE_PREFIX } from './shared/types.js'
import { DarwinWifiDriver } from './wifi/darwin.js'
import { createWifiDriver } from './wifi/factory.js'
import { LinuxWifiDriver } from './wifi/linux.js'
import { WifiMonitor } from './wifi/monitor.js'
import { WifiStateStore } from './wifi/store.js'
import { WindowsWifiDriver } from './wifi/windows.js'

export { Config } from './config.js'
export { SystemCollector } from './collectors/system.js'
export { collectDshSnapshot } from './collectors/dsh.js'
export { DarwinWifiDriver } from './wifi/darwin.js'
export { LinuxWifiDriver } from './wifi/linux.js'
export { WindowsWifiDriver } from './wifi/windows.js'
export { createWifiDriver } from './wifi/factory.js'
export { WifiMonitor } from './wifi/monitor.js'
export { WifiStateStore } from './wifi/store.js'
export * from './shared/types.js'

export const name = 'system-dashboard'
export const inject: readonly string[] = []

export interface SystemDashboardService {
  readonly systemCollector: SystemCollector
  readonly wifiMonitor: WifiMonitor
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemDashboard: SystemDashboardService
  }
}

function normalizePrefix(raw: string | undefined): string {
  const trimmed = (raw ?? DEFAULT_ROUTE_PREFIX).trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_ROUTE_PREFIX
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function apply(ctx: Context, config: ConfigShape = {}): void {
  if (config.enabled === false) {
    ctx.logger.info('[SystemDashboard] Plugin is disabled in configuration')
    return
  }

  const dshHome = resolveDshHome()
  const statePath = config.statePath && config.statePath.trim()
    ? expandHomePath(config.statePath.trim())
    : join(dshHome, 'system-dashboard', 'wifi-state.json')
  const routePrefix = normalizePrefix(config.routePrefix)

  const systemCollector = new SystemCollector({
    sampleIntervalMs: config.systemSampleIntervalMs ?? 2000,
    historySize: config.historySize ?? 60,
  })

  const wifiDriver = createWifiDriver()
  const wifiStore = new WifiStateStore(statePath)
  const wifiMonitor = new WifiMonitor({
    driver: wifiDriver,
    store: wifiStore,
    logger: ctx.logger,
    defaults: {
      enabled: config.wifiMonitorEnabled ?? true,
      autoRecover: config.wifiAutoRecover ?? true,
      recoverIfPowerOff: config.wifiRecoverIfPowerOff ?? false,
      interfaceOverride: config.wifiInterface ?? '',
      targetSsid: config.wifiTargetSsid ?? '',
      checkIntervalMs: config.wifiCheckIntervalMs ?? 5000,
      failureThreshold: config.wifiFailureThreshold ?? 2,
      powerCycleDelayMs: config.wifiPowerCycleDelayMs ?? 2000,
      reconnectWaitMs: config.wifiReconnectWaitMs ?? 5000,
      cooldownMs: config.wifiCooldownMs ?? 30000,
      pingCheckEnabled: config.wifiPingCheckEnabled ?? false,
      pingHost: config.wifiPingHost ?? '',
    },
  })

  ctx.provide('systemDashboard')
  ctx.systemDashboard = { systemCollector, wifiMonitor }

  ctx.effect(() => systemCollector.start(), 'system-dashboard: system collector')
  ctx.effect(() => wifiMonitor.start(), 'system-dashboard: wifi monitor')

  const handler = createRequestHandler({
    prefix: routePrefix,
    ctx,
    systemCollector,
    wifiMonitor,
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: routePrefix, handler }),
      'system-dashboard: http routes',
    )
    ctx.logger.info(`[SystemDashboard] Mounted API routes under ${routePrefix}`)
  })

  ctx.logger.info('[SystemDashboard] Dashboard telemetry and Wi-Fi watchdog ready')
}
