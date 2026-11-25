import { describe, expect, it } from 'vitest'
import { createWifiDriver } from '../src/wifi/factory.ts'
import {
  parseIwLink,
  parseLinuxPingLatency,
  parseNmcliActiveWifiList,
  parseNmcliDevShow,
  parseNmcliRadioWifi,
  parseNmcliSavedWifi,
  parseNmcliWifiDevice,
  splitNmcliTerseLine,
} from '../src/wifi/linux.ts'
import {
  buildWinRtWifiRadioScript,
  encodePowerShellCommand,
  parseNetshWlanInterfaces,
  parseNetshWlanInterfacesList,
  parseNetshWlanProfiles,
  parseWindowsAdapterStatus,
  parseWindowsIpConfig,
  parseWindowsPingLatency,
  parseWindowsWifiAdaptersList,
  selectBestNetshInterface,
} from '../src/wifi/windows.ts'

describe('Linux Wi-Fi parsers (nmcli / iw)', () => {
  it('splits nmcli terse lines preserving escaped colons in BSSID/SSID', () => {
    expect(splitNmcliTerseLine('yes:Home\\:WiFi:AA\\:BB\\:CC\\:DD\\:EE\\:FF:36:360 Mbit/s:82:WPA2')).toEqual([
      'yes',
      'Home:WiFi',
      'AA:BB:CC:DD:EE:FF',
      '36',
      '360 Mbit/s',
      '82',
      'WPA2',
    ])
  })

  it('detects Wi-Fi interface and radio state', () => {
    expect(parseNmcliWifiDevice('eth0:ethernet\nwlp2s0:wifi\nlo:loopback\n')).toBe('wlp2s0')
    expect(parseNmcliRadioWifi('enabled\n')).toBe('on')
    expect(parseNmcliRadioWifi('disabled\n')).toBe('off')
  })

  it('parses active Wi-Fi row, dev show, and saved connections sorted by priority', () => {
    const wifiList = [
      'no:NeighborNet:11\\:22\\:33\\:44\\:55\\:66:6:130 Mbit/s:45:WPA2',
      'yes:Office_5G:AA\\:BB\\:CC\\:DD\\:EE\\:FF:149:866 Mbit/s:88:WPA2 WPA3',
    ].join('\n')

    expect(parseNmcliActiveWifiList(wifiList)).toEqual({
      ssid: 'Office_5G',
      bssid: 'AA:BB:CC:DD:EE:FF',
      channel: '149',
      txRateMbps: 866,
      signalPct: 88,
      security: 'WPA2 WPA3',
    })

    const devShow = [
      'GENERAL.STATE:100 (connected)',
      'IP4.ADDRESS[1]:192.168.10.42/24',
      'IP4.GATEWAY:192.168.10.1',
    ].join('\n')
    expect(parseNmcliDevShow(devShow)).toEqual({
      connected: true,
      ipv4: '192.168.10.42',
      routerIp: '192.168.10.1',
    })

    const saved = [
      'Wired connection 1:802-3-ethernet:0',
      'GuestNet:802-11-wireless:1',
      'Office_5G:802-11-wireless:10',
      'Home_WiFi:802-11-wireless:5',
    ].join('\n')
    expect(parseNmcliSavedWifi(saved)).toEqual(['Office_5G', 'Home_WiFi', 'GuestNet'])
  })

  it('parses iw link and ping output', () => {
    const iw = [
      'Connected to aa:bb:cc:dd:ee:ff (on wlp2s0)',
      '\tSSID: Office_5G',
      '\tsignal: -54 dBm',
      '\ttx bitrate: 866.7 MBit/s VHT-MCS 9',
    ].join('\n')
    expect(parseIwLink(iw)).toEqual({
      ssid: 'Office_5G',
      rssiDbm: -54,
      txRateMbps: 866.7,
    })
    expect(parseIwLink('Not connected.')).toEqual({
      ssid: null,
      rssiDbm: null,
      txRateMbps: null,
    })
    expect(parseLinuxPingLatency('64 bytes from 192.168.10.1: icmp_seq=1 ttl=64 time=1.42 ms')).toBe(1.4)
  })
})

describe('Windows Wi-Fi parsers (netsh / PowerShell)', () => {
  it('parses English netsh wlan show interfaces', () => {
    const out = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX211 160MHz
    State                  : connected
    SSID                   : Lab_5G
    BSSID                  : 10:20:30:40:50:60
    Radio type             : 802.11ax
    Authentication         : WPA2-Personal
    Channel                : 149
    Receive rate (Mbps)    : 1201
    Transmit rate (Mbps)   : 1201
    Signal                 : 92%
`
    expect(parseNetshWlanInterfaces(out)).toEqual({
      interfaceName: 'Wi-Fi',
      description: 'Intel(R) Wi-Fi 6E AX211 160MHz',
      connected: true,
      radioOff: false,
      ssid: 'Lab_5G',
      bssid: '10:20:30:40:50:60',
      phyMode: '802.11ax',
      channel: '149',
      signalPct: 92,
      txRateMbps: 1201,
      security: 'WPA2-Personal',
    })
  })

  it('parses Simplified Chinese netsh wlan show interfaces and profiles', () => {
    const ifaceOut = `
系统上有 1 个接口:

    名称                   : WLAN
    状态                   : 已连接
    SSID                   : 办公室_5G
    AP BSSID               : aa:bb:cc:11:22:33
    无线电类型             : 802.11ax
    身份验证               : WPA3-个人
    频道                   : 36
    传输速率 (Mbps)        : 864
    信号                   : 86%
`
    expect(parseNetshWlanInterfaces(ifaceOut)).toEqual({
      interfaceName: 'WLAN',
      description: null,
      connected: true,
      radioOff: false,
      ssid: '办公室_5G',
      bssid: 'aa:bb:cc:11:22:33',
      phyMode: '802.11ax',
      channel: '36',
      signalPct: 86,
      txRateMbps: 864,
      security: 'WPA3-个人',
    })

    const profilesOut = `
接口 WLAN 上的配置文件:

组策略配置文件(只读)
---------------------------------
    <无>

用户配置文件
-------------
    所有用户配置文件 : 办公室_5G
    所有用户配置文件 : HomeNet
`
    expect(parseNetshWlanProfiles(profilesOut)).toEqual(['办公室_5G', 'HomeNet'])
  })

  it('parses multi-NIC netsh wlan show interfaces without cross-block pollution and handles multiline radio status', () => {
    const multiOut = `
系统上有 2 个接口:

    名称                   : WLAN
    说明                   : Intel(R) Wi-Fi 6 AX201
    状态                   : 已断开连接
    无线电状态             : 硬件 开
                             软件 关

    名称                   : WLAN 2
    说明                   : Realtek 8812BU Wireless LAN 802.11ac USB NIC
    状态                   : 已连接
    SSID                   : Geekplus-Office
    身份验证               : WPA2-Enterprise
    频道                   : 44
    无线电类型             : 802.11ac
    传输速率 (Mbps)        : 400
    信号                   : 100%
`
    const blocks = parseNetshWlanInterfacesList(multiOut)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.interfaceName).toBe('WLAN')
    expect(blocks[0]?.connected).toBe(false)
    expect(blocks[0]?.radioOff).toBe(true)

    expect(blocks[1]?.interfaceName).toBe('WLAN 2')
    expect(blocks[1]?.connected).toBe(true)
    expect(blocks[1]?.radioOff).toBe(false)
    expect(blocks[1]?.ssid).toBe('Geekplus-Office')

    const best = selectBestNetshInterface(blocks)
    expect(best?.interfaceName).toBe('WLAN 2')
    expect(best?.connected).toBe(true)
  })

  it('parses PowerShell adapter numeric enums, multi-adapter sorting, flat IP config, and Windows ping', () => {
    expect(parseWindowsAdapterStatus('{"Status":"Up","AdminStatus":1,"MediaConnectionState":1}')).toEqual({
      power: 'on',
      linkActive: true,
    })
    expect(parseWindowsAdapterStatus('{"Status":"Disabled","AdminStatus":2,"MediaConnectionState":2}')).toEqual({
      power: 'off',
      linkActive: false,
    })

    const adapters = parseWindowsWifiAdaptersList(JSON.stringify([
      { Name: '本地连接* 10', InterfaceDescription: 'Microsoft Wi-Fi Direct Virtual Adapter', Status: 'Disconnected', AdminStatus: 'Up', MediaConnectionState: 'Disconnected' },
      { Name: 'WLAN', InterfaceDescription: 'Intel(R) Wi-Fi 6', Status: 'Disabled', AdminStatus: 2, MediaConnectionState: 2 },
      { Name: 'WLAN 2', InterfaceDescription: 'USB Wireless NIC', Status: 'Up', AdminStatus: 1, MediaConnectionState: 1 },
    ]))
    expect(adapters.map(a => a.name)).toEqual(['WLAN 2', 'WLAN', '本地连接* 10'])

    expect(parseWindowsIpConfig('{"ipv4":"10.16.2.45","routerIp":"10.16.2.1"}')).toEqual({
      ipv4: '10.16.2.45',
      routerIp: '10.16.2.1',
    })

    expect(parseWindowsPingLatency('来自 192.168.1.1 的回复: 字节=32 时间=3ms TTL=64')).toBe(3)
    expect(parseWindowsPingLatency('Reply from 192.168.1.1: bytes=32 time=2.5ms TTL=64')).toBe(2.5)
  })

  it('generates valid WinRT Radio PowerShell script and UTF-16LE Base64 payload without admin requirement', () => {
    const offScript = buildWinRtWifiRadioScript(false, "O'Reilly WLAN")
    expect(offScript).toContain("Windows.Devices.Radios.RadioState]::Off")
    expect(offScript).toContain("$targetIface = 'O''Reilly WLAN'")
    const encoded = encodePowerShellCommand(offScript)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(offScript)
  })
})

describe('createWifiDriver platform factory', () => {
  it('selects appropriate driver for darwin, linux, win32, and marks others unsupported', () => {
    expect(createWifiDriver('darwin').constructor.name).toBe('DarwinWifiDriver')
    expect(createWifiDriver('linux').constructor.name).toBe('LinuxWifiDriver')
    expect(createWifiDriver('win32').constructor.name).toBe('WindowsWifiDriver')
    expect(createWifiDriver('freebsd').isSupported).toBe(false)
  })
})
