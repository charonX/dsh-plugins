/**
 * Shared DTOs between the System Dashboard host service and web client.
 *
 * @module @charonx/dsh-system-dashboard/shared/types
 */

export const DEFAULT_ROUTE_PREFIX = '/api/system-dashboard'
export const LOCALE_NAMESPACE = 'system-dashboard'

export interface CpuCoreView {
  readonly core: number
  readonly usagePct: number
}

export interface CpuSnapshot {
  readonly model: string
  readonly cores: number
  readonly arch: string
  readonly usagePct: number
  readonly userPct: number
  readonly sysPct: number
  readonly idlePct: number
  readonly loadAvg: readonly [number, number, number]
  readonly perCore: readonly CpuCoreView[]
}

export interface MemorySnapshot {
  readonly totalBytes: number
  readonly usedBytes: number
  readonly freeBytes: number
  readonly usedPct: number
  readonly activeBytes?: number
  readonly wiredBytes?: number
  readonly compressedBytes?: number
  readonly cachedBytes?: number
  readonly swapTotalBytes?: number
  readonly swapUsedBytes?: number
  readonly source: 'darwin-vm-stat' | 'linux-proc-meminfo' | 'node-os'
}

export interface NetworkInterfaceStats {
  readonly name: string
  readonly addresses: readonly string[]
  readonly mac?: string
  readonly internal: boolean
  readonly rxBytes: number
  readonly txBytes: number
  readonly rxBytesPerSec: number
  readonly txBytesPerSec: number
  readonly rxErrors: number
  readonly txErrors: number
}

export interface NetworkSnapshot {
  readonly rxBytesPerSec: number
  readonly txBytesPerSec: number
  readonly totalRxBytes: number
  readonly totalTxBytes: number
  readonly interfaces: readonly NetworkInterfaceStats[]
}

export interface SystemMetricPoint {
  readonly timestamp: number
  readonly cpuPct: number
  readonly memPct: number
  readonly rxBytesPerSec: number
  readonly txBytesPerSec: number
}

export interface SystemSnapshot {
  readonly hostname: string
  readonly platform: string
  readonly release: string
  readonly osVersion?: string
  readonly uptimeSec: number
  readonly sampledAt: number
  readonly cpu: CpuSnapshot
  readonly memory: MemorySnapshot
  readonly network: NetworkSnapshot
  readonly history: readonly SystemMetricPoint[]
}

export interface DshProcessView {
  readonly pid: number
  readonly nodeVersion: string
  readonly uptimeSec: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly externalBytes: number
  readonly dshHome: string
}

export interface DshDefaultModelView {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface DshProviderView {
  readonly id: string
  readonly name: string
  readonly modelCount?: number
}

export interface DshAgentView {
  readonly id: string
  readonly status: string
  readonly cwd?: string
  readonly eventCount: number
  readonly createdAt?: number
}

export interface DshSessionView {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly eventCount: number
  readonly createdAt?: number
  readonly isAgentLive: boolean
}

export interface DshWorkspaceView {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionCount: number
}

export interface DshMcpServerView {
  readonly name: string
  readonly configured: boolean
  readonly state: string
  readonly error?: string
}

export interface DshPluginSummaryView {
  readonly total: number
  readonly active: number
  readonly failed: number
  readonly failedNames: readonly string[]
}

export interface DshSnapshot {
  readonly collectedAt: number
  readonly process: DshProcessView
  readonly defaultModel?: DshDefaultModelView
  readonly providers: readonly DshProviderView[]
  readonly agents: {
    readonly total: number
    readonly running: number
    readonly idle: number
    readonly items: readonly DshAgentView[]
  }
  readonly sessions: {
    readonly total: number
    readonly items: readonly DshSessionView[]
  }
  readonly workspaces: {
    readonly total: number
    readonly items: readonly DshWorkspaceView[]
  }
  readonly mcp: {
    readonly available: boolean
    readonly total: number
    readonly connected: number
    readonly failed: number
    readonly servers: readonly DshMcpServerView[]
  }
  readonly skills: {
    readonly available: boolean
    readonly total: number
  }
  readonly schedules: {
    readonly available: boolean
    readonly total: number
    readonly active: number
  }
  readonly plugins: DshPluginSummaryView
}

export type WifiWatchdogPhase =
  | 'disabled'
  | 'healthy'
  | 'degraded'
  | 'recovering'
  | 'cooldown'
  | 'unsupported'

export type WifiPowerState = 'on' | 'off' | 'unknown'

export interface WifiStatusSnapshot {
  readonly supported: boolean
  readonly platform: string
  readonly interfaceName: string | null
  readonly availableInterfaces: readonly string[]
  readonly power: WifiPowerState
  readonly connected: boolean
  readonly linkActive: boolean
  readonly ssid: string | null
  readonly ssidRedacted: boolean
  readonly bssid: string | null
  readonly ipv4: string | null
  readonly routerIp: string | null
  readonly security: string | null
  readonly phyMode: string | null
  readonly channel: string | null
  readonly rssiDbm: number | null
  readonly noiseDbm: number | null
  readonly txRateMbps: number | null
  readonly pingOk: boolean | null
  readonly pingLatencyMs: number | null
  readonly preferredNetworks: readonly string[]
  readonly phase: WifiWatchdogPhase
  readonly consecutiveFailures: number
  readonly lastCheckedAt: number | null
  readonly lastRecoveryAt: number | null
  readonly cooldownUntil: number | null
  readonly recoveryCount: number
  readonly lastError: string | null
}

export interface WifiSettings {
  readonly enabled: boolean
  readonly autoRecover: boolean
  readonly recoverIfPowerOff: boolean
  readonly interfaceOverride: string
  readonly targetSsid: string
  readonly checkIntervalMs: number
  readonly failureThreshold: number
  readonly powerCycleDelayMs: number
  readonly reconnectWaitMs: number
  readonly cooldownMs: number
  readonly pingCheckEnabled: boolean
  readonly pingHost: string
}

export type WifiEventKind =
  | 'disconnected'
  | 'recovery_started'
  | 'power_off'
  | 'power_on'
  | 'connect_attempt'
  | 'reconnected'
  | 'recovery_failed'
  | 'manual_connect'
  | 'power_toggled'
  | 'settings_updated'

export interface WifiEventRecord {
  readonly id: string
  readonly timestamp: number
  readonly kind: WifiEventKind
  readonly message: string
  readonly ssid?: string
  readonly durationMs?: number
  readonly success?: boolean
}

export interface WifiStateView {
  readonly status: WifiStatusSnapshot
  readonly settings: WifiSettings
  readonly events: readonly WifiEventRecord[]
}

export interface DashboardSnapshot {
  readonly generatedAt: number
  readonly system: SystemSnapshot
  readonly dsh: DshSnapshot
  readonly wifi: WifiStateView
}

export interface WifiSettingsPatch {
  enabled?: boolean
  autoRecover?: boolean
  recoverIfPowerOff?: boolean
  interfaceOverride?: string
  targetSsid?: string
  checkIntervalMs?: number
  failureThreshold?: number
  powerCycleDelayMs?: number
  reconnectWaitMs?: number
  cooldownMs?: number
  pingCheckEnabled?: boolean
  pingHost?: string
}
