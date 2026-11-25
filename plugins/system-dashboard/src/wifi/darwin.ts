/**
 * macOS Wi-Fi driver and pure CLI output parsers.
 * Uses `execFile` exclusively with argument arrays to prevent shell injection
 * on SSIDs containing spaces, quotes, or unicode characters.
 *
 * @module @charonx/dsh-system-dashboard/wifi/darwin
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { WifiPowerState } from '../shared/types.ts'
import type { WifiDriver, WifiProbeResult } from './types.ts'

export type { WifiDriver, WifiProbeResult } from './types.ts'

const execFileAsync = promisify(execFile)

export interface IpconfigWifiSummary {
  readonly linkStatusActive: boolean | null
  readonly ssid: string | null
  readonly ssidRedacted: boolean
  readonly bssid: string | null
  readonly ipv4: string | null
  readonly routerIp: string | null
  readonly security: string | null
}

export interface IfconfigWifiInfo {
  readonly active: boolean | null
  readonly ipv4: string | null
}

export interface SystemProfilerWifiInfo {
  readonly connected: boolean | null
  readonly phyMode: string | null
  readonly channel: string | null
  readonly rssiDbm: number | null
  readonly noiseDbm: number | null
  readonly txRateMbps: number | null
  readonly security: string | null
}

/**
 * Parse `networksetup -listallhardwareports` to locate the Wi-Fi / AirPort device (e.g. `en0` or `en1`).
 */
export function parseHardwarePortsForWifi(output: string): string | null {
  const blocks = output.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const portMatch = /Hardware Port:\s*(.+)/i.exec(block)
    const devMatch = /Device:\s*(\S+)/i.exec(block)
    const portName = portMatch?.[1]?.trim() ?? ''
    const devName = devMatch?.[1]?.trim() ?? ''
    if (!devName) continue
    if (/^(wi-fi|airport)$/i.test(portName) || /wi-fi|airport/i.test(portName)) {
      return devName
    }
  }
  return null
}

/**
 * Parse `networksetup -getairportpower <iface>` output.
 */
export function parseAirportPower(output: string): WifiPowerState {
  const match = /:\s*(on|off)\s*$/im.exec(output.trim())
  if (!match?.[1]) return 'unknown'
  return match[1].toLowerCase() === 'on' ? 'on' : 'off'
}

/**
 * Parse `networksetup -getairportnetwork <iface>` output.
 * Note: macOS 14+ without Location entitlement often prints "You are not associated with an AirPort network."
 * even while connected; callers must not rely on null here as proof of disconnection.
 */
export function parseAirportNetwork(output: string): string | null {
  const match = /^Current (?:Wi-Fi|AirPort) Network:\s*(.+)$/im.exec(output)
  if (!match?.[1]) return null
  const ssid = match[1].replace(/\r$/, '')
  return ssid.length > 0 ? ssid : null
}

/**
 * Parse `networksetup -listpreferredwirelessnetworks <iface>`.
 * Preserves any trailing spaces in SSID names (only strips the leading tab added by networksetup).
 */
export function parsePreferredNetworks(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const ssids: string[] = []
  for (const line of lines) {
    if (!line || /^Preferred networks on /i.test(line)) continue
    if (!/^\s+/.test(line)) continue
    const ssid = line.replace(/^\t/, '').replace(/^ +/, '')
    if (ssid.length > 0) ssids.push(ssid)
  }
  return ssids
}

/**
 * Parse `ipconfig getsummary <iface>`.
 */
export function parseIpconfigSummary(output: string): IpconfigWifiSummary {
  const linkMatch = /^\s*LinkStatusActive\s*:\s*(TRUE|FALSE)\s*$/im.exec(output)
  const linkStatusActive = linkMatch?.[1]
    ? linkMatch[1].toUpperCase() === 'TRUE'
    : null

  const ssidMatch = /^\s*SSID\s*:\s*(.+)$/im.exec(output)
  const rawSsid = ssidMatch?.[1]?.trim() ?? null
  const ssidRedacted = rawSsid === '<redacted>'
  const ssid = rawSsid && !ssidRedacted ? rawSsid : null

  const bssidMatch = /^\s*BSSID\s*:\s*(.+)$/im.exec(output)
  const rawBssid = bssidMatch?.[1]?.trim() ?? null
  const bssid = rawBssid && rawBssid !== '<redacted>' ? rawBssid : null

  const securityMatch = /^\s*Security\s*:\s*(.+)$/im.exec(output)
  const security = securityMatch?.[1]?.trim() ?? null

  const routerMatch = /^\s*Router\s*:\s*([0-9.]+)\s*$/im.exec(output)
  const routerIp = routerMatch?.[1]?.trim() ?? null

  // Extract first non-link-local IPv4 inside IPv4 Addresses array
  let ipv4: string | null = null
  const ipv4Section = /IPv4\s*:\s*<array>([\s\S]*?)^\s*\}/m.exec(output)
  const searchRegion = ipv4Section?.[1] ?? output
  const addrMatch = /Addresses\s*:\s*<array>\s*\{\s*\n\s*\d+\s*:\s*([0-9.]+)/m.exec(searchRegion)
  if (addrMatch?.[1]) {
    ipv4 = addrMatch[1]
  } else {
    const serverYiaddr = /yiaddr\s*=\s*([0-9.]+)/m.exec(output)
    if (serverYiaddr?.[1] && serverYiaddr[1] !== '0.0.0.0') {
      ipv4 = serverYiaddr[1]
    }
  }

  return {
    linkStatusActive,
    ssid,
    ssidRedacted,
    bssid,
    ipv4,
    routerIp,
    security,
  }
}

/**
 * Parse `ifconfig <iface>` output for link status and IPv4 address.
 */
export function parseIfconfigWifi(output: string): IfconfigWifiInfo {
  const statusMatch = /^\s*status:\s*(active|inactive)\b/im.exec(output)
  const active = statusMatch?.[1]
    ? statusMatch[1].toLowerCase() === 'active'
    : null
  const inetMatch = /^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\b/m.exec(output)
  const ipv4 = inetMatch?.[1] ?? null
  return { active, ipv4 }
}

/**
 * Parse `system_profiler SPAirPortDataType` output for radio telemetry.
 */
export function parseSystemProfilerWifi(output: string, iface?: string): SystemProfilerWifiInfo {
  let section = output
  if (iface) {
    const escaped = iface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const idx = output.search(new RegExp(`^\\s*${escaped}:`, 'm'))
    if (idx !== -1) {
      section = output.slice(idx)
    }
  }

  const statusMatch = /^\s*Status:\s*(.+)$/im.exec(section)
  const statusVal = statusMatch?.[1]?.trim().toLowerCase()
  const connected = statusVal === undefined
    ? null
    : statusVal === 'connected'

  // Restrict radio metrics to Current Network Information block if present
  const currentIdx = section.indexOf('Current Network Information:')
  const otherIdx = section.indexOf('Other Local Wi-Fi Networks:')
  const currentBlock = currentIdx !== -1
    ? section.slice(currentIdx, otherIdx !== -1 && otherIdx > currentIdx ? otherIdx : undefined)
    : section

  const phyMatch = /^\s*PHY Mode:\s*(.+)$/im.exec(currentBlock)
  const channelMatch = /^\s*Channel:\s*(.+)$/im.exec(currentBlock)
  const securityMatch = /^\s*Security:\s*(.+)$/im.exec(currentBlock)
  const signalNoiseMatch = /^\s*Signal\s*\/\s*Noise:\s*(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/im.exec(currentBlock)
  const txRateMatch = /^\s*Transmit Rate:\s*(\d+(?:\.\d+)?)/im.exec(currentBlock)

  return {
    connected,
    phyMode: phyMatch?.[1]?.trim() ?? null,
    channel: channelMatch?.[1]?.trim() ?? null,
    rssiDbm: signalNoiseMatch?.[1] ? Number(signalNoiseMatch[1]) : null,
    noiseDbm: signalNoiseMatch?.[2] ? Number(signalNoiseMatch[2]) : null,
    txRateMbps: txRateMatch?.[1] ? Number(txRateMatch[1]) : null,
    security: securityMatch?.[1]?.trim() ?? null,
  }
}

/**
 * Parse `ping` output latency in milliseconds.
 */
export function parsePingLatency(output: string): number | null {
  const match = /time[=<]\s*([\d.]+)\s*ms/i.exec(output)
  if (!match?.[1]) return null
  const val = Number(match[1])
  return Number.isFinite(val) ? Math.round(val * 10) / 10 : null
}

async function runCmd(bin: string, args: readonly string[], timeout = 4000): Promise<string> {
  const { stdout } = await execFileAsync(bin, [...args], { timeout })
  return stdout
}

export class DarwinWifiDriver implements WifiDriver {
  readonly isSupported = os.platform() === 'darwin'
  private cachedRadio: { at: number; iface: string; info: SystemProfilerWifiInfo } | undefined

  async detectInterface(): Promise<string | null> {
    if (!this.isSupported) return null
    try {
      const out = await runCmd('networksetup', ['-listallhardwareports'])
      return parseHardwarePortsForWifi(out)
    } catch {
      return null
    }
  }

  async listPreferredNetworks(iface: string): Promise<string[]> {
    if (!this.isSupported) return []
    try {
      const out = await runCmd('networksetup', ['-listpreferredwirelessnetworks', iface])
      return parsePreferredNetworks(out)
    } catch {
      return []
    }
  }

  async setPower(iface: string, on: boolean): Promise<void> {
    if (!this.isSupported) throw new Error('Wi-Fi power control is only supported on macOS')
    await runCmd('networksetup', ['-setairportpower', iface, on ? 'on' : 'off'], 8000)
    this.cachedRadio = undefined
  }

  async joinNetwork(iface: string, ssid: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isSupported) return { ok: false, error: 'Unsupported platform' }
    try {
      const { stdout, stderr } = await execFileAsync(
        'networksetup',
        ['-setairportnetwork', iface, ssid],
        { timeout: 15000 },
      )
      const combined = `${stdout}\n${stderr}`.trim()
      if (/could not find network|failed to join|error/i.test(combined)) {
        return { ok: false, error: combined }
      }
      this.cachedRadio = undefined
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

    const [powerOut, summaryOut, ifconfigOut, airportNetOut, preferred] = await Promise.all([
      runCmd('networksetup', ['-getairportpower', iface]).catch(() => ''),
      runCmd('ipconfig', ['getsummary', iface]).catch(() => ''),
      runCmd('ifconfig', [iface]).catch(() => ''),
      runCmd('networksetup', ['-getairportnetwork', iface]).catch(() => ''),
      this.listPreferredNetworks(iface),
    ])

    const power = parseAirportPower(powerOut)
    const summary = parseIpconfigSummary(summaryOut)
    const ifcfg = parseIfconfigWifi(ifconfigOut)
    const legacySsid = parseAirportNetwork(airportNetOut)

    const linkActive = power === 'on' && (
      summary.linkStatusActive === true ||
      ifcfg.active === true
    )
    const ipv4 = summary.ipv4 ?? ifcfg.ipv4
    const ssid = summary.ssid ?? legacySsid
    const ssidRedacted = summary.ssidRedacted && ssid === null
    const connected = power === 'on' && linkActive && (
      ipv4 !== null ||
      ssid !== null ||
      summary.security !== null
    )

    // Radio details from system_profiler (cached 15s unless explicitly requested)
    let radio: SystemProfilerWifiInfo | undefined
    const now = Date.now()
    if (
      connected &&
      (options.includeRadioDetails || !this.cachedRadio || this.cachedRadio.iface !== iface || now - this.cachedRadio.at > 15000)
    ) {
      try {
        const spOut = await runCmd('system_profiler', ['SPAirPortDataType'], 5000)
        radio = parseSystemProfilerWifi(spOut, iface)
        this.cachedRadio = { at: now, iface, info: radio }
      } catch {
        radio = this.cachedRadio?.iface === iface ? this.cachedRadio.info : undefined
      }
    } else if (connected && this.cachedRadio?.iface === iface) {
      radio = this.cachedRadio.info
    }

    let pingOk: boolean | null = null
    let pingLatencyMs: number | null = null
    if (options.pingCheck && connected) {
      const target = (options.pingHost && options.pingHost.trim()) || summary.routerIp || '223.5.5.5'
      try {
        const pingOut = await runCmd('ping', ['-c', '1', '-W', '2000', target], 3500)
        pingOk = true
        pingLatencyMs = parsePingLatency(pingOut)
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
      ssidRedacted,
      bssid: summary.bssid,
      ipv4,
      routerIp: summary.routerIp,
      security: summary.security ?? radio?.security ?? null,
      phyMode: radio?.phyMode ?? null,
      channel: radio?.channel ?? null,
      rssiDbm: radio?.rssiDbm ?? null,
      noiseDbm: radio?.noiseDbm ?? null,
      txRateMbps: radio?.txRateMbps ?? null,
      pingOk,
      pingLatencyMs,
      preferredNetworks: preferred,
    }
  }
}
