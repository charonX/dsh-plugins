/**
 * Composer '/' slash-command source backed by the active third-party agent's
 * probed command catalog. Emits candidates only when the session uses an
 * external agent (`agy`, `claude-code`, `pi`, `codex`, `cursor`) and inserts plain
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
import type { AgentCommandOption, AgentDescriptor, ExternalAgentId, SessionAgentId } from '../types.ts'

export interface SlashCommandSourceDeps {
  readonly getAgentId: (sessionId: string) => SessionAgentId
  readonly fetchSessionAgentId: (sessionId: string) => Promise<SessionAgentId>
  readonly getCachedCatalog: () => readonly AgentDescriptor[] | undefined
  readonly fetchCatalog: () => Promise<readonly AgentDescriptor[]>
  readonly getCachedSessionCommands?: (sessionId: string, agentId: ExternalAgentId) => readonly AgentCommandOption[] | undefined
  readonly fetchSessionCommands?: (sessionId: string, agentId: ExternalAgentId) => Promise<readonly AgentCommandOption[]>
  readonly sectionLabel?: (agent: AgentDescriptor) => string
}

/** Rank and filter an agent's commands against the typed `/` query (prefix hits first, then substring hits). */
export function buildAgentSlashCandidates(
  agent: AgentDescriptor | undefined,
  query: string,
  sectionLabel?: (agent: AgentDescriptor) => string,
  commandsOverride?: readonly AgentCommandOption[],
): readonly InputTriggerCandidate[] {
  const commands = commandsOverride ?? agent?.commands ?? []
  if (agent === undefined || agent.id === 'native' || commands.length === 0) return []
  const needle = query.trim().toLowerCase()
  const prefixMatches: AgentCommandOption[] = []
  const nameMatches: AgentCommandOption[] = []
  const descriptionMatches: AgentCommandOption[] = []
  for (const cmd of commands) {
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
  const lastSessionAttemptAt = new Map<string, number>()

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
      if ((catalog === undefined || (deps.fetchSessionCommands === undefined && (agent?.commands.length ?? 0) === 0))
        && now - lastCatalogAttemptAt > 5_000) {
        lastCatalogAttemptAt = now
        try {
          catalog = await deps.fetchCatalog()
          agent = catalog.find(item => item.id === agentId)
        } catch {
          // Return whatever cached descriptor exists on transient RPC failures.
        }
      }
      if (req.signal.aborted) return []

      let sessionCommands: readonly AgentCommandOption[] | undefined
      if (deps.fetchSessionCommands !== undefined) {
        sessionCommands = deps.getCachedSessionCommands?.(sid, agentId)
        const key = `${sid}\0${agentId}`
        const lastAttempt = lastSessionAttemptAt.get(key) ?? 0
        if ((sessionCommands === undefined || sessionCommands.length === 0) && now - lastAttempt > 5_000) {
          lastSessionAttemptAt.set(key, now)
          try {
            sessionCommands = await deps.fetchSessionCommands(sid, agentId)
          } catch {
            // Fall back to cached session commands or global catalog commands.
          }
        }
        if (req.signal.aborted) return []
      }

      return buildAgentSlashCandidates(agent, req.query, deps.sectionLabel, sessionCommands)
    },
    warm(session: ClientSessionContext): void {
      const sid = String(session.sessionId)
      if (deps.getCachedCatalog() === undefined) {
        lastCatalogAttemptAt = Date.now()
        void deps.fetchCatalog().catch(() => {})
      }
      const warmCommands = (agentId: SessionAgentId): void => {
        if (agentId === 'native' || deps.fetchSessionCommands === undefined) return
        if (deps.getCachedSessionCommands?.(sid, agentId) !== undefined) return
        lastSessionAttemptAt.set(`${sid}\0${agentId}`, Date.now())
        void deps.fetchSessionCommands(sid, agentId).catch(() => {})
      }
      const currentAgentId = deps.getAgentId(sid)
      if (currentAgentId !== 'native') {
        warmCommands(currentAgentId)
      }
      void deps.fetchSessionAgentId(sid).then(warmCommands).catch(() => {})
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
