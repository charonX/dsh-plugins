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
import type { IngressEvent, ModelCatalogView, ModelGroupView, ModelEntryView } from '../shared/types.js'
import { ScheduleInputError } from '../shared/schedule.js'

export type { ModelCatalogView, ModelGroupView, ModelEntryView } from '../shared/types.js'
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

/**
 * Read a nonnegative integer query parameter.
 * @param raw - Raw query value.
 * @returns The number, or undefined when absent, malformed, or negative.
 */
function readPositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

function getWorkspacesWithSessions(ctx: Context, fallbackPath: string): WorkspaceItemView[] {
  let list: unknown[] = []
  let archivedSet = new Set<string>()

  try {
    const registry = (ctx.get('workspaceRegistry') ?? (ctx as any).root?.get?.('workspaceRegistry') ?? (ctx as any).workspaceRegistry) as {
      list?: () => unknown[]
      archivedSessionIds?: readonly string[]
    } | undefined

    if (registry && typeof registry.list === 'function') {
      const rows = registry.list()
      if (Array.isArray(rows)) {
        list = rows
      }
    }

    if (registry?.archivedSessionIds && Array.isArray(registry.archivedSessionIds)) {
      archivedSet = new Set(registry.archivedSessionIds.map(String))
    }
  } catch (err) {
    ctx.logger?.warn?.(`[Autoloop] Error reading workspaceRegistry: ${String(err)}`)
  }

  const sessionsService = (ctx.get('sessions') ?? (ctx as any).root?.get?.('sessions')) as { get?: (id: any) => any } | undefined
  const sessionTitleService = (ctx.get('sessionTitle') ?? (ctx as any).root?.get?.('sessionTitle')) as { get?: (session: any) => { title?: string } | undefined } | undefined

  const items: WorkspaceItemView[] = []
  const seenPaths = new Set<string>()

  for (const rawWs of list) {
    if (!rawWs || typeof rawWs !== 'object') continue
    const ws = rawWs as { id?: unknown; path?: unknown; title?: unknown; sessionIds?: readonly unknown[] }
    if (typeof ws.path !== 'string' || ws.path.trim() === '') continue
    const wsPath = ws.path.trim()
    if (seenPaths.has(wsPath)) continue
    seenPaths.add(wsPath)

    const rawTitle = typeof ws.title === 'string' && ws.title.trim() ? ws.title.trim() : ''
    const title = rawTitle || (basename(wsPath) || wsPath)

    let rawSessionIds: string[] = []
    try {
      if (Array.isArray(ws.sessionIds)) {
        rawSessionIds = ws.sessionIds.map(String)
      }
    } catch {
      rawSessionIds = []
    }

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
      if (sessionList.length >= 20) break
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

export async function getModelCatalog(ctx: Context): Promise<ModelCatalogView> {
  // 1. Attempt query from sessionController.modelCatalog()
  try {
    const sessionController = (ctx.get('sessionController') ?? (ctx as any).root?.get?.('sessionController')) as {
      modelCatalog?: () => Promise<{
        default?: { provider?: string; model?: string; reasoningEffort?: string }
        groups?: Array<{
          id: string
          name: string
          models?: Array<{ id: string; name: string; badge?: string; description?: string }>
        }>
      }>
    } | undefined

    if (sessionController && typeof sessionController.modelCatalog === 'function') {
      const catalog = await sessionController.modelCatalog()
      if (catalog && Array.isArray(catalog.groups)) {
        return {
          defaultSelection: catalog.default ?? {},
          groups: catalog.groups.map(g => ({
            id: g.id,
            name: g.name || g.id,
            models: Array.isArray(g.models)
              ? g.models.map(m => ({
                  id: m.id,
                  name: m.name || m.id,
                  badge: m.badge,
                  description: m.description,
                }))
              : [],
          })),
        }
      }
    }
  } catch (err) {
    ctx.logger?.warn?.(`[Autoloop] Error reading sessionController.modelCatalog: ${String(err)}`)
  }

  // 2. Direct inspection from ctx.agentDefaultModel and ctx.llm
  const agentDefault = (ctx.get('agentDefaultModel') ?? (ctx as any).root?.get?.('agentDefaultModel')) as {
    currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string }
  } | undefined
  const defaultSelection = agentDefault?.currentSelection?.() ?? {}

  const llm = (ctx.get('llm') ?? (ctx as any).root?.get?.('llm')) as {
    listProviders?: () => Array<{ id: string; name: string }>
    listModels?: (providerId: string) => Promise<Array<{ id: string; name: string; description?: string; badge?: string }>>
  } | undefined

  const groups: ModelGroupView[] = []
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const providers = llm.listProviders()
      for (const p of providers) {
        let models: Array<{ id: string; name: string; description?: string; badge?: string }> = []
        if (typeof llm.listModels === 'function') {
          try {
            models = (await llm.listModels(p.id)) || []
          } catch {
            models = []
          }
        }
        groups.push({
          id: p.id,
          name: p.name || p.id,
          models: models.map(m => ({
            id: m.id,
            name: m.name || m.id,
            description: m.description,
            badge: m.badge,
          })),
        })
      }
    } catch (err) {
      ctx.logger?.warn?.(`[Autoloop] Error reading llm.listProviders: ${String(err)}`)
    }
  }

  // 3. Sensible fallback if no models are discovered in current runtime
  if (groups.length === 0) {
    groups.push({
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek-V3', badge: 'Fast' },
        { id: 'deepseek-reasoner', name: 'DeepSeek-R1', badge: 'Thinking' },
      ],
    })
  }

  return { defaultSelection, groups }
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

      // GET /api/autoloop/models
      if (req.method === 'GET' && subpath === '/models') {
        const catalog = await getModelCatalog(ctx)
        sendJson(res, 200, catalog)
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

      // POST /api/autoloop/tickets/schedule
      if (req.method === 'POST' && subpath === '/tickets/schedule') {
        const body = (await readJsonBody(req)) as { ticketId?: string; scheduleMode?: unknown; scheduledAt?: unknown }
        if (!body.ticketId) {
          sendJson(res, 400, { error: 'Field "ticketId" is required' })
          return
        }

        const ok = await kernel.rescheduleTicket(body.ticketId, body.scheduleMode, body.scheduledAt)
        if (!ok) {
          sendJson(res, 409, { error: 'Ticket is missing or is not queued' })
          return
        }
        sendJson(res, 200, { ok: true, ticketId: body.ticketId })
        return
      }

      // POST /api/autoloop/tickets/retry
      if (req.method === 'POST' && subpath === '/tickets/retry') {
        const body = (await readJsonBody(req)) as { ticketId?: string }
        if (!body.ticketId) {
          sendJson(res, 400, { error: 'Field "ticketId" is required' })
          return
        }

        const ok = await kernel.retryTicket(body.ticketId)
        if (!ok) {
          sendJson(res, 409, { error: 'Ticket is missing or is not in a retryable state' })
          return
        }
        sendJson(res, 200, { ok: true, ticketId: body.ticketId })
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

      // POST /api/autoloop/tickets/run-now
      if (req.method === 'POST' && subpath === '/tickets/run-now') {
        const body = (await readJsonBody(req)) as { ticketId?: string }
        if (!body.ticketId) {
          sendJson(res, 400, { error: 'Field "ticketId" is required' })
          return
        }

        const success = await kernel.runTicketNow(body.ticketId)
        sendJson(res, 200, { ok: success, ticketId: body.ticketId })
        return
      }

      sendJson(res, 404, { error: `Endpoint ${req.method ?? 'GET'} ${subpath} not found` })
    } catch (err: unknown) {
      if (err instanceof ScheduleInputError) {
        sendJson(res, 400, { error: err.message, code: err.code })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: msg })
    }
  }
}
