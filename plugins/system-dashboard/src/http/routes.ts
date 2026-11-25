/**
 * HTTP routes for the System Dashboard plugin.
 *
 * @module @charonx/dsh-system-dashboard/http/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { collectDshSnapshot } from '../collectors/dsh.js'
import type { SystemCollector } from '../collectors/system.js'
import type { DashboardSnapshot, WifiSettingsPatch } from '../shared/types.ts'
import type { WifiMonitor } from '../wifi/monitor.js'

export interface RoutesDeps {
  readonly prefix: string
  readonly ctx: Context
  readonly systemCollector: SystemCollector
  readonly wifiMonitor: WifiMonitor
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total > 256 * 1024) {
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return resolve({})
        }
        resolve(parsed as Record<string, unknown>)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

export function createRequestHandler(deps: RoutesDeps) {
  const prefix = deps.prefix.replace(/\/+$/, '')

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const subPath = pathname.startsWith(prefix) ? (pathname.slice(prefix.length) || '/') : pathname

    try {
      if (method === 'GET' && (subPath === '/snapshot' || subPath === '/')) {
        const [system, dsh] = await Promise.all([
          deps.systemCollector.getSnapshot(),
          collectDshSnapshot(deps.ctx),
        ])
        const snapshot: DashboardSnapshot = {
          generatedAt: Date.now(),
          system,
          dsh,
          wifi: deps.wifiMonitor.getView(),
        }
        sendJson(res, 200, snapshot)
        return
      }

      if (method === 'POST' && subPath === '/wifi/refresh') {
        const view = await deps.wifiMonitor.refresh()
        sendJson(res, 200, view)
        return
      }

      if ((method === 'PUT' || method === 'POST') && subPath === '/wifi/settings') {
        const body = await readJsonBody(req)
        const patch: WifiSettingsPatch = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.autoRecover === 'boolean') patch.autoRecover = body.autoRecover
        if (typeof body.recoverIfPowerOff === 'boolean') patch.recoverIfPowerOff = body.recoverIfPowerOff
        if (typeof body.interfaceOverride === 'string') patch.interfaceOverride = body.interfaceOverride
        if (typeof body.targetSsid === 'string') patch.targetSsid = body.targetSsid
        if (typeof body.checkIntervalMs === 'number') patch.checkIntervalMs = body.checkIntervalMs
        if (typeof body.failureThreshold === 'number') patch.failureThreshold = body.failureThreshold
        if (typeof body.powerCycleDelayMs === 'number') patch.powerCycleDelayMs = body.powerCycleDelayMs
        if (typeof body.reconnectWaitMs === 'number') patch.reconnectWaitMs = body.reconnectWaitMs
        if (typeof body.cooldownMs === 'number') patch.cooldownMs = body.cooldownMs
        if (typeof body.pingCheckEnabled === 'boolean') patch.pingCheckEnabled = body.pingCheckEnabled
        if (typeof body.pingHost === 'string') patch.pingHost = body.pingHost

        const view = await deps.wifiMonitor.updateSettings(patch)
        sendJson(res, 200, view)
        return
      }

      if (method === 'POST' && subPath === '/wifi/recover') {
        const body = await readJsonBody(req)
        const ssid = typeof body.ssid === 'string' && body.ssid.trim() ? body.ssid : undefined
        const view = await deps.wifiMonitor.triggerRecovery(ssid)
        sendJson(res, 200, view)
        return
      }

      if (method === 'POST' && subPath === '/wifi/connect') {
        const body = await readJsonBody(req)
        const ssid = typeof body.ssid === 'string' ? body.ssid : ''
        if (!ssid.trim()) {
          sendJson(res, 400, { error: 'Missing ssid' })
          return
        }
        const view = await deps.wifiMonitor.connectToSsid(ssid)
        sendJson(res, 200, view)
        return
      }

      if (method === 'POST' && subPath === '/wifi/power') {
        const body = await readJsonBody(req)
        if (typeof body.on !== 'boolean') {
          sendJson(res, 400, { error: 'Missing boolean "on" field' })
          return
        }
        const view = await deps.wifiMonitor.setWifiPower(body.on)
        sendJson(res, 200, view)
        return
      }

      if (method === 'POST' && subPath === '/wifi/clear-events') {
        const view = deps.wifiMonitor.clearEvents()
        sendJson(res, 200, view)
        return
      }

      sendJson(res, 404, { error: `Unknown endpoint: ${method} ${subPath}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
  }
}
