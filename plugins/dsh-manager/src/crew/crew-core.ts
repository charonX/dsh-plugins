/**
 * The crew core: a crew member is a role card the pipeline stages reference —
 * a name, a duty prompt carried with every dispatched task, and optional
 * model/provider overrides. Members are plain mutable records; the pipeline
 * owns the stage order, the member owns only who does it.
 */
import { z } from 'zod'

/** The executor kinds a member may run as: the harness's own sessions or Multica-style local CLI backends. */
export const AGENT_KINDS = ['builtin', 'claude-code', 'codex', 'agy', 'cursor', 'pi'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/** One crew member: the role card behind pipeline stages. */
export const crewMember = z.object({
  id: z.string(),
  /** Display name, e.g. 产品小王. */
  name: z.string().trim().min(1).max(40),
  /** The duty prompt carried with every task dispatched to this member. */
  role: z.string().trim().min(1).max(4000),
  /** How the member executes: the harness's built-in executor by default, an external agent CLI when wired. */
  agentKind: z.enum(AGENT_KINDS).optional(),
  /** Optional LLM provider override; absent inherits the bundle default. */
  provider: z.string().min(1).optional(),
  /** Optional model override; absent inherits the bundle default. */
  model: z.string().min(1).optional(),
  /** A disabled member stays configurable but no stage may dispatch to it. */
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type CrewMember = z.infer<typeof crewMember>
