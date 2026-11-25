# `@charonx/dsh-system-dashboard`

System & DeepSeek Harness runtime dashboard plugin with live CPU, Memory, and Network telemetry, DSH service health visibility, and cross-platform (macOS / Windows / Linux) Wi-Fi disconnect auto-recovery.

## Features

- **System Telemetry**:
  - Real-time CPU utilization (overall, user/sys/idle, per-core breakdown, load averages).
  - Memory utilization (macOS `vm_stat` + `vm.swapusage`, Linux `/proc/meminfo`, Windows `node:os`).
  - Live Network RX/TX throughput and per-interface traffic stats (macOS `netstat -ibn`, Linux `/proc/net/dev`, Windows `Get-NetAdapterStatistics` / `netstat -e`).
  - Rolling 60-sample dual-series SVG charts.
- **DSH Runtime Health**:
  - Host process PID, Node.js version, uptime, RSS & V8 heap memory, and DSH home path.
  - Default model route (`ctx.agentDefaultModel`), registered LLM providers (`ctx.llm`), live agents (`ctx.agents`), sessions (`ctx.sessions` + `ctx.sessionTitle` with one-click session navigation), workspaces (`ctx.workspaceRegistry`), MCP servers (`ctx.mcpManager`), skills (`ctx.skills`), schedules (`ctx.schedule`), and Cordis loader plugin summary.
- **Wi-Fi Status Monitor & Auto-Recovery (macOS / Windows / Linux)**:
  - **macOS (`darwin`)**: Dynamically discovers the Wi-Fi interface (`networksetup -listallhardwareports`), reads status via `networksetup` + `ipconfig getsummary` + `ifconfig` + `system_profiler`, cycles `networksetup -setairportpower off/on`, and rejoins saved networks (`networksetup -listpreferredwirelessnetworks` / `-setairportnetwork`).
  - **Windows (`win32`)**: Discovers wireless adapters via `netsh wlan show interfaces` + `Get-NetAdapter` (English & Chinese Windows supported), reads IP/gateway via `Get-NetIPConfiguration`, toggles Wi-Fi software radio via the WinRT `Windows.Devices.Radios.Radio` API (works without Administrator elevation, with `netsh` / `Disable-NetAdapter` admin fallback), and rejoins saved WLAN profiles (`netsh wlan show profiles` / `netsh wlan connect`).
  - **Linux (`linux`)**: Discovers wireless device via `nmcli` / `/sys/class/net/*/wireless`, reads status via `nmcli` + `iw dev <iface> link`, toggles radio via `nmcli radio wifi off/on` (with `rfkill` / `ip link` fallbacks), and rejoins saved NetworkManager profiles (`nmcli connection up` / `nmcli device wifi connect`).
  - When disconnected beyond the configured failure threshold, automatically cycles Wi-Fi off -> waits -> turns back on -> waits for auto-association -> joins saved preferred networks in order, with cooldown protection and persisted event logs.

## Configuration (`cordis.patch.yml`)

```yaml
- insert:
    - id: system-dashboard
      name: '@charonx/dsh-system-dashboard'
      config:
        enabled: true
        systemSampleIntervalMs: 2000
        wifiMonitorEnabled: true
        wifiAutoRecover: true
        wifiCheckIntervalMs: 5000
```

## Development & Verification

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
