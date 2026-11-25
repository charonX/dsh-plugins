/**
 * Typed HTTP client for System Dashboard endpoints.
 *
 * @module @charonx/dsh-system-dashboard/client/api
 */

import {
  DEFAULT_ROUTE_PREFIX,
  type DashboardSnapshot,
  type WifiSettingsPatch,
  type WifiStateView,
} from '../shared/types.ts'

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`Invalid JSON response (${res.status})`)
    }
  }
  if (!res.ok) {
    const errMsg = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `HTTP ${res.status}`
    throw new Error(errMsg)
  }
  return parsed as T
}

export function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  return requestJson<DashboardSnapshot>(`${DEFAULT_ROUTE_PREFIX}/snapshot`)
}

export function refreshWifiStatus(): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/refresh`, { method: 'POST' })
}

export function updateWifiSettings(patch: WifiSettingsPatch): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/settings`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function triggerWifiRecovery(ssid?: string): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/recover`, {
    method: 'POST',
    body: JSON.stringify(ssid ? { ssid } : {}),
  })
}

export function connectWifiSsid(ssid: string): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/connect`, {
    method: 'POST',
    body: JSON.stringify({ ssid }),
  })
}

export function setWifiPower(on: boolean): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/power`, {
    method: 'POST',
    body: JSON.stringify({ on }),
  })
}

export function clearWifiEvents(): Promise<WifiStateView> {
  return requestJson<WifiStateView>(`${DEFAULT_ROUTE_PREFIX}/wifi/clear-events`, {
    method: 'POST',
  })
}
