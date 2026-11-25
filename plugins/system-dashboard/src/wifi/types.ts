/**
 * Platform-independent Wi-Fi driver contract.
 *
 * @module @charonx/dsh-system-dashboard/wifi/types
 */

import type { WifiPowerState } from '../shared/types.ts'

export interface WifiProbeResult {
  readonly supported: boolean
  readonly interfaceName: string | null
  readonly availableInterfaces?: readonly string[]
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
}

export interface WifiDriver {
  readonly isSupported: boolean
  detectInterface(): Promise<string | null>
  probeStatus(iface: string, options?: {
    includeRadioDetails?: boolean
    pingCheck?: boolean
    pingHost?: string
  }): Promise<WifiProbeResult>
  listPreferredNetworks(iface: string): Promise<string[]>
  setPower(iface: string, on: boolean): Promise<void>
  joinNetwork(iface: string, ssid: string): Promise<{ ok: boolean; error?: string }>
}
