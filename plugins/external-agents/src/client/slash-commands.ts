/**
 * Composer '/' slash-command source backed by the active third-party agent's
 * probed command catalog. Emits candidates only when the session uses an
 * external agent (`agy`, `claude-code`, `pi`, `codex`) and inserts plain
 * `/<command> ` text so the turn driver forwards it straight to that agent.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CandidateRequest,
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { AgentCommandOption, AgentDescriptor, SessionAgentId } from '../types.ts'

export interface SlashCommandSourceDeps {
  readonly getAgentId: (sessionId: string) => SessionAgentId
  readonly fetchSessionAgentId: (sessionId: string) => Promise<SessionAgentId>
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly sectionLabel?: (agent: AgentDescriptor) => string
}

/** Rank and filter an agent's commands against the typed `/` query (prefix hits first, then substring hits). */
export function buildAgentSlashCandidates(
  agent: AgentDescriptor | undefined,
  query: string,
  sectionLabel?: (agent: AgentDescriptor) => string,
): readonly InputTriggerCandidate[] {
  if (agent === undefined || agent.id === 'native' || agent.commands.length === 0) return []
  const needle = query.trim().toLowerCase()
  const prefixMatches: AgentCommandOption[] = []
  const nameMatches: AgentCommandOption[] = []
  const descriptionMatches: AgentCommandOption[] = []
  for (const cmd of agent.commands) {
    if (needle === '') {
      prefixMatches.push(cmd)
      continue
    }
    const lowerName = cmd.name.toLowerCase()
    if (lowerName.startsWith(needle)) {
      prefixMatches.push(cmd)
    } else if (lowerName.includes(needle)) {
      nameMatches.push(cmd)
    } else if (cmd.description?.toLowerCase().includes(needle) === true) {
      descriptionMatches.push(cmd)
    }
  }
  const section = sectionLabel === undefined ? agent.label : sectionLabel(agent)
  return [...prefixMatches, ...nameMatches, ...descriptionMatches].map((cmd): InputTriggerCandidate => {
    const descParts: string[] = []
    if (cmd.argumentHint !== undefined && cmd.argumentHint !== '') descParts.push(cmd.argumentHint)
    if (cmd.description !== undefined && cmd.description !== '') descParts.push(cmd.description)
    const description = descParts.length > 0 ? descParts.join(' · ') : undefined
    return {
      name: cmd.name,
      icon: IconAgentPresetOutlineRegular,
      section,
      ...(description === undefined ? {} : { description }),
    }
  })
}

export function createExternalSlashSource(deps: SlashCommandSourceDeps): InputTriggerSource {
  let lastCatalogAttemptAt = 0

  return {
    trigger: '/',
    name: 'external-agent',
    order: -10,
    async candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      const sid = String(session.sessionId)
      let agentId = deps.getAgentId(sid)
      if (agentId === 'native') {
        try {
          agentId = await deps.fetchSessionAgentId(sid)
        } catch {
          return []
        }
      }
      if (req.signal.aborted || agentId === 'native') return []

      let catalog = deps.getCachedCatalog()
      let agent = catalog?.find(item => item.id === agentId)
      const now = Date.now()
      if ((catalog === undefined || (agent?.commands.length ?? 0) === 0) && now - lastCatalogAttemptAt > 5_000) {
        lastCatalogAttemptAt = now
        try {
          catalog = await deps.fetchCatalog()
          agent = catalog.find(item => item.id === agentId)
        } catch {
          // Return whatever cached descriptor exists on transient RPC failures.
        }
      }
      if (req.signal.aborted) return []
      return buildAgentSlashCandidates(agent, req.query, deps.sectionLabel)
    },
    warm(session: ClientSessionContext): void {
      if (deps.getCachedCatalog() === undefined) {
        lastCatalogAttemptAt = Date.now()
        void deps.fetchCatalog().catch(() => {})
      }
      void deps.fetchSessionAgentId(String(session.sessionId)).catch(() => {})
    },
    onPick({ candidate }) {
      return { text: `/${candidate.name} ` }
    },
  }
}

export function installExternalSlashCommands(
  ctx: ClientContext,
  deps: SlashCommandSourceDeps,
): () => void {
  const scope = ctx.inject(['inputTriggers'], (triggerCtx) => {
    const inputTriggers = (triggerCtx as unknown as { readonly inputTriggers: InputTriggerServiceContract }).inputTriggers
    const source = createExternalSlashSource(deps)
    triggerCtx.effect(() => inputTriggers.registerSource(source), 'external-agents: slash command source')
  })
  return () => {
    scope.dispose()
  }
}
