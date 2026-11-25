import { describe, expect, it } from 'vitest'
import {
  computeCpuDelta,
  parseDarwinSwapUsage,
  parseDarwinVmStat,
  parseLinuxMemInfo,
  parseLinuxOsRelease,
  parseNetstatIbn,
  parseProcNetDev,
  parseWindowsNetAdapterStats,
  parseWindowsNetstatE,
  SystemCollector,
} from '../src/collectors/system.ts'

describe('system collector parsers', () => {
  it('computes CPU overall and per-core delta accurately', () => {
    const prev = [
      { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 },
      { user: 200, nice: 0, sys: 100, idle: 700, irq: 0 },
    ]
    const curr = [
      { user: 200, nice: 0, sys: 100, idle: 1200, irq: 0 }, // +100 user, +50 sys, +350 idle -> 500 total -> 30% usage
      { user: 400, nice: 0, sys: 200, idle: 1400, irq: 0 }, // +200 user, +100 sys, +700 idle -> 1000 total -> 30% usage
    ]
    const delta = computeCpuDelta(prev, curr)
    expect(delta.usagePct).toBe(30)
    expect(delta.userPct).toBe(20)
    expect(delta.sysPct).toBe(10)
    expect(delta.idlePct).toBe(70)
    expect(delta.perCore).toEqual([
      { core: 0, usagePct: 30 },
      { core: 1, usagePct: 30 },
    ])
  })

  it('parses macOS vm_stat and swapusage', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   100000.',
      'Pages active:                                 500000.',
      'Pages inactive:                               400000.',
      'Pages speculative:                             10000.',
      'Pages wired down:                             200000.',
      'Pages occupied by compressor:                 100000.',
      'File-backed pages:                            250000.',
    ].join('\n')

    const total = 24 * 1024 * 1024 * 1024
    const mem = parseDarwinVmStat(vmStat, total)
    expect(mem).toBeDefined()
    expect(mem!.source).toBe('darwin-vm-stat')
    expect(mem!.activeBytes).toBe(500000 * 16384)
    expect(mem!.wiredBytes).toBe(200000 * 16384)
    expect(mem!.compressedBytes).toBe(100000 * 16384)
    expect(mem!.usedBytes).toBe(800000 * 16384)

    const swap = parseDarwinSwapUsage('total = 7168.00M  used = 2048.50M  free = 5119.50M  (encrypted)')
    expect(swap).toEqual({
      swapTotalBytes: Math.round(7168 * 1024 * 1024),
      swapUsedBytes: Math.round(2048.5 * 1024 * 1024),
    })
  })

  it('parses macOS netstat -ibn Link rows with and without MAC column', () => {
    const netstat = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'lo0        16384 <Link#1>                      120021553     0 271802117798 120021553     0 271802117798     0',
      'lo0        16384 127           127.0.0.1       120021553     - 271802117798 120021553     - 271802117798     -',
      'en0*       1500  <Link#17>   d0:11:e5:bb:d1:1b        0     0          0        0     0          0     0',
      'en1        1500  <Link#14>   5e:b1:d7:9e:90:a3 456152699     2 274738421770 719011633     1 495588669837     0',
      'utun0      1380  <Link#19>                            0     0          0   310549     0  181237815     0',
    ].join('\n')

    const parsed = parseNetstatIbn(netstat)
    const byName = new Map(parsed.map(r => [r.name, r]))
    expect(byName.get('lo0')).toEqual({
      name: 'lo0',
      rxBytes: 271802117798,
      txBytes: 271802117798,
      rxErrors: 0,
      txErrors: 0,
    })
    expect(byName.get('en1')).toEqual({
      name: 'en1',
      rxBytes: 274738421770,
      txBytes: 495588669837,
      rxErrors: 2,
      txErrors: 1,
    })
    expect(byName.get('en0')?.rxBytes).toBe(0)
    expect(byName.get('utun0')?.txBytes).toBe(181237815)
  })

  it('parses Linux /proc/net/dev', () => {
    const proc = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '  eth0: 1234567 100 3 0 0 0 0 0 7654321 200 4 0 0 0 0 0',
    ].join('\n')
    expect(parseProcNetDev(proc)).toEqual([
      { name: 'eth0', rxBytes: 1234567, txBytes: 7654321, rxErrors: 3, txErrors: 4 },
    ])
  })

  it('parses Linux /proc/meminfo and /etc/os-release', () => {
    const meminfo = [
      'MemTotal:       16384000 kB',
      'MemFree:         2000000 kB',
      'MemAvailable:    8192000 kB',
      'Buffers:          500000 kB',
      'Cached:          4500000 kB',
      'Active:          6000000 kB',
      'SReclaimable:     500000 kB',
      'SwapTotal:       4096000 kB',
      'SwapFree:        3096000 kB',
    ].join('\n')

    const parsed = parseLinuxMemInfo(meminfo)
    expect(parsed).toBeDefined()
    expect(parsed!.source).toBe('linux-proc-meminfo')
    expect(parsed!.totalBytes).toBe(16384000 * 1024)
    expect(parsed!.usedBytes).toBe(8192000 * 1024)
    expect(parsed!.usedPct).toBe(50)
    expect(parsed!.swapUsedBytes).toBe(1000000 * 1024)

    expect(parseLinuxOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe('Ubuntu 24.04.1 LTS')
  })

  it('parses Windows Get-NetAdapterStatistics JSON and netstat -e fallback', () => {
    const json = JSON.stringify([
      { Name: 'Wi-Fi', ReceivedBytes: 1024000, SentBytes: 512000 },
      { Name: 'Ethernet', ReceivedBytes: 0, SentBytes: 0 },
    ])
    expect(parseWindowsNetAdapterStats(json)).toEqual([
      { name: 'Wi-Fi', rxBytes: 1024000, txBytes: 512000, rxErrors: 0, txErrors: 0 },
      { name: 'Ethernet', rxBytes: 0, txBytes: 0, rxErrors: 0, txErrors: 0 },
    ])

    const single = JSON.stringify({ Name: 'WLAN', ReceivedBytes: 2048, SentBytes: 1024 })
    expect(parseWindowsNetAdapterStats(single)).toEqual([
      { name: 'WLAN', rxBytes: 2048, txBytes: 1024, rxErrors: 0, txErrors: 0 },
    ])

    const netstatZh = [
      '接口统计',
      '',
      '                           接收的            发送的',
      '',
      '字节                    123456789          98765432',
    ].join('\n')
    expect(parseWindowsNetstatE(netstatZh)).toEqual([
      { name: 'aggregate', rxBytes: 123456789, txBytes: 98765432, rxErrors: 0, txErrors: 0 },
    ])
  })

  it('samples live system snapshot and bounds history length', async () => {
    const collector = new SystemCollector({ historySize: 2 })
    const s1 = await collector.sample()
    const s2 = await collector.sample()
    const s3 = await collector.sample()
    expect(s1.cpu.cores).toBeGreaterThan(0)
    expect(s2.memory.totalBytes).toBeGreaterThan(0)
    expect(s3.history.length).toBe(2)
  })
})
