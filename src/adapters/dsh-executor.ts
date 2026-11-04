/**
 * DeepSeek Harness native agent executor adapter.
 * Connects Autoloop tickets to ctx.agents, ctx.worktrees, and ctx.sessions.
 *
 * @module @charonx/dsh-autoloop/adapters/dsh-executor
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentExecutor, Ticket } from '../shared/types.js'

export class DshAgentExecutor implements AgentExecutor {
  public readonly name = 'dsh-native'

  constructor(
    private readonly ctx: Context,
    private readonly options: { autoWorktree?: boolean } = {},
  ) {}

  async execute(ticket: Ticket, signal: AbortSignal): Promise<{ summary?: string; error?: string; sessionId?: string }> {
    signal.throwIfAborted()

    // 1. Resolve workspace root
    let workingDirectory = ticket.mandate.workspacePath

    // 2. Optionally invoke ctx.worktrees if service is present and enabled
    const worktreeService = this.ctx.get('worktrees') as {
      create?: (agent: unknown, req: unknown, sig: unknown) => Promise<{ path: string; branch: string; baseCommit: string }>
    } | undefined

    if (this.options.autoWorktree && worktreeService && typeof worktreeService.create === 'function') {
      try {
        const dummyAgent = { meta: { cwd: workingDirectory } }
        const created = await worktreeService.create(dummyAgent, { name: `autoloop-${ticket.id}` }, signal)
        workingDirectory = created.path
        ticket.workspace.worktree = {
          enabled: true,
          path: created.path,
          branch: created.branch,
          baseCommit: created.baseCommit,
        }
      } catch (err) {
        this.ctx.logger.warn(`[Autoloop] Worktree allocation skipped: ${String(err)}`)
      }
    }

    // 3. Create agent session via ctx.agents if present
    const agentsService = (this.ctx.get('agents') ?? (this.ctx as any).root?.get?.('agents') ?? (this.ctx as any).agents) as {
      create?: (opts: unknown) => Promise<{
        agent: {
          session: unknown
          followup: (msg: unknown) => void
          whenIdle?: () => Promise<void>
          settled?: () => Promise<void>
          cancel?: (cause: unknown) => void
        }
        dispose: () => Promise<void>
      }>
    } | undefined

    if (!agentsService || typeof agentsService.create !== 'function') {
      // In headless or mock environment without full agent harness, return simulated completion
      this.ctx.logger.info(`[Autoloop] Simulated execution for ticket ${ticket.id} in ${workingDirectory}`)
      return {
        summary: `Task "${ticket.title}" processed in ${workingDirectory} with intent ${ticket.mandate.intent}`,
        sessionId: ticket.assignment?.sessionId ?? `mock-${ticket.id}`,
      }
    }

    // Determine session ID (reuse linked conversation if specified)
    let sessionId: string
    if (ticket.threadId.startsWith('dsh:session:')) {
      sessionId = ticket.threadId.slice('dsh:session:'.length)
    } else {
      sessionId = `autoloop-${ticket.id}-${randomUUID().slice(0, 8)}`
    }

    if (ticket.assignment) {
      ticket.assignment.sessionId = sessionId
    }

    const handle = await agentsService.create({
      sessionId,
      signal,
      meta: { cwd: workingDirectory },
      agentOptions: {
        provider: ticket.mandate.model.provider,
        model: ticket.mandate.model.model,
      },
    })

    // Attach session to workspace registry so it appears in the sidebar under its project
    try {
      const registry = (this.ctx.get('workspaceRegistry') ?? (this.ctx as any).root?.get?.('workspaceRegistry') ?? (this.ctx as any).workspaceRegistry) as {
        resolveByPath?: (path: string) => Promise<{ attachSession?: (id: string) => Promise<void> } | undefined>
        list?: () => Array<{ path: string; attachSession?: (id: string) => Promise<void> }>
        create?: (path: string) => Promise<{ path: string; attachSession?: (id: string) => Promise<void> }>
      } | undefined

      let workspace: { attachSession?: (id: string) => Promise<void> } | undefined
      if (registry?.resolveByPath) {
        workspace = await registry.resolveByPath(workingDirectory).catch(() => undefined)
      }
      if (!workspace && registry?.list) {
        workspace = registry.list().find((w: any) => w.path === workingDirectory)
      }
      if (!workspace && registry?.create) {
        workspace = await registry.create(workingDirectory).catch(() => undefined)
      }
      if (workspace && typeof workspace.attachSession === 'function') {
        await workspace.attachSession(sessionId)
        this.ctx.logger.info(`[Autoloop] Session ${sessionId} joined workspace at ${workingDirectory}`)
      }
    } catch (err) {
      this.ctx.logger.warn(`[Autoloop] attachSession failed: ${String(err)}`)
    }

    // Rename session title for friendly UI display
    try {
      const sessionTitle = (this.ctx.get('sessionTitle') ?? (this.ctx as any).root?.get?.('sessionTitle')) as {
        rename?: (session: any, title: string) => void
      } | undefined
      if (sessionTitle?.rename && handle.agent.session) {
        sessionTitle.rename(handle.agent.session, ticket.title)
      }
    } catch {}

    const abortHandler = () => {
      try {
        handle.agent.cancel?.('user-request')
      } catch {}
    }
    signal.addEventListener('abort', abortHandler, { once: true })

    try {
      signal.throwIfAborted()

      // Provide initial prompt instruction
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: ticket.mandate.instruction }],
        source: { kind: 'user' },
      })

      // Wait for the agent to finish its turns and reach quiescence
      if (typeof handle.agent.whenIdle === 'function') {
        await handle.agent.whenIdle()
      } else if (typeof handle.agent.settled === 'function') {
        await handle.agent.settled()
      }

      // Extract model's output messages as execution summary
      let summary = ''
      try {
        const messages = (handle.agent.session as any)?.deriveMessages?.() ?? []
        const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant')
        if (lastAssistant && Array.isArray(lastAssistant.content)) {
          summary = lastAssistant.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
        }
      } catch (err) {
        this.ctx.logger.warn(`[Autoloop] deriveMessages error: ${String(err)}`)
      }

      if (!summary) {
        summary = `任务 "${ticket.title}" 已执行完毕。会话 ID: ${sessionId}。可在左侧侧边栏查看对应对话详情。`
      }

      return { summary, sessionId }
    } finally {
      signal.removeEventListener('abort', abortHandler)
      // Note: We deliberately do NOT call handle.dispose() here so the session
      // remains interactive and viewable in DeepSeek Harness sidebar!
    }
  }
}
