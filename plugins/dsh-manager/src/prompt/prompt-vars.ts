/**
 * Read-only prompt variable catalog, template variable validator, `{{var}}`
 * interpolator (dropping lines that become empty due to missing values),
 * and context builder over existing domain facts.
 */
import type { TicketRecord } from '../board-domain.ts'
import type { CrewMember } from '../crew/crew-core.ts'
import type { PipelineRecord, PipelineStage } from '../pipeline/pipeline-core.ts'

export interface PromptSkillRef {
  readonly name: string
  readonly description: string
  readonly path: string
}

export interface PromptLandingFactsRef {
  readonly repoRoot: string
  readonly defaultBaseBranch?: string
  readonly recommendedFallback?: string
}

export type PromptVariableGroup =
  | 'ticket'
  | 'stage'
  | 'pipeline'
  | 'member'
  | 'flow'
  | 'project'
  | 'context'
  | 'env'

export interface PromptVariableDef {
  readonly name: string
  readonly group: PromptVariableGroup
  readonly description: string
  readonly source: string
}

/** Authoritative read-only catalog of template variables available across turns. */
export const PROMPT_VARIABLES: readonly PromptVariableDef[] = [
  // Ticket
  { name: 'ticket.id', group: 'ticket', description: 'Ticket ID', source: 'TicketRecord.id' },
  { name: 'ticket.title', group: 'ticket', description: 'Ticket title', source: 'TicketRecord.title' },
  { name: 'ticket.state', group: 'ticket', description: 'Ticket board column state', source: 'TicketRecord.state' },
  { name: 'ticket.mandate.scope', group: 'ticket', description: 'Granted mandate scope', source: 'TicketRecord.mandate.scope' },
  { name: 'ticket.mandate.strength', group: 'ticket', description: 'Mandate strength (explicit/inferred)', source: 'TicketRecord.mandate.strength' },
  { name: 'ticket.acceptanceCriteria', group: 'ticket', description: 'Aligned acceptance criteria', source: 'TicketRecord.acceptanceCriteria' },
  { name: 'ticket.projectId', group: 'ticket', description: 'Mapped DSH project ID', source: 'TicketRecord.projectId' },
  { name: 'ticket.handoffSessionId', group: 'ticket', description: 'Originating discussion session ID', source: 'TicketRecord.handoffSessionId' },

  // Stage
  { name: 'stage.index', group: 'stage', description: '1-based current stage number', source: 'flow.stageIndex + 1' },
  { name: 'stage.count', group: 'stage', description: 'Total stages in live pipeline', source: 'PipelineRecord.stages.length' },
  { name: 'stage.mode', group: 'stage', description: 'Stage execution mode (execute/review)', source: 'PipelineStage.mode' },
  { name: 'stage.instruction', group: 'stage', description: 'Stage instruction text', source: 'PipelineStage.instruction' },
  { name: 'stage.skipLogic', group: 'stage', description: 'Stage skip condition prompt', source: 'PipelineStage.skipLogic' },

  // Pipeline
  { name: 'pipeline.id', group: 'pipeline', description: 'Pipeline ID', source: 'PipelineRecord.id' },
  { name: 'pipeline.name', group: 'pipeline', description: 'Pipeline display name', source: 'PipelineRecord.name' },

  // Member
  { name: 'member.id', group: 'member', description: 'Assigned crew member ID', source: 'CrewMember.id' },
  { name: 'member.name', group: 'member', description: 'Assigned crew member name', source: 'CrewMember.name' },
  { name: 'member.role', group: 'member', description: 'Crew member duty prompt', source: 'CrewMember.role' },

  // Flow
  { name: 'flow.index', group: 'flow', description: '0-based stage index in flow run', source: 'TicketFlow.stageIndex' },
  { name: 'flow.stageId', group: 'flow', description: 'Current stage ticket identifier', source: 'TicketRecord.id' },

  // Project facts (resolved dynamically at dispatch / preview time)
  { name: 'project.id', group: 'project', description: 'Resolved project ID', source: 'Ticket / Mapping' },
  { name: 'project.name', group: 'project', description: 'Workspace display name', source: 'workspaceRegistry.title' },
  { name: 'project.root', group: 'project', description: 'Project root directory', source: 'workspaceRegistry.path / git root' },
  { name: 'project.agentsMd', group: 'project', description: 'Excerpt of AGENTS.md / CLAUDE.md', source: 'landing-discovery' },
  { name: 'project.gitFlow', group: 'project', description: 'Excerpt of docs/git-flow.md', source: 'repository docs/git-flow.md' },
  { name: 'project.verifyDocs', group: 'project', description: 'Excerpt of docs/verify/README.md', source: 'repository docs/verify/README.md' },
  { name: 'project.landingMode', group: 'project', description: 'Recommended safe landing fallback mode', source: 'ProjectLandingFacts.recommendedFallback' },
  { name: 'project.baseBranch', group: 'project', description: 'Target base branch for worktree', source: 'WorktreeSpec / LandingFacts' },
  { name: 'project.mergeTarget', group: 'project', description: 'Target local integration branch', source: 'WorktreeSpec.mergeTarget' },

  // Context blocks & runtime identifiers
  { name: 'skills.list', group: 'context', description: 'Discovered workspace skills bullet list', source: 'workspace-skills' },
  { name: 'portfolio.lines', group: 'context', description: 'Active and recent-ended portfolio summary', source: 'portfolio-context' },
  { name: 'rules.lines', group: 'context', description: 'Configured route rules list', source: 'dshManagerRoute' },
  { name: 'triggers.lines', group: 'context', description: 'Trigger items in current eval batch', source: 'dshManagerSources' },
  { name: 'handoff.lines', group: 'context', description: 'Handoff context lines', source: 'executor handoffContextLines' },
  { name: 'upstream.lines', group: 'context', description: 'Upstream stage outputs', source: 'executor upstreamStageLines' },
  { name: 'answers.lines', group: 'context', description: 'Answered human attentions', source: 'executor answeredAttentionLines' },
  { name: 'worktree.line', group: 'context', description: 'Worktree plan line', source: 'executor worktreePlanPromptLines' },
  { name: 'landing.lines', group: 'context', description: 'Project landing discovery lines', source: 'landing-discovery' },
  { name: 'dispatch.id', group: 'context', description: 'Current dispatch ID', source: 'DispatchRecord.id' },
  { name: 'eval.id', group: 'context', description: 'Current eval ID', source: 'EvalRecord.id' },
  { name: 'thread.id', group: 'context', description: 'Current thread ID', source: 'Thread / Ticket.threadId' },
  { name: 'batch.count', group: 'context', description: 'Number of threads in batch eval', source: 'batch size' },

  // Environment
  { name: 'env.scratchDir', group: 'env', description: 'Shared task scratch artifact directory', source: 'scratch-artifacts' },
  { name: 'env.cwd', group: 'env', description: 'Execution working directory', source: 'worktree / project cwd' },
  { name: 'env.worktreePath', group: 'env', description: 'Git worktree path', source: 'WorktreeSpec.path' },
  { name: 'env.today', group: 'env', description: 'Current ISO date (YYYY-MM-DD)', source: 'Date' },
]

export const PROMPT_VARIABLE_SET: ReadonlySet<string> = new Set(PROMPT_VARIABLES.map(v => v.name))

const TEMPLATE_TOKEN_RE = /\{\{([^}]+)\}\}/g

/** Extract all unique `{{var}}` variable names referenced by `text` in order. */
export function extractTemplateVariables(text: string): readonly string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const match of text.matchAll(TEMPLATE_TOKEN_RE)) {
    const name = (match[1] ?? '').trim()
    if (name !== '' && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/** Return any unknown variable names referenced by `text`. */
export function findUnknownTemplateVariables(text: string): readonly string[] {
  return extractTemplateVariables(text).filter(name => !PROMPT_VARIABLE_SET.has(name))
}

/** Validate that `text` uses only registered variables; throws an actionable Error otherwise. */
export function validateTemplateVariables(turnId: string, sectionId: string, text: string): void {
  for (const name of extractTemplateVariables(text)) {
    if (!PROMPT_VARIABLE_SET.has(name)) {
      throw new Error(`prompt turn "${turnId}" section "${sectionId}" uses unknown variable "${name}"`)
    }
  }
}

export interface RenderedTemplate {
  readonly text: string
  readonly missing: readonly string[]
  readonly unknown: readonly string[]
}

/**
 * Simple `{{var}}` interpolator (no conditionals/loops).
 * Missing values substitute as empty string; if a line containing `{{...}}`
 * becomes empty after substitution, that entire line is omitted.
 */
export function renderTemplate(
  text: string,
  vars: Readonly<Record<string, string | undefined>>,
): RenderedTemplate {
  const missingSet = new Set<string>()
  const unknownSet = new Set<string>()
  const missing: string[] = []
  const unknown: string[] = []

  const lines = text.split(/\r?\n/)
  const outputLines: string[] = []

  for (const line of lines) {
    let hadPlaceholder = false
    const rendered = line.replace(TEMPLATE_TOKEN_RE, (_full, rawName: string) => {
      hadPlaceholder = true
      const name = rawName.trim()
      if (!PROMPT_VARIABLE_SET.has(name)) {
        if (!unknownSet.has(name)) {
          unknownSet.add(name)
          unknown.push(name)
        }
        return ''
      }
      const value = vars[name]
      if (value === undefined || value === '') {
        if (!missingSet.has(name)) {
          missingSet.add(name)
          missing.push(name)
        }
        return ''
      }
      return value
    })
    if (hadPlaceholder && rendered.trim() === '') {
      continue
    }
    outputLines.push(rendered)
  }

  return {
    text: outputLines.join('\n'),
    missing,
    unknown,
  }
}

/** Dynamic repository documentation & git-flow facts resolved for template variables. */
export interface ProjectFactsSnapshot {
  readonly root: string
  readonly agentsMd?: string
  readonly gitFlow?: string
  readonly verifyDocs?: string
  readonly landingFacts?: PromptLandingFactsRef
}

export interface PromptContextInput {
  readonly ticket?: TicketRecord
  readonly pipeline?: PipelineRecord
  readonly stage?: PipelineStage
  readonly member?: CrewMember
  readonly stageIndex?: number
  readonly stageCount?: number
  readonly projectId?: string
  readonly projectName?: string
  readonly projectRoot?: string
  readonly projectFacts?: ProjectFactsSnapshot
  readonly landingFacts?: PromptLandingFactsRef
  readonly skills?: readonly PromptSkillRef[]
  readonly portfolioLines?: readonly string[]
  readonly ruleLines?: readonly string[]
  readonly triggerLines?: readonly string[]
  readonly handoffLines?: readonly string[]
  readonly upstreamLines?: readonly string[]
  readonly answeredLines?: readonly string[]
  readonly worktreeLine?: string
  readonly landingLines?: readonly string[]
  readonly cwd?: string
  readonly scratchDir?: string
  readonly worktreePath?: string
  readonly baseBranch?: string
  readonly mergeTarget?: string
  readonly dispatchId?: string
  readonly evalId?: string
  readonly threadId?: string
  readonly batchCount?: number
  readonly now?: number
  readonly degradedStageText?: string
  readonly hasSkipLogic?: boolean
  readonly dataBlocks?: Readonly<Record<string, readonly string[]>>
  readonly stageMode?: 'execute' | 'review'
}

export interface PromptRenderContext {
  readonly vars: Readonly<Record<string, string | undefined>>
  readonly dataBlocks: Readonly<Record<string, readonly string[]>>
  readonly flags: {
    readonly hasMandate: boolean
    readonly hasHandoff: boolean
    readonly hasFlow: boolean
    readonly hasUpstream: boolean
    readonly hasAnswers: boolean
    readonly hasSkills: boolean
    readonly hasWorktree: boolean
    readonly hasLanding: boolean
    readonly hasArtifacts: boolean
    readonly noSkipLogic: boolean
  }
  readonly variants: Readonly<Record<string, string>>
  readonly degradedStageText?: string
}

/** Expand known template variables inside operator-configured text (role / stage instruction) once. */
function interpolateConfigText(
  raw: string | undefined,
  vars: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (raw === undefined || raw === '' || !raw.includes('{{')) return raw
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    let hadKnownToken = false
    const rendered = line.replace(TEMPLATE_TOKEN_RE, (full, rawName: string) => {
      const name = rawName.trim()
      if (!PROMPT_VARIABLE_SET.has(name)) return full
      hadKnownToken = true
      return vars[name] ?? ''
    })
    if (hadKnownToken && rendered.trim() === '') continue
    out.push(rendered)
  }
  return out.join('\n')
}

/** Build normalized template variables, variant selectors, and system data blocks from runtime facts. */
export function buildPromptContext(input: PromptContextInput): PromptRenderContext {
  const ticket = input.ticket
  const flow = ticket?.flow
  const stageIndexZero = input.stageIndex ?? flow?.stageIndex
  const stageCount = input.stageCount ?? input.pipeline?.stages.length ?? flow?.stageCount
  const stageIndexOne = stageIndexZero === undefined ? undefined : stageIndexZero + 1
  const stageMode = input.stageMode ?? input.stage?.mode

  const skills = input.skills ?? []
  const skillsList = skills.length === 0
    ? undefined
    : skills.map(skill => skill.description !== ''
      ? `- ${skill.name} (${skill.path}): ${skill.description}`
      : `- ${skill.name} (${skill.path})`).join('\n')

  const landingFacts = input.landingFacts ?? input.projectFacts?.landingFacts
  const projectFacts = input.projectFacts
  const projectId = input.projectId ?? ticket?.projectId
  const projectRoot = input.projectRoot ?? projectFacts?.root ?? landingFacts?.repoRoot
  const mapped = projectId !== undefined

  const handoffLines = input.handoffLines ?? []
  const upstreamLines = input.upstreamLines ?? []
  const answeredLines = input.answeredLines ?? []
  const landingLines = input.landingLines ?? []
  const portfolioLines = input.portfolioLines ?? []
  const ruleLines = input.ruleLines ?? []
  const triggerLines = input.triggerLines ?? []

  const today = new Date(input.now ?? Date.now()).toISOString().slice(0, 10)
  const effectiveScratchDir = input.scratchDir ?? ticket?.scratchDir

  const baseVars: Record<string, string | undefined> = {
    'ticket.id': ticket?.id,
    'ticket.title': ticket?.title,
    'ticket.state': ticket?.state,
    'ticket.mandate.scope': ticket?.mandate?.scope,
    'ticket.mandate.strength': ticket?.mandate?.strength,
    'ticket.acceptanceCriteria': ticket?.acceptanceCriteria,
    'ticket.projectId': projectId,
    'ticket.handoffSessionId': ticket?.handoffSessionId,

    'stage.index': stageIndexOne === undefined ? undefined : String(stageIndexOne),
    'stage.count': stageCount === undefined ? undefined : String(stageCount),
    'stage.mode': stageMode,
    'stage.skipLogic': input.stage?.skipLogic,

    'pipeline.id': input.pipeline?.id ?? flow?.pipelineId,
    'pipeline.name': input.pipeline?.name ?? flow?.pipelineName,

    'member.id': input.member?.id ?? input.stage?.memberId,
    'member.name': input.member?.name,

    'flow.index': stageIndexZero === undefined ? undefined : String(stageIndexZero),
    'flow.stageId': ticket?.id,

    'project.id': projectId,
    'project.name': input.projectName,
    'project.root': projectRoot,
    'project.agentsMd': projectFacts?.agentsMd,
    'project.gitFlow': projectFacts?.gitFlow,
    'project.verifyDocs': projectFacts?.verifyDocs,
    'project.landingMode': landingFacts?.recommendedFallback,
    'project.baseBranch': input.baseBranch ?? ticket?.worktree?.baseBranch ?? landingFacts?.defaultBaseBranch,
    'project.mergeTarget': input.mergeTarget ?? ticket?.worktree?.mergeTarget,

    'skills.list': skillsList,
    'portfolio.lines': portfolioLines.length === 0 ? undefined : portfolioLines.join('\n'),
    'rules.lines': ruleLines.length === 0 ? undefined : ruleLines.join('\n'),
    'triggers.lines': triggerLines.length === 0 ? undefined : triggerLines.join('\n'),
    'handoff.lines': handoffLines.length === 0 ? undefined : handoffLines.join('\n'),
    'upstream.lines': upstreamLines.length === 0 ? undefined : upstreamLines.join('\n'),
    'answers.lines': answeredLines.length === 0 ? undefined : answeredLines.join('\n'),
    'worktree.line': input.worktreeLine,
    'landing.lines': landingLines.length === 0 ? undefined : landingLines.join('\n'),

    'dispatch.id': input.dispatchId,
    'eval.id': input.evalId,
    'thread.id': input.threadId ?? ticket?.threadId,
    'batch.count': input.batchCount === undefined ? undefined : String(input.batchCount),

    'env.scratchDir': effectiveScratchDir,
    'env.cwd': input.cwd,
    'env.worktreePath': input.worktreePath ?? ticket?.worktree?.path ?? input.cwd,
    'env.today': today,
  }

  const resolvedStageInstruction = interpolateConfigText(input.stage?.instruction, baseVars)
  const resolvedMemberRole = interpolateConfigText(input.member?.role, baseVars)
  const vars: Record<string, string | undefined> = {
    ...baseVars,
    'stage.instruction': resolvedStageInstruction,
    'member.role': resolvedMemberRole,
  }

  const stageVariant = resolvedStageInstruction !== undefined && resolvedStageInstruction !== ''
    ? 'default'
    : 'no-instruction'
  const artifactsVariant = stageMode === 'review' ? 'review' : 'execute'
  const scopeVariant = !mapped
    ? 'unmapped'
    : stageMode === 'review'
      ? (effectiveScratchDir === undefined ? 'review-cwd' : 'review')
      : 'mapped'

  const variants: Record<string, string> = {
    stage: stageVariant,
    artifacts: artifactsVariant,
    scope: scopeVariant,
    header: ticket?.mandate !== undefined ? 'with-mandate' : 'no-mandate',
    criteria: stageMode === 'review' ? 'review' : 'default',
  }

  return {
    vars,
    dataBlocks: input.dataBlocks ?? {},
    flags: {
      hasMandate: ticket?.mandate !== undefined,
      hasHandoff: handoffLines.length > 0,
      hasFlow: flow !== undefined || input.stage !== undefined,
      hasUpstream: upstreamLines.length > 0,
      hasAnswers: answeredLines.length > 0,
      hasSkills: skills.length > 0,
      hasWorktree: input.worktreeLine !== undefined && input.worktreeLine !== '',
      hasLanding: landingLines.length > 0,
      hasArtifacts: mapped && input.scratchDir !== undefined,
      noSkipLogic: input.hasSkipLogic !== true,
    },
    variants,
    ...(input.degradedStageText === undefined ? {} : { degradedStageText: input.degradedStageText }),
  }
}
