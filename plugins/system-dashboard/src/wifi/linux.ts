/**
 * Linux Wi-Fi driver using NetworkManager (`nmcli`) with `iw` / `ip` / `rfkill` fallbacks.
 * Runs commands with `LC_ALL=C` to ensure locale-independent output.
 *
 * @module @charonx/dsh-system-dashboard/wifi/linux
 */

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'
import type { WifiPowerState } from '../shared/types.ts'
import type { WifiDriver, WifiProbeResult } from './types.ts'

const execFileAsync = promisify(execFile)

const C_ENV = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
}

/**
 * Split an `nmcli -t` terse line respecting backslash-escaped colons (`\:`) and backslashes (`\\`).
 */
export function splitNmcliTerseLine(line: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1]
      i += 1
      continue
    }
    if (ch === ':') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * Parse `nmcli -t -f DEVICE,TYPE dev` to locate the first Wi-Fi device (e.g. `wlan0`, `wlp2s0`).
 */
export function parseNmcliWifiDevice(output: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const [device, type] = splitNmcliTerseLine(line)
    if (device && type === 'wifi') {
      return device
    }
  }
  return null
}

/**
 * Parse `nmcli radio wifi` output (`enabled` | `disabled`).
 */
export function parseNmcliRadioWifi(output: string): WifiPowerState {
  const val = output.trim().toLowerCase()
  if (val === 'enabled') return 'on'
  if (val === 'disabled') return 'off'
  return 'unknown'
}

export interface NmcliActiveWifiRow {
  readonly ssid: string | null
  readonly bssid: string | null
  readonly channel: string | null
  readonly txRateMbps: number | null
  readonly signalPct: number | null
  readonly security: string | null
}

/**
 * Parse `nmcli -t -f ACTIVE,SSID,BSSID,CHAN,RATE,SIGNAL,SECURITY dev wifi list` output.
 */
export function parseNmcliActiveWifiList(output: string): NmcliActiveWifiRow | null {
  for (const raw of output.split(/\r?\n/)) {
    if (!raw) continue
    const cols = splitNmcliTerseLine(raw)
    if (cols[0]?.toLowerCase() !== 'yes') continue
    const ssid = cols[1] && cols[1].length > 0 ? cols[1] : null
    const bssid = cols[2] && cols[2].length > 0 ? cols[2] : null
    const channel = cols[3] && cols[3].length > 0 ? cols[3] : null
    const rateMatch = /(\d+(?:\.\d+)?)/.exec(cols[4] ?? '')
    const txRateMbps = rateMatch?.[1] ? Number(rateMatch[1]) : null
    const sigVal = cols[5] ? Number(cols[5]) : Number.NaN
    const signalPct = Number.isFinite(sigVal) ? sigVal : null
    const security = cols[6] && cols[6].length > 0 ? cols[6] : null
    return {
      ssid,
      bssid,
      channel,
      txRateMbps,
      signalPct,
      security,
    }
  }
  return null
}

/**
 * Parse `nmcli -t -f GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY dev show <iface>`.
 */
export function parseNmcliDevShow(output: string): {
  connected: boolean
  ipv4: string | null
  routerIp: string | null
} {
  let connected = false
  let ipv4: string | null = null
  let routerIp: string | null = null

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (!val || val === '--') continue

    if (key === 'GENERAL.STATE') {
      connected = /^100\b/.test(val) || /\bconnected\b/i.test(val)
    } else if (key.startsWith('IP4.ADDRESS') && ipv4 === null) {
      ipv4 = val.split('/')[0]?.trim() || null
    } else if (key === 'IP4.GATEWAY' && routerIp === null) {
      routerIp = val
    }
  }

  return { connected, ipv4, routerIp }
}

/**
 * Parse `nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show` sorted by priority descending.
 */
export function parseNmcliSavedWifi(output: string): string[] {
  const entries: Array<{ name: string; priority: number }> = []
  for (const raw of output.split(/\r?\n/)) {
    if (!raw) continue
    const [name, type, prioRaw] = splitNmcliTerseLine(raw)
    if (!name || type !== '802-11-wireless') continue
    const prio = prioRaw ? Number(prioRaw) : 0
    entries.push({ name, priority: Number.isFinite(prio) ? prio : 0 })
  }
  entries.sort((a, b) => b.priority - a.priority)
  return entries.map(e => e.name)
}

/**
 * Parse `iw dev <iface> link` for exact signal dBm and bitrate when available.
 */
export function parseIwLink(output: string): {
  ssid: string | null
  rssiDbm: number | null
  txRateMbps: number | null
} {
  if (/^\s*Not connected\./im.test(output)) {
    return { ssid: null, rssiDbm: null, txRateMbps: null }
  }
  const ssidMatch = /^\s*SSID:\s*(.+)$/m.exec(output)
  const sigMatch = /^\s*signal:\s*(-?\d+)\s*dBm/im.exec(output)
  const rateMatch = /^\s*tx bitrate:\s*(\d+(?:\.\d+)?)\s*MBit\/s/im.exec(output)
  return {
    ssid: ssidMatch?.[1]?.trim() || null,
    rssiDbm: sigMatch?.[1] ? Number(sigMatch[1]) : null,
    txRateMbps: rateMatch?.[1] ? Number(rateMatch[1]) : null,
  }
}

/**
 * Parse Linux `ping` latency (`time=1.23 ms`).
 */
export function parseLinuxPingLatency(output: string): number | null {
  const match = /time[=<]\s*([\d.]+)\s*ms/i.exec(output)
  if (!match?.[1]) return null
  const val = Number(match[1])
  return Number.isFinite(val) ? Math.round(val * 10) / 10 : null
}

async function runLinuxCmd(bin: string, args: readonly string[], timeout = 4000): Promise<string> {
  const { stdout } = await execFileAsync(bin, [...args], { timeout, env: C_ENV })
  return stdout
}

export class LinuxWifiDriver implements WifiDriver {
  readonly isSupported = os.platform() === 'linux'

  async detectInterface(): Promise<string | null> {
    if (!this.isSupported) return null
    try {
      const out = await runLinuxCmd('nmcli', ['-t', '-f', 'DEVICE,TYPE', 'dev'])
      const dev = parseNmcliWifiDevice(out)
      if (dev) return dev
    } catch {
      // fallback to sysfs
    }
    try {
      const entries = await readdir('/sys/class/net')
      for (const name of entries) {
        try {
          await readdir(`/sys/class/net/${name}/wireless`)
          return name
        } catch {
          // not wireless
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  async listPreferredNetworks(_iface: string): Promise<string[]> {
    if (!this.isSupported) return []
    try {
      const out = await runLinuxCmd('nmcli', ['-t', '-f', 'NAME,TYPE,AUTOCONNECT-PRIORITY', 'connection', 'show'])
      return parseNmcliSavedWifi(out)
    } catch {
      return []
    }
  }

  async setPower(iface: string, on: boolean): Promise<void> {
    if (!this.isSupported) throw new Error('Linux Wi-Fi control requires Linux')
    try {
      await runLinuxCmd('nmcli', ['radio', 'wifi', on ? 'on' : 'off'], 8000)
      return
    } catch {
      // Fallback to rfkill or ip link
    }
    try {
      await runLinuxCmd('rfkill', [on ? 'unblock' : 'block', 'wifi'], 5000)
      return
    } catch {
      await runLinuxCmd('ip', ['link', 'set', iface, on ? 'up' : 'down'], 5000)
    }
  }

  async joinNetwork(iface: string, ssid: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isSupported) return { ok: false, error: 'Unsupported platform' }
    // First try activating saved NetworkManager connection profile by name
    try {
      await runLinuxCmd('nmcli', ['connection', 'up', 'id', ssid], 15000)
      return { ok: true }
    } catch {
      // Fallback: direct device wifi connect
    }
    try {
      await runLinuxCmd('nmcli', ['device', 'wifi', 'connect', ssid, 'ifname', iface], 15000)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async probeStatus(
    iface: string,
    options: { includeRadioDetails?: boolean; pingCheck?: boolean; pingHost?: string } = {},
  ): Promise<WifiProbeResult> {
    if (!this.isSupported) {
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

    const [radioOut, devShowOut, wifiListOut, iwOut, preferred] = await Promise.all([
      runLinuxCmd('nmcli', ['radio', 'wifi']).catch(() => ''),
      runLinuxCmd('nmcli', ['-t', '-f', 'GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY', 'dev', 'show', iface]).catch(() => ''),
      runLinuxCmd('nmcli', ['-t', '-f', 'ACTIVE,SSID,BSSID,CHAN,RATE,SIGNAL,SECURITY', 'dev', 'wifi', 'list', 'ifname', iface, '--rescan', 'no']).catch(() => ''),
      runLinuxCmd('iw', ['dev', iface, 'link']).catch(() => ''),
      this.listPreferredNetworks(iface),
    ])

    const power = parseNmcliRadioWifi(radioOut)
    const devInfo = parseNmcliDevShow(devShowOut)
    const activeWifi = parseNmcliActiveWifiList(wifiListOut)
    const iwInfo = parseIwLink(iwOut)

    const ssid = activeWifi?.ssid ?? iwInfo.ssid
    const linkActive = power === 'on' && (devInfo.connected || activeWifi !== null || iwInfo.ssid !== null)
    const connected = power === 'on' && linkActive && (devInfo.connected || devInfo.ipv4 !== null || ssid !== null)
    const approxDbm = activeWifi?.signalPct !== null && activeWifi?.signalPct !== undefined
      ? Math.round((activeWifi.signalPct / 2) - 100)
      : null

    let pingOk: boolean | null = null
    let pingLatencyMs: number | null = null
    if (options.pingCheck && connected) {
      const target = (options.pingHost && options.pingHost.trim()) || devInfo.routerIp || '223.5.5.5'
      try {
        // Linux ping -W takes seconds
        const pingOut = await runLinuxCmd('ping', ['-c', '1', '-W', '2', target], 3500)
        pingOk = true
        pingLatencyMs = parseLinuxPingLatency(pingOut)
      } catch {
        pingOk = false
      }
    }

    return {
      supported: true,
      interfaceName: iface,
      power,
      connected,
      linkActive,
      ssid,
      ssidRedacted: false,
      bssid: activeWifi?.bssid ?? null,
      ipv4: devInfo.ipv4,
      routerIp: devInfo.routerIp,
      security: activeWifi?.security ?? null,
      phyMode: null,
      channel: activeWifi?.channel ?? null,
      rssiDbm: iwInfo.rssiDbm ?? approxDbm,
      noiseDbm: null,
      txRateMbps: iwInfo.txRateMbps ?? activeWifi?.txRateMbps ?? null,
      pingOk,
      pingLatencyMs,
      preferredNetworks: preferred,
    }
  }
}
