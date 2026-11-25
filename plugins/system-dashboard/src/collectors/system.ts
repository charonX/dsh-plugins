/**
 * System telemetry collector: CPU (os.cpus delta + loadavg), Memory (macOS vm_stat / swapusage
 * with node:os fallback), Network (netstat -ibn / /proc/net/dev + os.networkInterfaces), and
 * bounded rolling history for live charts.
 *
 * @module @charonx/dsh-system-dashboard/collectors/system
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'
import type {
  CpuCoreView,
  CpuSnapshot,
  MemorySnapshot,
  NetworkInterfaceStats,
  NetworkSnapshot,
  SystemMetricPoint,
  SystemSnapshot,
} from '../shared/types.ts'

const execFileAsync = promisify(execFile)

export interface CpuTimesSample {
  readonly user: number
  readonly nice: number
  readonly sys: number
  readonly idle: number
  readonly irq: number
}

export interface NetCounterSample {
  readonly name: string
  readonly rxBytes: number
  readonly txBytes: number
  readonly rxErrors: number
  readonly txErrors: number
}

/**
 * Compute overall and per-core CPU percentages from two `os.cpus()` snapshots.
 */
export function computeCpuDelta(
  prev: readonly CpuTimesSample[],
  curr: readonly CpuTimesSample[],
): {
  usagePct: number
  userPct: number
  sysPct: number
  idlePct: number
  perCore: CpuCoreView[]
} {
  let totalUser = 0
  let totalSys = 0
  let totalIdle = 0
  let totalAll = 0
  const perCore: CpuCoreView[] = []

  const count = Math.min(prev.length, curr.length)
  for (let i = 0; i < count; i += 1) {
    const p = prev[i]
    const c = curr[i]
    if (!p || !c) continue
    const dUser = Math.max(0, (c.user - p.user) + (c.nice - p.nice))
    const dSys = Math.max(0, (c.sys - p.sys) + (c.irq - p.irq))
    const dIdle = Math.max(0, c.idle - p.idle)
    const dTotal = dUser + dSys + dIdle

    totalUser += dUser
    totalSys += dSys
    totalIdle += dIdle
    totalAll += dTotal

    const coreUsage = dTotal > 0 ? ((dTotal - dIdle) / dTotal) * 100 : 0
    perCore.push({
      core: i,
      usagePct: round1(coreUsage),
    })
  }

  if (totalAll <= 0) {
    return {
      usagePct: 0,
      userPct: 0,
      sysPct: 0,
      idlePct: 100,
      perCore: curr.map((_, idx) => ({ core: idx, usagePct: 0 })),
    }
  }

  const userPct = (totalUser / totalAll) * 100
  const sysPct = (totalSys / totalAll) * 100
  const idlePct = (totalIdle / totalAll) * 100
  const usagePct = Math.max(0, Math.min(100, 100 - idlePct))

  return {
    usagePct: round1(usagePct),
    userPct: round1(userPct),
    sysPct: round1(sysPct),
    idlePct: round1(idlePct),
    perCore,
  }
}

/**
 * Parse macOS `vm_stat` output into byte-level memory breakdown.
 */
export function parseDarwinVmStat(output: string, totalBytes: number): MemorySnapshot | undefined {
  const pageMatch = /page size of (\d+) bytes/i.exec(output)
  const pageSize = pageMatch?.[1] ? Number(pageMatch[1]) : 4096
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined

  const readPages = (label: string): number => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escaped}:\\s+(\\d+)\\.?`, 'mi')
    const m = re.exec(output)
    return m?.[1] ? Number(m[1]) : 0
  }

  const freePages = readPages('Pages free')
  const activePages = readPages('Pages active')
  const inactivePages = readPages('Pages inactive')
  const speculativePages = readPages('Pages speculative')
  const wiredPages = readPages('Pages wired down')
  const compressorPages = readPages('Pages occupied by compressor')
  const fileBackedPages = readPages('File-backed pages')

  // Guard against completely malformed output
  if (freePages === 0 && activePages === 0 && wiredPages === 0) {
    return undefined
  }

  const activeBytes = activePages * pageSize
  const wiredBytes = wiredPages * pageSize
  const compressedBytes = compressorPages * pageSize
  const cachedBytes = (inactivePages + speculativePages + fileBackedPages) * pageSize
  const rawUsed = activeBytes + wiredBytes + compressedBytes
  const usedBytes = Math.max(0, Math.min(totalBytes, rawUsed))
  const freeBytes = Math.max(0, totalBytes - usedBytes)
  const usedPct = totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPct,
    activeBytes,
    wiredBytes,
    compressedBytes,
    cachedBytes,
    source: 'darwin-vm-stat',
  }
}

/**
 * Parse macOS `sysctl -n vm.swapusage` output:
 * e.g. `total = 7168.00M  used = 5473.12M  free = 1694.88M  (encrypted)`
 */
export function parseDarwinSwapUsage(output: string): { swapTotalBytes: number; swapUsedBytes: number } | undefined {
  const parseUnit = (key: string): number | undefined => {
    const re = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGTP]?)`, 'i')
    const m = re.exec(output)
    if (!m?.[1]) return undefined
    const val = Number(m[1])
    if (!Number.isFinite(val)) return undefined
    const unit = (m[2] ?? 'M').toUpperCase()
    const mult = unit === 'K' ? 1024
      : unit === 'M' ? 1024 ** 2
      : unit === 'G' ? 1024 ** 3
      : unit === 'T' ? 1024 ** 4
      : 1
    return Math.round(val * mult)
  }

  const swapTotalBytes = parseUnit('total')
  const swapUsedBytes = parseUnit('used')
  if (swapTotalBytes === undefined || swapUsedBytes === undefined) return undefined
  return { swapTotalBytes, swapUsedBytes }
}

/**
 * Parse macOS `netstat -ibn` output, selecting `<Link#...>` rows to avoid double-counting aliases.
 */
export function parseNetstatIbn(output: string): NetCounterSample[] {
  const rows = new Map<string, NetCounterSample>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || !line.includes('<Link#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 10) continue

    const name = parts[0]?.replace(/\*$/, '')
    if (!name) continue

    // Last 7 columns are always: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const len = parts.length
    const ierrs = Number(parts[len - 6])
    const ibytes = Number(parts[len - 5])
    const oerrs = Number(parts[len - 3])
    const obytes = Number(parts[len - 2])

    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue

    // If duplicate interface names appear, keep the entry with larger byte total
    const prev = rows.get(name)
    if (!prev || ibytes + obytes > prev.rxBytes + prev.txBytes) {
      rows.set(name, {
        name,
        rxBytes: ibytes,
        txBytes: obytes,
        rxErrors: Number.isFinite(ierrs) ? ierrs : 0,
        txErrors: Number.isFinite(oerrs) ? oerrs : 0,
      })
    }
  }
  return [...rows.values()]
}

/**
 * Parse Linux `/proc/net/dev` output for cross-platform support.
 */
export function parseProcNetDev(output: string): NetCounterSample[] {
  const result: NetCounterSample[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const colonIdx = rawLine.indexOf(':')
    if (colonIdx === -1) continue
    const name = rawLine.slice(0, colonIdx).trim()
    const rest = rawLine.slice(colonIdx + 1).trim().split(/\s+/)
    if (!name || rest.length < 11) continue
    const rxBytes = Number(rest[0])
    const rxErrors = Number(rest[2])
    const txBytes = Number(rest[8])
    const txErrors = Number(rest[10])
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    result.push({
      name,
      rxBytes,
      txBytes,
      rxErrors: Number.isFinite(rxErrors) ? rxErrors : 0,
      txErrors: Number.isFinite(txErrors) ? txErrors : 0,
    })
  }
  return result
}

/**
 * Parse Linux `/proc/meminfo` output into byte-level memory breakdown.
 */
export function parseLinuxMemInfo(output: string): MemorySnapshot | undefined {
  const fields = new Map<string, number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_()]+):\s+(\d+)\s*kB/i.exec(line.trim())
    if (match?.[1] && match[2]) {
      fields.set(match[1], Number(match[2]) * 1024)
    }
  }
  const totalBytes = fields.get('MemTotal')
  if (!totalBytes || totalBytes <= 0) return undefined

  const freeRaw = fields.get('MemFree') ?? 0
  const buffers = fields.get('Buffers') ?? 0
  const cached = fields.get('Cached') ?? 0
  const reclaimable = fields.get('SReclaimable') ?? 0
  const availableBytes = fields.get('MemAvailable') ?? (freeRaw + buffers + cached + reclaimable)
  const usedBytes = Math.max(0, Math.min(totalBytes, totalBytes - availableBytes))
  const freeBytes = Math.max(0, totalBytes - usedBytes)
  const usedPct = round1((usedBytes / totalBytes) * 100)

  const activeBytes = fields.get('Active')
  const cachedBytes = buffers + cached + reclaimable
  const swapTotal = fields.get('SwapTotal')
  const swapFree = fields.get('SwapFree')
  const swapUsedBytes = swapTotal !== undefined && swapFree !== undefined
    ? Math.max(0, swapTotal - swapFree)
    : undefined

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPct,
    ...(activeBytes !== undefined ? { activeBytes } : {}),
    cachedBytes,
    ...(swapTotal !== undefined ? { swapTotalBytes: swapTotal } : {}),
    ...(swapUsedBytes !== undefined ? { swapUsedBytes } : {}),
    source: 'linux-proc-meminfo',
  }
}

/**
 * Parse Linux `/etc/os-release` PRETTY_NAME.
 */
export function parseLinuxOsRelease(output: string): string | undefined {
  const match = /^PRETTY_NAME=(?:"([^"]+)"|'([^']+)'|(\S+))/m.exec(output)
  const val = match?.[1] ?? match?.[2] ?? match?.[3]
  return val?.trim() || undefined
}

/**
 * Parse Windows PowerShell `Get-NetAdapterStatistics | Select Name,ReceivedBytes,SentBytes | ConvertTo-Json` output.
 */
export function parseWindowsNetAdapterStats(output: string): NetCounterSample[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const result: NetCounterSample[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const name = typeof r.Name === 'string' ? r.Name.trim() : ''
      const rxBytes = typeof r.ReceivedBytes === 'number' ? r.ReceivedBytes : Number(r.ReceivedBytes)
      const txBytes = typeof r.SentBytes === 'number' ? r.SentBytes : Number(r.SentBytes)
      if (!name || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
      result.push({
        name,
        rxBytes,
        txBytes,
        rxErrors: 0,
        txErrors: 0,
      })
    }
    return result
  } catch {
    return []
  }
}

/**
 * Parse Windows `netstat -e` aggregate interface statistics as a fallback.
 */
export function parseWindowsNetstatE(output: string): NetCounterSample[] {
  for (const line of output.split(/\r?\n/)) {
    // Matches the "Bytes  <received>  <sent>" row in both English ("Bytes") and Chinese ("字节")
    const match = /^\s*(?:Bytes|字节)\s+(\d+)\s+(\d+)\s*$/i.exec(line)
    if (match?.[1] && match[2]) {
      const rxBytes = Number(match[1])
      const txBytes = Number(match[2])
      if (Number.isFinite(rxBytes) && Number.isFinite(txBytes)) {
        return [{ name: 'aggregate', rxBytes, txBytes, rxErrors: 0, txErrors: 0 }]
      }
    }
  }
  return []
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export interface SystemCollectorOptions {
  readonly sampleIntervalMs?: number
  readonly historySize?: number
}

export class SystemCollector {
  private readonly sampleIntervalMs: number
  private readonly historySize: number
  private prevCpu: CpuTimesSample[]
  private prevNetCounters = new Map<string, NetCounterSample>()
  private prevNetTimeMs = 0
  private history: SystemMetricPoint[] = []
  private latestSnapshot: SystemSnapshot | undefined
  private cachedOsVersion: string | undefined
  private sampling: Promise<SystemSnapshot> | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(options: SystemCollectorOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2000
    this.historySize = options.historySize ?? 60
    this.prevCpu = os.cpus().map(c => ({ ...c.times }))
  }

  start(): () => void {
    void this.sample().catch(() => undefined)
    this.timer = setInterval(() => {
      void this.sample().catch(() => undefined)
    }, this.sampleIntervalMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async getSnapshot(): Promise<SystemSnapshot> {
    if (this.latestSnapshot) return this.latestSnapshot
    return this.sample()
  }

  async sample(): Promise<SystemSnapshot> {
    if (this.sampling) return this.sampling
    this.sampling = this.collectOnce().finally(() => {
      this.sampling = undefined
    })
    return this.sampling
  }

  private async collectOnce(): Promise<SystemSnapshot> {
    const now = Date.now()

    // 1. CPU
    const cpus = os.cpus()
    const currCpu: CpuTimesSample[] = cpus.map(c => ({ ...c.times }))
    const cpuDelta = computeCpuDelta(this.prevCpu, currCpu)
    this.prevCpu = currCpu
    const rawLoad = os.loadavg()
    const cpu: CpuSnapshot = {
      model: cpus[0]?.model?.trim() || 'Unknown CPU',
      cores: cpus.length,
      arch: os.arch(),
      usagePct: cpuDelta.usagePct,
      userPct: cpuDelta.userPct,
      sysPct: cpuDelta.sysPct,
      idlePct: cpuDelta.idlePct,
      loadAvg: [
        round1(rawLoad[0] ?? 0),
        round1(rawLoad[1] ?? 0),
        round1(rawLoad[2] ?? 0),
      ],
      perCore: cpuDelta.perCore,
    }

    // 2. Memory
    const memory = await this.readMemory()

    // 3. Network
    const network = await this.readNetwork(now)

    // 4. OS version (cached after first read)
    const osVersion = await this.readOsVersion()

    // 5. History
    const point: SystemMetricPoint = {
      timestamp: now,
      cpuPct: cpu.usagePct,
      memPct: memory.usedPct,
      rxBytesPerSec: network.rxBytesPerSec,
      txBytesPerSec: network.txBytesPerSec,
    }
    this.history.push(point)
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(this.history.length - this.historySize)
    }

    const snapshot: SystemSnapshot = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      ...(osVersion ? { osVersion } : {}),
      uptimeSec: Math.floor(os.uptime()),
      sampledAt: now,
      cpu,
      memory,
      network,
      history: [...this.history],
    }

    this.latestSnapshot = snapshot
    return snapshot
  }

  private async readOsVersion(): Promise<string | undefined> {
    if (this.cachedOsVersion) return this.cachedOsVersion
    const platform = os.platform()
    if (platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], { timeout: 2000 })
        const ver = stdout.trim()
        if (ver) {
          this.cachedOsVersion = `macOS ${ver}`
          return this.cachedOsVersion
        }
      } catch {
        // ignore
      }
    } else if (platform === 'linux') {
      try {
        const content = await readFile('/etc/os-release', 'utf8')
        const pretty = parseLinuxOsRelease(content)
        if (pretty) {
          this.cachedOsVersion = pretty
          return this.cachedOsVersion
        }
      } catch {
        // ignore
      }
    } else if (platform === 'win32') {
      try {
        const ver = typeof os.version === 'function' ? os.version().trim() : ''
        this.cachedOsVersion = ver ? `${ver} (${os.release()})` : `Windows ${os.release()}`
        return this.cachedOsVersion
      } catch {
        // ignore
      }
    }
    return undefined
  }

  private async readMemory(): Promise<MemorySnapshot> {
    const totalBytes = os.totalmem()
    const platform = os.platform()
    if (platform === 'darwin') {
      try {
        const [{ stdout: vmOut }, swapRes] = await Promise.all([
          execFileAsync('vm_stat', [], { timeout: 2500 }),
          execFileAsync('sysctl', ['-n', 'vm.swapusage'], { timeout: 2500 }).catch(() => ({ stdout: '' })),
        ])
        const parsed = parseDarwinVmStat(vmOut, totalBytes)
        if (parsed) {
          const swap = parseDarwinSwapUsage(swapRes.stdout)
          return swap ? { ...parsed, ...swap } : parsed
        }
      } catch {
        // fallback below
      }
    } else if (platform === 'linux') {
      try {
        const content = await readFile('/proc/meminfo', 'utf8')
        const parsed = parseLinuxMemInfo(content)
        if (parsed) return parsed
      } catch {
        // fallback below
      }
    }

    const freeBytes = os.freemem()
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
      source: 'node-os',
    }
  }

  private async readNetwork(nowMs: number): Promise<NetworkSnapshot> {
    let counters: NetCounterSample[] = []
    const platform = os.platform()
    if (platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('netstat', ['-ibn'], { timeout: 3000 })
        counters = parseNetstatIbn(stdout)
      } catch {
        counters = []
      }
    } else if (platform === 'linux') {
      try {
        const content = await readFile('/proc/net/dev', 'utf8')
        counters = parseProcNetDev(content)
      } catch {
        counters = []
      }
    } else if (platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress',
          ],
          { timeout: 3500 },
        )
        counters = parseWindowsNetAdapterStats(stdout)
      } catch {
        counters = []
      }
      if (counters.length === 0) {
        try {
          const { stdout } = await execFileAsync('netstat', ['-e'], { timeout: 2500 })
          counters = parseWindowsNetstatE(stdout)
        } catch {
          counters = []
        }
      }
    }

    const osIfaces = os.networkInterfaces()
    const counterMap = new Map<string, NetCounterSample>()
    for (const c of counters) counterMap.set(c.name, c)

    const allNames = new Set<string>([
      ...Object.keys(osIfaces),
      ...counterMap.keys(),
    ])

    const elapsedSec = this.prevNetTimeMs > 0 ? Math.max(0.1, (nowMs - this.prevNetTimeMs) / 1000) : 0
    const interfaces: NetworkInterfaceStats[] = []

    let aggRxPerSec = 0
    let aggTxPerSec = 0
    let aggTotalRx = 0
    let aggTotalTx = 0

    for (const name of allNames) {
      const addrList = osIfaces[name] ?? []
      const counter = counterMap.get(name)
      const addresses = addrList.map(a => a.address)
      const mac = addrList.find(a => a.mac && a.mac !== '00:00:00:00:00:00')?.mac
      const internal = addrList.some(a => a.internal) || name === 'lo0' || name === 'lo'

      const rxBytes = counter?.rxBytes ?? 0
      const txBytes = counter?.txBytes ?? 0
      const prev = this.prevNetCounters.get(name)

      let rxBytesPerSec = 0
      let txBytesPerSec = 0
      if (elapsedSec > 0 && prev && counter) {
        rxBytesPerSec = Math.max(0, Math.round((counter.rxBytes - prev.rxBytes) / elapsedSec))
        txBytesPerSec = Math.max(0, Math.round((counter.txBytes - prev.txBytes) / elapsedSec))
      }

      // Skip totally inert virtual interfaces with no IP and zero traffic
      if (addresses.length === 0 && rxBytes === 0 && txBytes === 0) continue

      interfaces.push({
        name,
        addresses,
        ...(mac ? { mac } : {}),
        internal,
        rxBytes,
        txBytes,
        rxBytesPerSec,
        txBytesPerSec,
        rxErrors: counter?.rxErrors ?? 0,
        txErrors: counter?.txErrors ?? 0,
      })

      if (!internal) {
        aggRxPerSec += rxBytesPerSec
        aggTxPerSec += txBytesPerSec
        aggTotalRx += rxBytes
        aggTotalTx += txBytes
      }
    }

    // Update previous counter snapshot
    const nextPrev = new Map<string, NetCounterSample>()
    for (const c of counters) nextPrev.set(c.name, c)
    this.prevNetCounters = nextPrev
    this.prevNetTimeMs = nowMs

    // Sort active non-internal interfaces with traffic/IPs first
    interfaces.sort((a, b) => {
      if (a.internal !== b.internal) return a.internal ? 1 : -1
      const rateDiff = (b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec)
      if (rateDiff !== 0) return rateDiff
      return (b.rxBytes + b.txBytes) - (a.rxBytes + a.txBytes)
    })

    return {
      rxBytesPerSec: aggRxPerSec,
      txBytesPerSec: aggTxPerSec,
      totalRxBytes: aggTotalRx,
      totalTxBytes: aggTotalTx,
      interfaces,
    }
  }
}
