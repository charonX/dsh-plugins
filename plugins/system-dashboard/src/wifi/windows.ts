/**
 * Windows Wi-Fi driver using `netsh wlan` and PowerShell NetAdapter/NetIP cmdlets.
 * Supports multiple wireless adapters, English and Simplified Chinese `netsh` output,
 * and UTF-8 encoding for non-ASCII adapter/SSID names.
 *
 * @module @charonx/dsh-system-dashboard/wifi/windows
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { WifiPowerState } from '../shared/types.ts'
import type { WifiDriver, WifiProbeResult } from './types.ts'

const execFileAsync = promisify(execFile)

export interface NetshInterfacesInfo {
  readonly interfaceName: string | null
  readonly description?: string | null
  readonly connected: boolean
  readonly radioOff: boolean
  readonly ssid: string | null
  readonly bssid: string | null
  readonly phyMode: string | null
  readonly channel: string | null
  readonly signalPct: number | null
  readonly txRateMbps: number | null
  readonly security: string | null
}

function isVirtualWifiDescription(desc: string | null | undefined, name: string | null | undefined): boolean {
  const text = `${desc ?? ''} ${name ?? ''}`
  return /virtual|wi-fi direct|hosted network|microsoft wi-fi direct|loopback|tap-|tun/i.test(text)
}

/**
 * Parse `netsh wlan show interfaces` output into one entry per wireless interface block.
 * Supports English and Simplified Chinese output and multi-line Radio status values.
 */
export function parseNetshWlanInterfacesList(output: string): NetshInterfacesInfo[] {
  const blocks: NetshInterfacesInfo[] = []
  let current: {
    interfaceName: string | null
    description: string | null
    connected: boolean
    radioOff: boolean
    ssid: string | null
    bssid: string | null
    phyMode: string | null
    channel: string | null
    signalPct: number | null
    txRateMbps: number | null
    security: string | null
  } | null = null
  let lastKey = ''

  const flush = () => {
    if (current && current.interfaceName) {
      blocks.push({ ...current })
    }
    current = null
    lastKey = ''
  }

  const applyField = (key: string, val: string) => {
    if (!current) return
    if (key === 'description' || key === '说明') {
      current.description = val
    } else if (key === 'state' || key === '状态') {
      const low = val.toLowerCase()
      current.connected = low === 'connected' || val === '已连接'
    } else if (key === 'radio status' || key === '无线电状态') {
      if (/(?:software|hardware)\s+off|软件\s*关闭?|硬件\s*关闭?|关闭/i.test(val)) {
        current.radioOff = true
      }
    } else if (key === 'ssid') {
      current.ssid = val
    } else if (key === 'bssid' || key === 'ap bssid') {
      current.bssid = val
    } else if (key === 'radio type' || key === '无线电类型') {
      current.phyMode = val
    } else if (key === 'channel' || key === '频道') {
      current.channel = val
    } else if (key === 'signal' || key === '信号') {
      const m = /(\d+)\s*%/.exec(val)
      if (m?.[1]) current.signalPct = Number(m[1])
    } else if (key.startsWith('transmit rate') || key.startsWith('传输速率')) {
      const m = /(\d+(?:\.\d+)?)/.exec(val)
      if (m?.[1]) current.txRateMbps = Number(m[1])
    } else if (key === 'authentication' || key === '身份验证') {
      current.security = val
    }
  }

  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flush()
      continue
    }

    const colonIdx = rawLine.indexOf(':')
    if (colonIdx === -1) {
      // Continuation line (e.g. second line of "Radio status : Hardware On\n Software Off")
      if (current && lastKey) {
        applyField(lastKey, trimmed)
      }
      continue
    }

    const key = rawLine.slice(0, colonIdx).trim().toLowerCase()
    const val = rawLine.slice(colonIdx + 1).trim()

    if (key === 'name' || key === '名称') {
      flush()
      current = {
        interfaceName: val || null,
        description: null,
        connected: false,
        radioOff: false,
        ssid: null,
        bssid: null,
        phyMode: null,
        channel: null,
        signalPct: null,
        txRateMbps: null,
        security: null,
      }
      lastKey = key
      continue
    }

    if (!current || !val) continue
    lastKey = key
    applyField(key, val)
  }

  flush()
  return blocks
}

/**
 * Pick the best matching interface block from `netsh wlan show interfaces`.
 */
export function selectBestNetshInterface(
  blocks: readonly NetshInterfacesInfo[],
  preferredName?: string | null,
): NetshInterfacesInfo | null {
  if (blocks.length === 0) return null
  if (preferredName) {
    const exact = blocks.find(b => b.interfaceName?.toLowerCase() === preferredName.toLowerCase())
    if (exact) return exact
  }
  const connectedPhysical = blocks.find(b => b.connected && !isVirtualWifiDescription(b.description, b.interfaceName))
  if (connectedPhysical) return connectedPhysical
  const connectedAny = blocks.find(b => b.connected)
  if (connectedAny) return connectedAny
  const poweredPhysical = blocks.find(b => !b.radioOff && !isVirtualWifiDescription(b.description, b.interfaceName))
  if (poweredPhysical) return poweredPhysical
  const physical = blocks.find(b => !isVirtualWifiDescription(b.description, b.interfaceName))
  return physical ?? blocks[0] ?? null
}

/**
 * Parse `netsh wlan show interfaces` output (English and Simplified Chinese), returning the primary/best block.
 */
export function parseNetshWlanInterfaces(output: string, preferredName?: string | null): NetshInterfacesInfo {
  const blocks = parseNetshWlanInterfacesList(output)
  const selected = selectBestNetshInterface(blocks, preferredName)
  return selected ?? {
    interfaceName: null,
    description: null,
    connected: false,
    radioOff: false,
    ssid: null,
    bssid: null,
    phyMode: null,
    channel: null,
    signalPct: null,
    txRateMbps: null,
    security: null,
  }
}

/**
 * Parse `netsh wlan show profiles` output (English and Simplified Chinese).
 */
export function parseNetshWlanProfiles(output: string): string[] {
  const profiles: string[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*(?:All User Profile|User Profile|所有用户配置文件|用户配置文件)\s*:\s*(.+)$/i.exec(rawLine)
    const name = match?.[1]?.replace(/\r$/, '')
    if (name && name.length > 0 && !seen.has(name)) {
      seen.add(name)
      profiles.push(name)
    }
  }
  return profiles
}

export interface WindowsNetAdapterInfo {
  readonly name: string
  readonly description: string
  readonly status: string
  readonly adminStatus: string
  readonly mediaState: string
  readonly power: WifiPowerState
  readonly linkActive: boolean
}

function normalizeAdapterStatusFields(row: Record<string, unknown>): {
  power: WifiPowerState
  linkActive: boolean
  status: string
  adminStatus: string
  mediaState: string
} {
  const rawStatus = row.Status
  const rawAdmin = row.AdminStatus
  const rawMedia = row.MediaConnectionState

  const status = String(rawStatus ?? '').toLowerCase()
  const adminStr = String(rawAdmin ?? '').toLowerCase()
  const mediaStr = String(rawMedia ?? '').toLowerCase()

  // PowerShell 5.1 enums may serialize either as string ("Up"/"Down") or integer (1=Up/Connected, 2=Down/Disconnected)
  const adminOff = adminStr === 'down' || adminStr === '2' || status === 'disabled' || status === '已禁用'
  const adminOn = adminStr === 'up' || adminStr === '1' || status === 'up' || status === 'disconnected' || status === '正常' || status === '已断开'
  const power: WifiPowerState = adminOff ? 'off' : adminOn ? 'on' : 'unknown'

  const mediaConnected = mediaStr === 'connected' || mediaStr === '1' || status === 'up'
  const linkActive = power === 'on' && mediaConnected
  return { power, linkActive, status, adminStatus: adminStr, mediaState: mediaStr }
}

/**
 * Parse PowerShell `Get-NetAdapter` JSON status (single object or array) for locale-independent radio/admin state.
 */
export function parseWindowsAdapterStatus(jsonText: string): {
  power: WifiPowerState
  linkActive: boolean
} {
  try {
    const parsed = JSON.parse(jsonText.trim()) as unknown
    const item = Array.isArray(parsed) ? parsed[0] : parsed
    if (!item || typeof item !== 'object') return { power: 'unknown', linkActive: false }
    const norm = normalizeAdapterStatusFields(item as Record<string, unknown>)
    return { power: norm.power, linkActive: norm.linkActive }
  } catch {
    return { power: 'unknown', linkActive: false }
  }
}

/**
 * Parse PowerShell list of candidate wireless adapters and sort physical/active adapters first.
 */
export function parseWindowsWifiAdaptersList(jsonText: string): WindowsNetAdapterInfo[] {
  const trimmed = jsonText.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const adapters: WindowsNetAdapterInfo[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const name = typeof r.Name === 'string' ? r.Name.trim() : ''
      const description = typeof r.InterfaceDescription === 'string' ? r.InterfaceDescription.trim() : ''
      if (!name) continue
      const norm = normalizeAdapterStatusFields(r)
      adapters.push({
        name,
        description,
        status: norm.status,
        adminStatus: norm.adminStatus,
        mediaState: norm.mediaState,
        power: norm.power,
        linkActive: norm.linkActive,
      })
    }

    // Score adapters: connected physical > powered-on physical > disabled physical > virtual
    const score = (a: WindowsNetAdapterInfo): number => {
      let s = 0
      if (!isVirtualWifiDescription(a.description, a.name)) s += 100
      if (a.power === 'on') s += 20
      if (a.linkActive) s += 50
      return s
    }
    adapters.sort((a, b) => score(b) - score(a))
    return adapters
  } catch {
    return []
  }
}

/**
 * Parse PowerShell `Get-NetIPConfiguration` JSON output for IPv4 & gateway.
 */
export function parseWindowsIpConfig(jsonText: string): {
  ipv4: string | null
  routerIp: string | null
} {
  try {
    const parsed = JSON.parse(jsonText.trim()) as {
      ipv4?: string | null
      routerIp?: string | null
      IPv4Address?: { IPAddress?: string } | Array<{ IPAddress?: string }>
      IPv4DefaultGateway?: { NextHop?: string } | Array<{ NextHop?: string }>
    }
    if (typeof parsed.ipv4 === 'string' || typeof parsed.routerIp === 'string') {
      return {
        ipv4: typeof parsed.ipv4 === 'string' && parsed.ipv4 ? parsed.ipv4 : null,
        routerIp: typeof parsed.routerIp === 'string' && parsed.routerIp ? parsed.routerIp : null,
      }
    }
    const addrObj = Array.isArray(parsed.IPv4Address) ? parsed.IPv4Address[0] : parsed.IPv4Address
    const gwObj = Array.isArray(parsed.IPv4DefaultGateway) ? parsed.IPv4DefaultGateway[0] : parsed.IPv4DefaultGateway
    return {
      ipv4: typeof addrObj?.IPAddress === 'string' ? addrObj.IPAddress : null,
      routerIp: typeof gwObj?.NextHop === 'string' ? gwObj.NextHop : null,
    }
  } catch {
    return { ipv4: null, routerIp: null }
  }
}

/**
 * Parse Windows `ping -n 1 -w 2000` latency (`time=12ms` / `time<1ms` / `时间=12ms`).
 */
export function parseWindowsPingLatency(output: string): number | null {
  const match = /(?:time|时间)\s*[=<]\s*([\d.]+)\s*ms/i.exec(output)
  if (!match?.[1]) return null
  const val = Number(match[1])
  return Number.isFinite(val) ? Math.round(val * 10) / 10 : null
}

function escapePowerShellSingleQuote(val: string): string {
  return val.replace(/'/g, "''")
}

/**
 * Build a PowerShell script that toggles Windows Wi-Fi software radio via WinRT
 * `Windows.Devices.Radios.Radio` (works without Administrator elevation on Windows 10/11).
 */
export function buildWinRtWifiRadioScript(on: boolean, ifaceName?: string): string {
  const targetState = on ? 'On' : 'Off'
  const escapedIface = escapePowerShellSingleQuote(ifaceName ?? '')
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'function Await($WinRtTask, $ResultType) {',
    '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
    '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
    '  $netTask.Wait(-1) | Out-Null',
    '  $netTask.Result',
    '}',
    '[void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]',
    '[void][Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType=WindowsRuntime]',
    '[void][Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType=WindowsRuntime]',
    '$access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])',
    "if ($access -ne 'Allowed') { throw \"WinRT Radio access denied: $access\" }",
    '$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])',
    "$wifiRadios = @($radios | Where-Object { $_.Kind -eq 'WiFi' })",
    "if ($wifiRadios.Count -eq 0) { throw 'No WinRT WiFi radio found' }",
    `$targetIface = '${escapedIface}'`,
    '$selected = @()',
    'if ($targetIface) { $selected = @($wifiRadios | Where-Object { $_.Name -eq $targetIface }) }',
    'if ($selected.Count -eq 0) { $selected = $wifiRadios }',
    'foreach ($r in $selected) {',
    `  $res = Await ($r.SetStateAsync([Windows.Devices.Radios.RadioState]::${targetState})) ([Windows.Devices.Radios.RadioAccessStatus])`,
    "  if ($res -ne 'Allowed') { throw \"SetStateAsync failed for $($r.Name): $res\" }",
    '}',
  ].join('\n')
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function runWinPowerShellEncoded(script: string, timeout = 8000): Promise<string> {
  const encoded = encodePowerShellCommand(script)
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout },
  )
  return stdout
}

async function runWinPowerShell(script: string, timeout = 5000): Promise<string> {
  const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', wrapped],
    { timeout },
  )
  return stdout
}

async function runNetsh(args: readonly string[], timeout = 5000): Promise<string> {
  // Run netsh via PowerShell with UTF-8 OutputEncoding so non-ASCII SSIDs never garble in CP936/CP437
  const escaped = args.map(a => `'${escapePowerShellSingleQuote(a)}'`).join(' ')
  try {
    return await runWinPowerShell(`& netsh.exe ${escaped}`, timeout)
  } catch {
    const { stdout } = await execFileAsync('netsh', [...args], { timeout })
    return stdout
  }
}

export class WindowsWifiDriver implements WifiDriver {
  readonly isSupported = os.platform() === 'win32'

  async detectInterfaces(): Promise<string[]> {
    if (!this.isSupported) return []
    const seen = new Set<string>()
    const ordered: string[] = []
    const push = (name: string | null | undefined) => {
      if (!name) return
      const trimmed = name.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        ordered.push(trimmed)
      }
    }

    // 1. Check `netsh wlan show interfaces` first because it directly exposes connected WLAN interfaces
    try {
      const out = await runNetsh(['wlan', 'show', 'interfaces'])
      const blocks = parseNetshWlanInterfacesList(out)
      const best = selectBestNetshInterface(blocks)
      if (best?.interfaceName) push(best.interfaceName)
      for (const b of blocks) {
        if (!isVirtualWifiDescription(b.description, b.interfaceName)) {
          push(b.interfaceName)
        }
      }
    } catch {
      // ignore
    }

    // 2. Also inspect PowerShell Get-NetAdapter (picks up disabled or secondary Wi-Fi adapters)
    try {
      const out = await runWinPowerShell(
        "Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'Wi-Fi|Wireless|WLAN|802\\.11' -or $_.Name -match 'Wi-Fi|WLAN' } | ForEach-Object { [pscustomobject]@{ Name = $_.Name; InterfaceDescription = $_.InterfaceDescription; Status = \"$($_.Status)\"; AdminStatus = \"$($_.AdminStatus)\"; MediaConnectionState = \"$($_.MediaConnectionState)\" } } | ConvertTo-Json -Compress",
      )
      const adapters = parseWindowsWifiAdaptersList(out)
      for (const a of adapters) {
        if (!isVirtualWifiDescription(a.description, a.name)) {
          push(a.name)
        }
      }
      if (ordered.length === 0) {
        for (const a of adapters) push(a.name)
      }
    } catch {
      // ignore
    }

    return ordered
  }

  async detectInterface(): Promise<string | null> {
    const list = await this.detectInterfaces()
    return list[0] ?? null
  }

  async listPreferredNetworks(iface: string): Promise<string[]> {
    if (!this.isSupported) return []
    try {
      const out = await runNetsh(['wlan', 'show', 'profiles', `interface=${iface}`])
      const profiles = parseNetshWlanProfiles(out)
      if (profiles.length > 0) return profiles
    } catch {
      // fallback without interface filter
    }
    try {
      const out = await runNetsh(['wlan', 'show', 'profiles'])
      return parseNetshWlanProfiles(out)
    } catch {
      return []
    }
  }

  async setPower(iface: string, on: boolean): Promise<void> {
    if (!this.isSupported) throw new Error('Windows Wi-Fi control requires Windows')

    // 1. Primary: WinRT Radio API (toggles Wi-Fi software radio without requiring Administrator UAC)
    let winRtError: unknown
    try {
      await runWinPowerShellEncoded(buildWinRtWifiRadioScript(on, iface), 10000)
      return
    } catch (err) {
      winRtError = err
    }

    // 2. Fallback: netsh interface admin state (requires Administrator privileges)
    const state = on ? 'enabled' : 'disabled'
    try {
      await runNetsh(['interface', 'set', 'interface', `name=${iface}`, `admin=${state}`], 8000)
      return
    } catch {
      // fallback to PowerShell NetAdapter cmdlet
    }

    // 3. Fallback: PowerShell Disable/Enable-NetAdapter (requires Administrator privileges)
    const cmdlet = on ? 'Enable-NetAdapter' : 'Disable-NetAdapter'
    try {
      await runWinPowerShell(`${cmdlet} -Name '${escapePowerShellSingleQuote(iface)}' -Confirm:$false`, 8000)
    } catch (adminErr) {
      const winRtMsg = winRtError instanceof Error ? winRtError.message : String(winRtError)
      const adminMsg = adminErr instanceof Error ? adminErr.message : String(adminErr)
      throw new Error(`Unable to toggle Wi-Fi power (${winRtMsg}; admin fallback failed: ${adminMsg})`)
    }
  }

  async joinNetwork(iface: string, ssid: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isSupported) return { ok: false, error: 'Unsupported platform' }
    try {
      const out = await runNetsh(['wlan', 'connect', `name=${ssid}`, `interface=${iface}`], 15000)
      if (/error|not found|找不到|失败/i.test(out)) {
        return { ok: false, error: out.trim() }
      }
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
        availableInterfaces: [],
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

    const qIface = escapePowerShellSingleQuote(iface)
    const [netshOut, adapterJson, ipJson, preferred, availableInterfaces] = await Promise.all([
      runNetsh(['wlan', 'show', 'interfaces']).catch(() => ''),
      runWinPowerShell(
        `Get-NetAdapter -Name '${qIface}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Status = \"$($_.Status)\"; AdminStatus = \"$($_.AdminStatus)\"; MediaConnectionState = \"$($_.MediaConnectionState)\" } } | ConvertTo-Json -Compress`,
      ).catch(() => ''),
      runWinPowerShell(
        `Get-NetIPConfiguration -InterfaceAlias '${qIface}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ipv4 = ($_.IPv4Address | Select-Object -First 1 -ExpandProperty IPAddress); routerIp = ($_.IPv4DefaultGateway | Select-Object -First 1 -ExpandProperty NextHop) } } | ConvertTo-Json -Compress`,
      ).catch(() => ''),
      this.listPreferredNetworks(iface),
      this.detectInterfaces(),
    ])

    const blocks = parseNetshWlanInterfacesList(netshOut)
    const exactBlock = blocks.find(b => b.interfaceName?.toLowerCase() === iface.toLowerCase())
    const wlan = exactBlock ?? parseNetshWlanInterfaces(netshOut, iface)
    const effectiveIface = wlan.interfaceName ?? iface

    // If `netsh` matched a different interface name than `iface` (e.g. caller passed stale name), re-read its IP
    let ip = parseWindowsIpConfig(ipJson)
    if (effectiveIface.toLowerCase() !== iface.toLowerCase()) {
      const qEffective = escapePowerShellSingleQuote(effectiveIface)
      const reIpJson = await runWinPowerShell(
        `Get-NetIPConfiguration -InterfaceAlias '${qEffective}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ipv4 = ($_.IPv4Address | Select-Object -First 1 -ExpandProperty IPAddress); routerIp = ($_.IPv4DefaultGateway | Select-Object -First 1 -ExpandProperty NextHop) } } | ConvertTo-Json -Compress`,
      ).catch(() => '')
      ip = parseWindowsIpConfig(reIpJson)
    }

    const adapter = parseWindowsAdapterStatus(adapterJson)

    // Never report `power: 'off'` when `netsh` directly confirms the WLAN interface is connected and radio is not off
    let power: WifiPowerState
    if (wlan.radioOff) {
      power = 'off'
    } else if (wlan.connected) {
      power = 'on'
    } else if (adapter.power !== 'unknown') {
      power = adapter.power
    } else if (wlan.interfaceName) {
      power = 'on'
    } else {
      power = 'unknown'
    }

    const linkActive = power === 'on' && (wlan.connected || adapter.linkActive)
    const connected = power === 'on' && (wlan.connected || (adapter.linkActive && ip.ipv4 !== null))
    const rssiDbm = wlan.signalPct !== null ? Math.round((wlan.signalPct / 2) - 100) : null

    let pingOk: boolean | null = null
    let pingLatencyMs: number | null = null
    if (options.pingCheck && connected) {
      const target = (options.pingHost && options.pingHost.trim()) || ip.routerIp || '223.5.5.5'
      try {
        const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', '2000', target], { timeout: 3500 })
        pingOk = true
        pingLatencyMs = parseWindowsPingLatency(stdout)
      } catch {
        pingOk = false
      }
    }

    return {
      supported: true,
      interfaceName: effectiveIface,
      availableInterfaces: availableInterfaces.length > 0 ? availableInterfaces : [effectiveIface],
      power,
      connected,
      linkActive,
      ssid: wlan.ssid,
      ssidRedacted: false,
      bssid: wlan.bssid,
      ipv4: ip.ipv4,
      routerIp: ip.routerIp,
      security: wlan.security,
      phyMode: wlan.phyMode,
      channel: wlan.channel,
      rssiDbm,
      noiseDbm: null,
      txRateMbps: wlan.txRateMbps,
      pingOk,
      pingLatencyMs,
      preferredNetworks: preferred,
    }
  }
}
