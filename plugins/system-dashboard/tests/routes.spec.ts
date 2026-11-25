import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SystemCollector } from '../src/collectors/system.ts'
import { createRequestHandler } from '../src/http/routes.ts'
import { DEFAULT_ROUTE_PREFIX } from '../src/shared/types.ts'
import type { WifiDriver, WifiProbeResult } from '../src/wifi/darwin.ts'
import { WifiMonitor } from '../src/wifi/monitor.ts'
import { WifiStateStore } from '../src/wifi/store.ts'

class StubDriver implements WifiDriver {
  readonly isSupported = true
  power: 'on' | 'off' = 'on'
  connected = true
  ssid: string | null = 'HomeNet'

  async detectInterface(): Promise<string | null> {
    return 'en1'
  }
  async listPreferredNetworks(): Promise<string[]> {
    return ['HomeNet', 'MobileHotspot']
  }
  async setPower(_iface: string, on: boolean): Promise<void> {
    this.power = on ? 'on' : 'off'
    this.connected = on
  }
  async joinNetwork(_iface: string, ssid: string): Promise<{ ok: boolean }> {
    this.ssid = ssid
    this.connected = true
    return { ok: true }
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
      ipv4: this.connected ? '10.0.0.5' : null,
      routerIp: '10.0.0.1',
      security: 'WPA2',
      phyMode: '802.11ax',
      channel: '149',
      rssiDbm: -58,
      noiseDbm: -90,
      txRateMbps: 600,
      pingOk: null,
      pingLatencyMs: null,
      preferredNetworks: ['HomeNet', 'MobileHotspot'],
    }
  }
}

function invokeHandler(
  handler: ReturnType<typeof createRequestHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as IncomingMessage
    req.method = method
    req.url = url

    let status = 200
    let raw = ''
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      end(chunk?: string) {
        raw += chunk ?? ''
        try {
          resolve({ status, json: raw ? JSON.parse(raw) : {} })
        } catch (err) {
          reject(err)
        }
      },
    } as unknown as ServerResponse

    const promise = handler(req, res)
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    }
    req.emit('end')
    void promise.catch(reject)
  })
}

describe('HTTP routes', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('serves snapshot and Wi-Fi actions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-routes-test-'))
    dirs.push(dir)

    const ctx = { get: () => undefined } as unknown as Context
    const systemCollector = new SystemCollector()
    const wifiMonitor = new WifiMonitor({
      driver: new StubDriver(),
      store: new WifiStateStore(join(dir, 'wifi.json')),
      sleep: async () => undefined,
      defaults: {
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
      },
    })

    const handler = createRequestHandler({
      prefix: DEFAULT_ROUTE_PREFIX,
      ctx,
      systemCollector,
      wifiMonitor,
    })

    const snapRes = await invokeHandler(handler, 'GET', `${DEFAULT_ROUTE_PREFIX}/snapshot`)
    expect(snapRes.status).toBe(200)
    expect(snapRes.json.system).toBeDefined()
    expect(snapRes.json.dsh).toBeDefined()
    expect(snapRes.json.wifi).toBeDefined()

    const settingsRes = await invokeHandler(handler, 'PUT', `${DEFAULT_ROUTE_PREFIX}/wifi/settings`, {
      targetSsid: 'MobileHotspot',
      failureThreshold: 4,
    })
    expect(settingsRes.status).toBe(200)
    expect((settingsRes.json.settings as Record<string, unknown>).targetSsid).toBe('MobileHotspot')

    const recoverRes = await invokeHandler(handler, 'POST', `${DEFAULT_ROUTE_PREFIX}/wifi/recover`, {})
    expect(recoverRes.status).toBe(200)
    expect((recoverRes.json.status as Record<string, unknown>).recoveryCount).toBe(1)

    const badConnect = await invokeHandler(handler, 'POST', `${DEFAULT_ROUTE_PREFIX}/wifi/connect`, {})
    expect(badConnect.status).toBe(400)

    const missing = await invokeHandler(handler, 'GET', `${DEFAULT_ROUTE_PREFIX}/unknown`)
    expect(missing.status).toBe(404)
  })
})
