/**
 * HTTP routes for Autoloop microkernel.
 * Exposes REST endpoints for the Web Client Monitor (Kanban, creation, attention).
 *
 * @module @charonx/dsh-autoloop/http/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AutoloopKernel } from '../core/kernel.js'
import type { IngressEvent } from '../shared/types.js'

export const DEFAULT_ROUTE_PREFIX = '/api/autoloop'

export interface HttpDeps {
  prefix: string
  kernel: AutoloopKernel
  ctx: Context
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalLength = 0
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      totalLength += chunk.length
      if (totalLength > 1024 * 1024) {
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { prefix, kernel, ctx } = deps

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (!pathname.startsWith(prefix)) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }

    const subpath = pathname.slice(prefix.length) || '/'

    try {
      // GET /api/autoloop/snapshot
      if (req.method === 'GET' && subpath === '/snapshot') {
        const snapshot = kernel.getStateSnapshot()
        sendJson(res, 200, snapshot)
        return
      }

      // GET /api/autoloop/workspaces
      if (req.method === 'GET' && subpath === '/workspaces') {
        const registry: unknown = ctx.get('workspaceRegistry')
        let workspaces: string[] = []
        if (typeof registry === 'object' && registry !== null && 'list' in registry) {
          const listFn = (registry as { list: () => Array<{ path: string }> }).list
          if (typeof listFn === 'function') {
            workspaces = listFn.call(registry).map(w => w.path)
          }
        }
        sendJson(res, 200, { workspaces })
        return
      }

      // POST /api/autoloop/events
      if (req.method === 'POST' && subpath === '/events') {
        const body = (await readJsonBody(req)) as Partial<IngressEvent>
        if (!body.summary || typeof body.summary !== 'string') {
          sendJson(res, 400, { error: 'Field "summary" is required' })
          return
        }

        const event: IngressEvent = {
          id: `evt-${Date.now()}`,
          source: body.source ?? 'manual-ui',
          threadId: body.threadId ?? `ui-manual:${Date.now()}`,
          type: body.type ?? 'task.create',
          summary: body.summary,
          payload: body.payload ?? {},
          receivedAt: Date.now(),
        }

        const result = await kernel.ingestEvent(event)
        sendJson(res, 201, result)
        return
      }

      // POST /api/autoloop/attention/resolve
      if (req.method === 'POST' && subpath === '/attention/resolve') {
        const body = (await readJsonBody(req)) as { ticketId?: string; answer?: string }
        if (!body.ticketId || !body.answer) {
          sendJson(res, 400, { error: 'Fields "ticketId" and "answer" are required' })
          return
        }

        await kernel.resolveAttention(body.ticketId, body.answer)
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: `Endpoint ${req.method ?? 'GET'} ${subpath} not found` })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: msg })
    }
  }
}
