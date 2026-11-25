import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WifiSettings } from '../src/shared/types.ts'
import type { WifiDriver, WifiProbeResult } from '../src/wifi/darwin.ts'
import { buildCandidateSsids, WifiMonitor } from '../src/wifi/monitor.ts'
import { WifiStateStore } from '../src/wifi/store.ts'

class FakeWifiDriver implements WifiDriver {
  readonly isSupported = true
  power: 'on' | 'off' = 'on'
  connected = true
  ssid: string | null = 'OfficeWiFi'
  preferred = ['OfficeWiFi', 'BackupWiFi']
  actions: string[] = []
  autoAssociateOnPowerOn = false

  async detectInterface(): Promise<string | null> {
    return 'en1'
  }

  async listPreferredNetworks(): Promise<string[]> {
    return [...this.preferred]
  }

  async setPower(iface: string, on: boolean): Promise<void> {
    this.actions.push(`power:${iface}:${on ? 'on' : 'off'}`)
    this.power = on ? 'on' : 'off'
    if (!on) {
      this.connected = false
      this.ssid = null
    } else if (this.autoAssociateOnPowerOn) {
      this.connected = true
      this.ssid = this.preferred[0] ?? 'OfficeWiFi'
    }
  }

  async joinNetwork(iface: string, ssid: string): Promise<{ ok: boolean; error?: string }> {
    this.actions.push(`join:${iface}:${ssid}`)
    if (this.power === 'on' && this.preferred.includes(ssid)) {
      this.connected = true
      this.ssid = ssid
      return { ok: true }
    }
    return { ok: false, error: 'Could not find network' }
  }

  async probeStatus(iface: string): Promise<WifiProbeResult> {
    return {
      supported: true,
      interfaceName: iface,
      power: this.power,
      connected: this.connected,
      linkActive: this.connected,
      ssid: this.ssid,
      ssidRedacted: false,
      bssid: null,
      ipv4: this.connected ? '192.168.1.50' : null,
      routerIp: this.connected ? '192.168.1.1' : null,
      security: this.connected ? 'WPA3' : null,
      phyMode: '802.11ax',
      channel: '36',
      rssiDbm: -55,
      noiseDbm: -92,
      txRateMbps: 400,
      pingOk: null,
      pingLatencyMs: null,
      preferredNetworks: [...this.preferred],
    }
  }
}

const DEFAULTS: WifiSettings = {
  enabled: true,
  autoRecover: true,
  recoverIfPowerOff: false,
  interfaceOverride: '',
  targetSsid: '',
  checkIntervalMs: 5000,
  failureThreshold: 2,
  powerCycleDelayMs: 500,
  reconnectWaitMs: 1000,
  cooldownMs: 30000,
  pingCheckEnabled: false,
  pingHost: '',
}

describe('WifiMonitor watchdog', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  function createMonitor(driver: FakeWifiDriver, overrides: Partial<WifiSettings> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wifi-test-'))
    dirs.push(dir)
    const store = new WifiStateStore(join(dir, 'wifi-state.json'))
    let nowMs = 1_000_000
    const monitor = new WifiMonitor({
      driver,
      store,
      defaults: { ...DEFAULTS, ...overrides },
      sleep: async (ms) => { nowMs += ms },
      now: () => nowMs,
    })
    return {
      monitor,
      store,
      advance: (ms: number) => { nowMs += ms },
    }
  }

  it('triggers off -> on -> connect saved Wi-Fi after consecutive disconnect checks', async () => {
    const driver = new FakeWifiDriver()
    const { monitor } = createMonitor(driver, { failureThreshold: 2 })

    // Healthy check
    await monitor.checkOnce()
    expect(monitor.getView().status.phase).toBe('healthy')
    expect(driver.actions).toEqual([])

    // Disconnect simulated
    driver.connected = false
    driver.ssid = null

    // 1st failure: degraded, no recovery yet
    await monitor.checkOnce()
    expect(monitor.getView().status.phase).toBe('degraded')
    expect(monitor.getView().status.consecutiveFailures).toBe(1)
    expect(driver.actions).toEqual([])

    // 2nd failure: triggers auto recovery asynchronously
    await monitor.checkOnce()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(driver.actions).toEqual([
      'power:en1:off',
      'power:en1:on',
      'join:en1:OfficeWiFi',
    ])
    const view = monitor.getView()
    expect(view.status.connected).toBe(true)
    expect(view.status.ssid).toBe('OfficeWiFi')
    expect(view.status.recoveryCount).toBe(1)
    expect(view.status.phase).toBe('cooldown')
    expect(view.events[0]?.kind).toBe('reconnected')
  })

  it('respects manual Wi-Fi power-off when recoverIfPowerOff is false', async () => {
    const driver = new FakeWifiDriver()
    driver.power = 'off'
    driver.connected = false
    driver.ssid = null

    const { monitor } = createMonitor(driver, { failureThreshold: 1, recoverIfPowerOff: false })
    await monitor.checkOnce()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(driver.actions).toEqual([])
    expect(monitor.getView().status.consecutiveFailures).toBe(0)
  })

  it('prefers explicit targetSsid before remaining preferred networks', () => {
    expect(buildCandidateSsids('BackupWiFi', ['OfficeWiFi', 'BackupWiFi', 'Guest'])).toEqual([
      'BackupWiFi',
      'OfficeWiFi',
      'Guest',
    ])
  })

  it('persists settings updates and manual connect', async () => {
    const driver = new FakeWifiDriver()
    const { monitor, store } = createMonitor(driver)

    await monitor.updateSettings({ targetSsid: 'BackupWiFi', failureThreshold: 3 })
    await monitor.connectToSsid('BackupWiFi')

    expect(driver.ssid).toBe('BackupWiFi')
    const persisted = store.read()
    expect(persisted.settings?.targetSsid).toBe('BackupWiFi')
    expect(persisted.settings?.failureThreshold).toBe(3)
    expect(persisted.events?.some(e => e.kind === 'manual_connect' && e.ssid === 'BackupWiFi')).toBe(true)
  })
})
