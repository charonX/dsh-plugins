/**
 * DSH runtime telemetry collector.
 * Dynamically inspects available Cordis services on `ctx` with graceful fallback
 * so minimal or headless profiles never fail.
 *
 * @module @charonx/dsh-system-dashboard/collectors/dsh
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  DshAgentView,
  DshDefaultModelView,
  DshMcpServerView,
  DshPluginSummaryView,
  DshProviderView,
  DshSessionView,
  DshSnapshot,
  DshWorkspaceView,
} from '../shared/types.ts'

function readOptionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    const direct = ctx.get(name as never) as T | undefined
    if (direct !== undefined) return direct
  } catch {
    // ignore
  }
  try {
    const root = (ctx as unknown as { root?: { get?: (key: string) => unknown } }).root
    if (root && typeof root.get === 'function') {
      return root.get(name) as T | undefined
    }
  } catch {
    // ignore
  }
  return undefined
}

export async function collectDshSnapshot(ctx: Context): Promise<DshSnapshot> {
  const mem = process.memoryUsage()
  const processView = {
    pid: process.pid,
    nodeVersion: process.version,
    uptimeSec: Math.floor(process.uptime()),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    dshHome: resolveDshHome(),
  }

  // 1. Default Model
  let defaultModel: DshDefaultModelView | undefined
  try {
    const svc = readOptionalService<{
      currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: unknown }
    }>(ctx, 'agentDefaultModel')
    const sel = svc?.currentSelection?.()
    if (sel?.provider && sel?.model) {
      defaultModel = {
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort !== undefined ? { reasoningEffort: String(sel.reasoningEffort) } : {}),
      }
    }
  } catch {
    // ignore
  }

  // 2. LLM Providers
  const providers: DshProviderView[] = []
  try {
    const llm = readOptionalService<{
      listProviders?: () => Array<{ id?: string; name?: string; models?: readonly unknown[] }>
    }>(ctx, 'llm')
    const rawProviders = llm?.listProviders?.() ?? []
    for (const p of rawProviders) {
      if (!p || typeof p.id !== 'string') continue
      providers.push({
        id: p.id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name : p.id,
        ...(Array.isArray(p.models) ? { modelCount: p.models.length } : {}),
      })
    }
  } catch {
    // ignore
  }

  // 3. Live Agents
  const agentItems: DshAgentView[] = []
  const liveAgentIds = new Set<string>()
  let runningAgents = 0
  let idleAgents = 0
  try {
    const agentsSvc = readOptionalService<{
      list?: () => Array<{
        id: string
        status?: string
        session?: { seq?: number; header?: { cwd?: string; createdAt?: number } }
      }>
    }>(ctx, 'agents')
    const rawAgents = agentsSvc?.list?.() ?? []
    for (const agent of rawAgents) {
      const id = String(agent.id)
      const status = String(agent.status ?? 'idle')
      liveAgentIds.add(id)
      if (status === 'running') runningAgents += 1
      else idleAgents += 1
      agentItems.push({
        id,
        status,
        ...(agent.session?.header?.cwd ? { cwd: agent.session.header.cwd } : {}),
        eventCount: Number(agent.session?.seq ?? 0),
        ...(typeof agent.session?.header?.createdAt === 'number'
          ? { createdAt: agent.session.header.createdAt }
          : {}),
      })
    }
  } catch {
    // ignore
  }

  // 4. Live Sessions
  const sessionItems: DshSessionView[] = []
  try {
    const sessionsSvc = readOptionalService<{
      list?: () => Array<{ id: string; seq?: number; header?: { cwd?: string; createdAt?: number } }>
    }>(ctx, 'sessions')
    const titleSvc = readOptionalService<{
      get?: (session: unknown) => { title?: string } | undefined
    }>(ctx, 'sessionTitle')
    const rawSessions = sessionsSvc?.list?.() ?? []
    for (const sess of rawSessions) {
      const id = String(sess.id)
      let title = id
      try {
        const snap = titleSvc?.get?.(sess)
        if (snap?.title && snap.title.trim()) {
          title = snap.title.trim()
        }
      } catch {
        // ignore fold failure
      }
      sessionItems.push({
        id,
        title,
        ...(sess.header?.cwd ? { cwd: sess.header.cwd } : {}),
        eventCount: Number(sess.seq ?? 0),
        ...(typeof sess.header?.createdAt === 'number' ? { createdAt: sess.header.createdAt } : {}),
        isAgentLive: liveAgentIds.has(id),
      })
    }
    sessionItems.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  } catch {
    // ignore
  }

  // 5. Workspaces
  const workspaceItems: DshWorkspaceView[] = []
  try {
    const registry = readOptionalService<{
      list?: () => Array<{ id?: unknown; title?: unknown; path?: unknown; sessionIds?: readonly unknown[] }>
      archivedSessionIds?: readonly unknown[]
    }>(ctx, 'workspaceRegistry')
    const archived = new Set((registry?.archivedSessionIds ?? []).map(String))
    const rawWorkspaces = registry?.list?.() ?? []
    for (const ws of rawWorkspaces) {
      if (!ws || typeof ws.path !== 'string' || !ws.path.trim()) continue
      const wsPath = ws.path.trim()
      const title = typeof ws.title === 'string' && ws.title.trim()
        ? ws.title.trim()
        : (basename(wsPath) || wsPath)
      const sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds.map(String) : []
      const activeCount = sessionIds.filter(sid => !archived.has(sid)).length
      workspaceItems.push({
        id: String(ws.id ?? wsPath),
        title,
        path: wsPath,
        sessionCount: activeCount,
      })
    }
  } catch {
    // ignore
  }

  // 6. MCP Servers
  let mcpAvailable = false
  const mcpServers: DshMcpServerView[] = []
  let mcpConnected = 0
  let mcpFailed = 0
  try {
    const mcp = readOptionalService<{
      list?: () => Array<{
        name: string
        configured: boolean
        status?: { state?: string; error?: string }
      }>
    }>(ctx, 'mcpManager')
    if (mcp && typeof mcp.list === 'function') {
      mcpAvailable = true
      for (const s of mcp.list()) {
        const state = String(s.status?.state ?? 'unknown')
        if (state === 'ready' || state === 'connected') mcpConnected += 1
        if (state === 'failed' || state === 'error') mcpFailed += 1
        mcpServers.push({
          name: s.name,
          configured: Boolean(s.configured),
          state,
          ...(s.status?.error ? { error: s.status.error } : {}),
        })
      }
    }
  } catch {
    // ignore
  }

  // 7. Skills & Schedules (async, bounded)
  let skillsAvailable = false
  let skillsTotal = 0
  try {
    const skills = readOptionalService<{
      list?: () => Promise<readonly unknown[]>
    }>(ctx, 'skills')
    if (skills && typeof skills.list === 'function') {
      skillsAvailable = true
      const list = await skills.list()
      skillsTotal = Array.isArray(list) ? list.length : 0
    }
  } catch {
    // ignore
  }

  let schedulesAvailable = false
  let schedulesTotal = 0
  let schedulesActive = 0
  try {
    const schedule = readOptionalService<{
      list?: (req?: { limit?: number }) => Promise<{ items?: Array<{ status?: string }>; total?: number }>
    }>(ctx, 'schedule')
    if (schedule && typeof schedule.list === 'function') {
      schedulesAvailable = true
      const res = await schedule.list({ limit: 200 })
      const items = Array.isArray(res?.items) ? res.items : []
      schedulesTotal = typeof res?.total === 'number' ? res.total : items.length
      schedulesActive = items.filter(item => item.status === 'active').length
    }
  } catch {
    // ignore
  }

  // 8. Cordis Loader plugins summary
  const plugins = readLoaderSummary(ctx)

  return {
    collectedAt: Date.now(),
    process: processView,
    ...(defaultModel ? { defaultModel } : {}),
    providers,
    agents: {
      total: agentItems.length,
      running: runningAgents,
      idle: idleAgents,
      items: agentItems,
    },
    sessions: {
      total: sessionItems.length,
      items: sessionItems.slice(0, 20),
    },
    workspaces: {
      total: workspaceItems.length,
      items: workspaceItems,
    },
    mcp: {
      available: mcpAvailable,
      total: mcpServers.length,
      connected: mcpConnected,
      failed: mcpFailed,
      servers: mcpServers,
    },
    skills: {
      available: skillsAvailable,
      total: skillsTotal,
    },
    schedules: {
      available: schedulesAvailable,
      total: schedulesTotal,
      active: schedulesActive,
    },
    plugins,
  }
}

function readLoaderSummary(ctx: Context): DshPluginSummaryView {
  let total = 0
  let active = 0
  let failed = 0
  const failedNames: string[] = []

  try {
    const loader = readOptionalService<{
      entries?: () => Iterable<{
        disabled?: boolean
        options?: { name?: string; group?: boolean }
        fiber?: { state?: number }
      }>
    }>(ctx, 'loader')
    if (loader && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        if (entry.options?.group) continue
        total += 1
        // Cordis FiberState: 2 = ACTIVE, 3 = FAILED
        if (entry.fiber?.state === 2) {
          active += 1
        } else if (entry.fiber?.state === 3) {
          failed += 1
          if (entry.options?.name) failedNames.push(entry.options.name)
        }
      }
    }
  } catch {
    // ignore
  }

  return { total, active, failed, failedNames }
}
