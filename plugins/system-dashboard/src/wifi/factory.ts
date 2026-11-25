/**
 * Platform factory for selecting the active OS Wi-Fi driver.
 *
 * @module @charonx/dsh-system-dashboard/wifi/factory
 */

import os from 'node:os'
import { DarwinWifiDriver } from './darwin.js'
import { LinuxWifiDriver } from './linux.js'
import type { WifiDriver, WifiProbeResult } from './types.ts'
import { WindowsWifiDriver } from './windows.js'

class UnsupportedWifiDriver implements WifiDriver {
  readonly isSupported = false

  async detectInterface(): Promise<string | null> {
    return null
  }

  async listPreferredNetworks(): Promise<string[]> {
    return []
  }

  async setPower(): Promise<void> {
    throw new Error(`Wi-Fi control is not supported on platform "${os.platform()}"`)
  }

  async joinNetwork(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: `Unsupported platform "${os.platform()}"` }
  }

  async probeStatus(): Promise<WifiProbeResult> {
    return {
      supported: false,
      interfaceName: null,
      power: 'unknown',
      connected: false,
      linkActive: false,
      ssid: null,
      ssidRedacted: false,
      bssid: null,
      ipv4: null,
      routerIp: null,
      security: null,
      phyMode: null,
      channel: null,
      rssiDbm: null,
      noiseDbm: null,
      txRateMbps: null,
      pingOk: null,
      pingLatencyMs: null,
      preferredNetworks: [],
    }
  }
}

export function createWifiDriver(platform: NodeJS.Platform = os.platform()): WifiDriver {
  switch (platform) {
    case 'darwin':
      return new DarwinWifiDriver()
    case 'linux':
      return new LinuxWifiDriver()
    case 'win32':
      return new WindowsWifiDriver()
    default:
      return new UnsupportedWifiDriver()
  }
}
