import { describe, expect, it } from 'vitest'
import {
  parseAirportNetwork,
  parseAirportPower,
  parseHardwarePortsForWifi,
  parseIfconfigWifi,
  parseIpconfigSummary,
  parsePingLatency,
  parsePreferredNetworks,
  parseSystemProfilerWifi,
} from '../src/wifi/darwin.ts'

describe('macOS Wi-Fi CLI parsers', () => {
  it('finds Wi-Fi hardware device dynamically (e.g. en1)', () => {
    const ports = [
      'Hardware Port: Ethernet',
      'Device: en0',
      'Ethernet Address: d0:11:e5:bb:d1:1b',
      '',
      'Hardware Port: Wi-Fi',
      'Device: en1',
      'Ethernet Address: d0:11:e5:b8:46:bc',
    ].join('\n')

    expect(parseHardwarePortsForWifi(ports)).toBe('en1')
  })

  it('parses airport power state', () => {
    expect(parseAirportPower('Wi-Fi Power (en1): On')).toBe('on')
    expect(parseAirportPower('Wi-Fi Power (en1): Off')).toBe('off')
    expect(parseAirportPower('invalid')).toBe('unknown')
  })

  it('handles macOS privacy-redacted ipconfig getsummary while detecting active link', () => {
    const summary = `
<dictionary> {
  BSSID : <redacted>
  IPv4 : <array> {
    0 : <dictionary> {
      Addresses : <array> {
        0 : 192.168.8.137
      }
      Router : 192.168.8.1
    }
  }
  InterfaceType : WiFi
  LinkStatusActive : TRUE
  NetworkID : <redacted>
  SSID : <redacted>
  Security : WPA3_SAE
}
`
    expect(parseIpconfigSummary(summary)).toEqual({
      linkStatusActive: true,
      ssid: null,
      ssidRedacted: true,
      bssid: null,
      ipv4: '192.168.8.137',
      routerIp: '192.168.8.1',
      security: 'WPA3_SAE',
    })
  })

  it('parses ifconfig status and ipv4', () => {
    const active = `
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.8.137 netmask 0xffffff00 broadcast 192.168.8.255
\tstatus: active
`
    expect(parseIfconfigWifi(active)).toEqual({ active: true, ipv4: '192.168.8.137' })

    const inactive = `
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tstatus: inactive
`
    expect(parseIfconfigWifi(inactive)).toEqual({ active: false, ipv4: null })
  })

  it('parses preferred wireless networks preserving unicode and trailing spaces', () => {
    const out = [
      'Preferred networks on en1:',
      '\t早日暴富',
      '\tcharon',
      '\tcharon‘s ',
      '\tXiaomi_lucky_5G',
    ].join('\n')

    expect(parsePreferredNetworks(out)).toEqual([
      '早日暴富',
      'charon',
      'charon‘s ',
      'Xiaomi_lucky_5G',
    ])
  })

  it('parses legacy getairportnetwork output safely', () => {
    expect(parseAirportNetwork('Current Wi-Fi Network: Office_5G')).toBe('Office_5G')
    expect(parseAirportNetwork('You are not associated with an AirPort network.')).toBeNull()
  })

  it('parses system_profiler SPAirPortDataType radio info', () => {
    const sp = `
Wi-Fi:
      Interfaces:
        en1:
          Card Type: Wi-Fi
          Status: Connected
          Current Network Information:
            <redacted>:
              PHY Mode: 802.11ax
              Channel: 40 (5GHz, 80MHz)
              Security: WPA2/WPA3 Personal
              Signal / Noise: -61 dBm / -93 dBm
              Transmit Rate: 360
          Other Local Wi-Fi Networks:
            <redacted>:
              PHY Mode: 802.11a/n/ac/ax
              Channel: 48 (5GHz, 160MHz)
              Transmit Rate: 1200
`
    expect(parseSystemProfilerWifi(sp, 'en1')).toEqual({
      connected: true,
      phyMode: '802.11ax',
      channel: '40 (5GHz, 80MHz)',
      rssiDbm: -61,
      noiseDbm: -93,
      txRateMbps: 360,
      security: 'WPA2/WPA3 Personal',
    })
  })

  it('parses ping latency', () => {
    expect(parsePingLatency('64 bytes from 192.168.8.1: icmp_seq=0 ttl=64 time=2.345 ms')).toBe(2.3)
    expect(parsePingLatency('Request timeout for icmp_seq 0')).toBeNull()
  })
})
