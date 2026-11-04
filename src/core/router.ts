/**
 * Intent Router (inspired by yetone/magpie).
 * Dynamically infers task intent, model tier, and operational skills from event metadata.
 *
 * @module @charonx/dsh-autoloop/core/router
 */

import type { IngressEvent, TicketMandate } from '../shared/types.js'
import { SecurityGuard } from './security.js'

export interface RouterOptions {
  defaultWorkspacePath: string
  flagshipModel?: { provider?: string; model?: string }
  fastModel?: { provider?: string; model?: string }
}

export class IntentRouter {
  constructor(private readonly options: RouterOptions) {}

  /** Route an IngressEvent into a TicketMandate */
  route(event: IngressEvent): TicketMandate {
    const text = `${event.summary} ${JSON.stringify(event.payload ?? {})}`.toLowerCase()

    let intent = 'general'
    let skills: string[] = []
    let model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }

    if (/error|exception|fail|crash|bug|fix|panic|sentry/.test(text)) {
      intent = 'bugfix'
      skills = ['diagnosing-bugs']
      model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }
    } else if (/review|pr|audit|inspect|diff|merge/.test(text)) {
      intent = 'review'
      skills = ['code-review']
      model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }
    } else if (/clean|sweep|format|garbage|remove unused|debt/.test(text)) {
      intent = 'cleanup'
      skills = ['codebase-design']
      model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }
    } else if (/feat|implement|create|build|develop|add|enhance|refactor/.test(text)) {
      intent = 'coding'
      skills = ['codebase-design', 'tdd']
      model = this.options.flagshipModel ?? { provider: 'deepseek-official', model: 'deepseek-reasoner' }
    }

    // Determine target workspace from payload if provided and safe, or fallback
    let candidatePath = this.options.defaultWorkspacePath
    if (typeof event.payload?.workspacePath === 'string' && event.payload.workspacePath.trim()) {
      candidatePath = event.payload.workspacePath.trim()
    }

    const workspacePath = SecurityGuard.validateWorkspace(
      candidatePath,
      this.options.defaultWorkspacePath,
    )

    const instruction = SecurityGuard.constructSafeInstruction({
      summary: event.summary,
      intent,
      payload: event.payload,
    })

    return {
      intent,
      workspacePath,
      model,
      skills,
      instruction,
    }
  }
}
