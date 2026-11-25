/**
 * Configuration schema for the System Dashboard plugin.
 *
 * @module @charonx/dsh-system-dashboard/config
 */

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  routePrefix?: string
  systemSampleIntervalMs?: number
  historySize?: number
  wifiMonitorEnabled?: boolean
  wifiAutoRecover?: boolean
  wifiRecoverIfPowerOff?: boolean
  wifiInterface?: string
  wifiTargetSsid?: string
  wifiCheckIntervalMs?: number
  wifiFailureThreshold?: number
  wifiPowerCycleDelayMs?: number
  wifiReconnectWaitMs?: number
  wifiCooldownMs?: number
  wifiPingCheckEnabled?: boolean
  wifiPingHost?: string
  statePath?: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable the System Dashboard plugin'),
  routePrefix: Schema.string().default('/api/system-dashboard').description('HTTP route prefix for dashboard endpoints'),
  systemSampleIntervalMs: Schema.number().min(500).max(60000).default(2000).description('Interval in ms for sampling CPU, memory, and network stats'),
  historySize: Schema.number().min(10).max(300).default(60).description('Number of historical telemetry points kept in memory'),
  wifiMonitorEnabled: Schema.boolean().default(true).description('Enable Wi-Fi connection status monitoring'),
  wifiAutoRecover: Schema.boolean().default(true).description('Automatically power-cycle Wi-Fi and reconnect to a saved network when disconnected'),
  wifiRecoverIfPowerOff: Schema.boolean().default(false).description('Also power on Wi-Fi automatically if Wi-Fi power is currently Off'),
  wifiInterface: Schema.string().default('').description('Optional explicit Wi-Fi interface name (e.g. en1); auto-detected when empty'),
  wifiTargetSsid: Schema.string().default('').description('Preferred saved Wi-Fi SSID to connect first; empty tries macOS preferred list order'),
  wifiCheckIntervalMs: Schema.number().min(2000).max(120000).default(5000).description('Interval in ms for checking Wi-Fi status'),
  wifiFailureThreshold: Schema.number().min(1).max(20).default(2).description('Consecutive disconnected checks required before triggering Wi-Fi recovery'),
  wifiPowerCycleDelayMs: Schema.number().min(500).max(15000).default(2000).description('Delay in ms between turning Wi-Fi off and turning it back on'),
  wifiReconnectWaitMs: Schema.number().min(1000).max(20000).default(5000).description('Wait time in ms after turning Wi-Fi on before attempting explicit SSID join'),
  wifiCooldownMs: Schema.number().min(5000).max(300000).default(30000).description('Cooldown in ms after a recovery cycle before starting another'),
  wifiPingCheckEnabled: Schema.boolean().default(false).description('Enable optional ICMP ping check to detect silent Wi-Fi blackholes'),
  wifiPingHost: Schema.string().default('').description('Host/IP to ping when ping check is enabled (defaults to active router IP or 223.5.5.5)'),
  statePath: Schema.string().default('').description('Optional override path for persisting Wi-Fi watchdog settings and event log'),
})
