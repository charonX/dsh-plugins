/**
 * Persistence store for Wi-Fi watchdog runtime settings and event log.
 *
 * @module @charonx/dsh-system-dashboard/wifi/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WifiEventRecord, WifiSettings } from '../shared/types.ts'

export interface PersistedWifiState {
  settings?: Partial<WifiSettings>
  events?: WifiEventRecord[]
  recoveryCount?: number
  lastRecoveryAt?: number | null
}

const MAX_EVENTS = 100

export class WifiStateStore {
  constructor(private readonly filePath: string) {}

  read(): PersistedWifiState {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedWifiState
      if (!parsed || typeof parsed !== 'object') return {}
      const events = Array.isArray(parsed.events)
        ? parsed.events.slice(-MAX_EVENTS)
        : []
      return {
        settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : undefined,
        events,
        recoveryCount: typeof parsed.recoveryCount === 'number' ? parsed.recoveryCount : 0,
        lastRecoveryAt: typeof parsed.lastRecoveryAt === 'number' ? parsed.lastRecoveryAt : null,
      }
    } catch {
      return {}
    }
  }

  write(state: PersistedWifiState): void {
    try {
      const dir = dirname(this.filePath)
      mkdirSync(dir, { recursive: true })
      const payload: PersistedWifiState = {
        ...state,
        events: (state.events ?? []).slice(-MAX_EVENTS),
      }
      const tmp = join(dir, `.wifi-state.${process.pid}.${Date.now()}.tmp`)
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.filePath)
    } catch {
      // Ignore transient persistence errors
    }
  }
}
