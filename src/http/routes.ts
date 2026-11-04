/**
 * HTTP routes for Autoloop microkernel.
 * Exposes REST endpoints for the Web Client Monitor (Kanban, creation, attention).
 *
 * @module @charonx/dsh-autoloop/http/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AutoloopKernel } from '../core/kernel.js'
import type { IngressEvent } from '../shared/types.js'

export const DEFAULT_ROUTE_PREFIX = '/api/autoloop'

export interface WorkspaceSessionView {
  id: string
  title: string
}

export interface WorkspaceItemView {
  id: string
  title: string
  path: string
  sessions: WorkspaceSessionView[]
}

export interface HttpDeps {
  prefix: string
  kernel: AutoloopKernel
  ctx: Context
  defaultWorkspacePath: string
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

function getWorkspacesWithSessions(ctx: Context, fallbackPath: string): WorkspaceItemView[] {
  const registry = ctx.get('workspaceRegistry') as {
    list?: () => Array<{ id?: unknown; path?: string; title?: string; sessionIds?: readonly string[] }>
    archivedSessionIds?: readonly string[]
  } | undefined

  const sessionsService = ctx.get('sessions') as { get?: (id: any) => any } | undefined
  const sessionTitleService = ctx.get('sessionTitle') as { get?: (session: any) => { title?: string } | undefined } | undefined

  const list = typeof registry?.list === 'function' ? registry.list() : []
  const archivedSet = new Set(registry?.archivedSessionIds?.map(String) ?? [])

  const items: WorkspaceItemView[] = []
  const seenPaths = new Set<string>()

  for (const ws of list) {
    if (!ws || typeof ws.path !== 'string' || ws.path.trim() === '') continue
    const wsPath = ws.path.trim()
    if (seenPaths.has(wsPath)) continue
    seenPaths.add(wsPath)

    const title = ws.title && ws.title.trim() ? ws.title.trim() : (basename(wsPath) || wsPath)
    const rawSessionIds = (ws.sessionIds ?? []).map(String)

    const sessionList: WorkspaceSessionView[] = []
    for (const sid of rawSessionIds) {
      if (archivedSet.has(sid)) continue
      let sessionTitle = sid
      if (sessionsService?.get && sessionTitleService?.get) {
        try {
          const sess = sessionsService.get(sid)
          if (sess) {
            const snapshot = sessionTitleService.get(sess)
            if (snapshot?.title) {
              sessionTitle = snapshot.title
            }
          }
        } catch {
          // Ignore fold failure, fallback to sid
        }
      }
      sessionList.push({ id: sid, title: sessionTitle })
      if (sessionList.length >= 15) break // keep up to 15 recent sessions
    }

    items.push({
      id: String(ws.id ?? wsPath),
      title,
      path: wsPath,
      sessions: sessionList,
    })
  }

  // Ensure there is always at least one default workspace if registry returned empty
  if (items.length === 0) {
    items.push({
      id: 'default',
      title: `默认工作区 (${basename(fallbackPath) || fallbackPath})`,
      path: fallbackPath,
      sessions: [],
    })
  }

  return items
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { prefix, kernel, ctx, defaultWorkspacePath } = deps

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
        const workspaces = getWorkspacesWithSessions(ctx, defaultWorkspacePath)
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
