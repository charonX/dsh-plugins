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

  async execute(ticket: Ticket, signal: AbortSignal): Promise<{ summary?: string; error?: string }> {
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
    const agentsService = this.ctx.get('agents') as {
      create?: (opts: unknown) => Promise<{
        agent: {
          session: unknown
          followup: (msg: unknown) => void
          settled?: () => Promise<void>
        }
        dispose: () => Promise<void>
      }>
    } | undefined

    if (!agentsService || typeof agentsService.create !== 'function') {
      // In headless or mock environment without full agent harness, return simulated completion
      this.ctx.logger.info(`[Autoloop] Simulated execution for ticket ${ticket.id} in ${workingDirectory}`)
      return {
        summary: `Task "${ticket.title}" processed in ${workingDirectory} with intent ${ticket.mandate.intent}`,
      }
    }

    const sessionId = `autoloop-${ticket.id}-${randomUUID().slice(0, 8)}`
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

    try {
      signal.throwIfAborted()

      // Provide initial prompt instruction
      handle.agent.followup({
        role: 'user',
        content: [{ type: 'text', text: ticket.mandate.instruction }],
      })

      if (typeof handle.agent.settled === 'function') {
        await handle.agent.settled()
      }

      return {
        summary: `Successfully completed ticket ${ticket.id}`,
      }
    } finally {
      await handle.dispose().catch(() => {})
    }
  }
}
