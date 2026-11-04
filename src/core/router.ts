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

    // Allow user/event to explicitly specify model
    if (event.payload?.model && typeof event.payload.model === 'object') {
      const m = event.payload.model as { provider?: string; model?: string }
      if (m.model) {
        model = { provider: m.provider, model: m.model }
      }
    } else if (intent === 'coding') {
      model = this.options.flagshipModel ?? { provider: 'deepseek-official', model: 'deepseek-reasoner' }
    }

    // Permission preset (defaults to 'workspace-write')
    const permissionPreset = (typeof event.payload?.permissionPreset === 'string' && event.payload.permissionPreset) || 'workspace-write'
    const agentPreset = typeof event.payload?.agentPreset === 'string' ? event.payload.agentPreset : undefined

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
      permissionPreset,
      agentPreset,
    }
  }
}
