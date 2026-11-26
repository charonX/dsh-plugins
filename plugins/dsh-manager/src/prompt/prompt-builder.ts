/**
 * Minimal, code-owned prompt builder for Executor sessions and Steward turns.
 * Replaces multi-tier prompt overrides with direct Skill + Goal + Locked-Contract
 * assembly while keeping full dispatched prompt snapshots on DispatchRecord.
 */
import type { TicketRecord, TicketWorktreePlan } from '../board-domain.ts'
import type { DispatchPromptRecord, DispatchPromptSectionRecord } from '../dispatch/dispatch-core.ts'
import { formatLandingDiscoveryPromptLines, type ProjectLandingFacts } from '../dispatch/landing-discovery.ts'
import { formatSkillPromptLines, type DiscoveredSkill } from '../dispatch/workspace-skills.ts'
import type { FlowDef, FlowStepDef } from '../flow/flow-ir.ts'
import type { ProjectFactsSnapshot } from './project-facts.ts'

export const MAX_RENDERED_PROMPT_BYTES = 65_536

export function truncateUtf8Bytes(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }
  const marker = '\n…(truncated)'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  let sliced = buf.subarray(0, budget).toString('utf8')
  if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1)
  return { text: `${sliced}${marker}`, truncated: true }
}

export interface ExecutorPromptInput {
  readonly turnId: 'executor' | 'external-cli'
  readonly ticket: TicketRecord
  readonly flow?: FlowDef
  readonly step?: FlowStepDef
  readonly stepIndex?: number
  readonly stepCount?: number
  readonly projectId?: string
  readonly projectName?: string
  readonly cwd: string
  readonly skills: readonly DiscoveredSkill[]
  readonly scratchDir?: string
  readonly readOnly: boolean
  readonly worktree?: TicketWorktreePlan
  readonly landingFacts?: ProjectLandingFacts
  readonly projectFacts?: ProjectFactsSnapshot
  readonly handoffLines?: readonly string[]
  readonly upstreamLines?: readonly string[]
  readonly answeredLines?: readonly string[]
  readonly reworkLines?: readonly string[]
  readonly templateRevision: number
}

function buildSection(id: string, text: string, locked: boolean): DispatchPromptSectionRecord {
  return { id, text, source: 'builtin', locked }
}

function worktreeContextLine(worktree: TicketWorktreePlan | undefined): string | undefined {
  if (worktree === undefined) return undefined
  if (worktree.mode === 'in-place') return 'Workspace mode: in-place (work directly in the target directory without creating a git worktree).'
  if (worktree.mode === 'none') return 'Workspace mode: read-only inspection (no git worktree).'
  const parts = [
    worktree.repoRoot === undefined ? undefined : `repo=${worktree.repoRoot}`,
    worktree.baseBranch === undefined ? undefined : `base=${worktree.baseBranch}`,
    worktree.branch === undefined ? undefined : `branch=${worktree.branch}`,
    worktree.mergeTarget === undefined ? undefined : `mergeTarget=${worktree.mergeTarget}`,
  ].filter((v): v is string => v !== undefined)
  return parts.length === 0 ? undefined : `Worktree plan: ${parts.join(', ')}.`
}

/** Build the executor or external-cli prompt and its persisted snapshot record. */
export function buildExecutorTurnPrompt(input: ExecutorPromptInput): {
  readonly text: string
  readonly record: DispatchPromptRecord
} {
  const sections: DispatchPromptSectionRecord[] = []
  const add = (id: string, lines: readonly (string | undefined)[], locked = false): void => {
    const clean = lines.filter((l): l is string => l !== undefined && l.trim() !== '')
    if (clean.length === 0) return
    sections.push(buildSection(id, clean.join('\n'), locked))
  }

  const isExternal = input.turnId === 'external-cli'
  add('identity', [
    isExternal
      ? `Ticket ${input.ticket.id}: ${input.ticket.title}.`
      : `You are the executor dispatched for ticket ${input.ticket.id}: ${input.ticket.title}.`,
  ])

  if (input.ticket.mandate !== undefined) {
    add('mandate', [
      isExternal
        ? `Mandate scope: ${input.ticket.mandate.scope} (strength ${input.ticket.mandate.strength}).`
        : `Your mandate covers ${input.ticket.mandate.scope} (strength ${input.ticket.mandate.strength}).`,
    ])
  }

  add('handoff', input.handoffLines ?? [])

  if (input.flow !== undefined && input.step !== undefined) {
    const idx = (input.stepIndex ?? 0) + 1
    const total = input.stepCount ?? input.flow.steps.length
    add('step', [
      `Flow "${input.flow.name}" — Step ${idx}/${total}: "${input.step.name}".`,
      input.step.goal !== undefined && input.step.goal !== '' ? `Step goal: ${input.step.goal}` : undefined,
      input.step.skills.length > 0 ? `Mounted skills: ${input.step.skills.join(', ')}.` : undefined,
    ])
  }

  add('upstream', (input.upstreamLines ?? []).length > 0
    ? ['Upstream step outputs:', ...(input.upstreamLines ?? [])]
    : [])

  add('answers', (input.answeredLines ?? []).length > 0
    ? ['Recent human answers / confirmations for this ticket:', ...(input.answeredLines ?? [])]
    : [])

  const mountedSkills = input.step?.skills ?? []
  const skillLines = formatSkillPromptLines(input.skills, mountedSkills)
  add('skills', skillLines)

  const wtLine = worktreeContextLine(input.worktree)
  add('worktree', wtLine === undefined ? [] : [wtLine])

  if (input.projectFacts?.agentsMd !== undefined) {
    add('projectIndex', [`Project instructions (${input.projectFacts.root}):\n${input.projectFacts.agentsMd}`])
  }

  if (input.landingFacts !== undefined) {
    add('landing', formatLandingDiscoveryPromptLines(input.landingFacts))
  }

  if (input.scratchDir !== undefined) {
    add('artifacts', [
      `Task scratch directory (store intermediate artifacts here, never pollute ${input.cwd}): ${input.scratchDir}`,
      input.readOnly
        ? `Read-only step: do NOT modify repository files in ${input.cwd}. Record review/verification findings in ${input.scratchDir}/review-report.md and test output in ${input.scratchDir}/test-report.log.`
        : `If ${input.scratchDir}/review-report.md or ${input.scratchDir}/test-report.log exists from an earlier rework, read it first and address every open finding before reporting ready.`,
    ])
  }

  // Locked deterministic boundary & tool contracts.
  const mapped = input.projectId !== undefined
  const scopeText = !mapped
    ? 'This ticket has no mapped project: analyze read-only; do not write or modify any files.'
    : input.readOnly
      ? `This ticket is mapped to project ${input.projectId}. Inspect ${input.cwd} strictly read-only against tracked files.${input.scratchDir !== undefined ? ` Write review/verification artifacts only inside ${input.scratchDir}.` : ''}`
      : `This ticket is mapped to project ${input.projectId}. Work in ${input.cwd}: edit files and run checks there; local edits and checks are pre-approved, external actions are not.`
  add('scope', [scopeText], true)

  if (!isExternal) {
    add('report', [
      'Report through the submit_report tool: progress while working, waiting when input is pending, blocked when stuck, failed when the work cannot be done, not-needed when nothing is required, ready when the work is complete.',
    ], true)
    add('ask', [
      'When the work needs the user\'s input, ask through the ask_user tool with a concrete question and end your turn; the answer arrives as your next message.',
    ], true)
    add('approval', [
      'External writes & repository landing actions (post_mr_comment, set_jira_status, local_merge_branch, push_branch, create_mr_or_pr) wait for the user\'s approval before executing — use check_branch_rebase first when landing git changes.',
    ], true)
    add('deliver', [
      'Declare final deliverable files with the present tool before reporting ready.',
    ], true)
  } else {
    add('headless', [
      'You are running in non-interactive headless CLI mode: do NOT call interactive ask_question or ask_user tools. Summarize results and any open decisions concisely in your final Markdown output.',
    ], true)
  }

  add('rework', input.reworkLines ?? [])

  const rawText = sections.map(s => s.text).join('\n\n')
  const capped = truncateUtf8Bytes(rawText, MAX_RENDERED_PROMPT_BYTES)
  return {
    text: capped.text,
    record: {
      turnId: input.turnId,
      text: capped.text,
      truncated: capped.truncated,
      sections,
      templateRevision: input.templateRevision,
      renderedAt: Date.now(),
    },
  }
}

export function buildStewardBatchEvalPrompt(input: {
  readonly items: readonly string[]
  readonly decisions: readonly string[]
  readonly portfolio: readonly string[]
  readonly repoContext: readonly string[]
  readonly flows: readonly string[]
}): string {
  const threadCount = input.items.filter(line => /^\d+\.\s+thread\s+/.test(line)).length
  const count = threadCount > 0 ? threadCount : Math.max(1, input.items.length - 1)
  return [
    `Batch-triage ${count} pending threads (Evaluate and route each item in one pass).`,
    ...input.items,
    ...input.decisions,
    ...input.portfolio,
    ...input.repoContext,
    'Dedup rule: If an incoming thread is already resolved or actively covered by a portfolio ticket above, pass action="ignore" with supersededBy="<ticketId>".',
    'Sequencing rule: When routing onto a flow, pass dependsOn=["<ticketId>"] ONLY if touching the same files/module or strictly dependent; otherwise omit dependsOn to run in parallel.',
    'Workspace rule: Respect the matched flow\'s workspaceMode ("in-place" runs directly without git worktree; "worktree" or "auto" for git edits plans repoRoot, baseBranch, feat-* branch, mergeTarget per repo AGENTS.md).',
    ...input.flows,
    'Submit every decision through record_triage_batch (passing evalId, action, strength, title, scope, rationale, optional supersededBy, and when accepting either flowId or none: true for single-step generic execution, plus optional dependsOn and worktree). You may call record_decision for individual items.',
  ].filter(Boolean).join('\n\n')
}

export function buildStewardEvalPrompt(input: {
  readonly threadId: string
  readonly evalId: string
  readonly triggers: readonly string[]
  readonly decisions: readonly string[]
  readonly portfolio: readonly string[]
}): string {
  return [
    `Evaluate the pending changes of thread ${input.threadId} (eval ${input.evalId}).`,
    ...input.triggers,
    ...input.decisions,
    ...input.portfolio,
    'Dedup rule: If this thread is already resolved or being handled by an active/recent portfolio ticket above, call record_decision with action="ignore" and supersededBy="<ticketId>".',
    'Decide through the record_decision tool: accept the work explicitly supported by the triggers, or ignore or stop it.',
  ].filter(Boolean).join('\n\n')
}

export function buildStewardRoutePrompt(input: {
  readonly ticket: TicketRecord
  readonly portfolio: readonly string[]
  readonly repoContext: readonly string[]
  readonly flows: readonly string[]
}): string {
  return [
    `Route ticket ${input.ticket.id}: "${input.ticket.title}".`,
    input.ticket.mandate === undefined ? undefined : `Mandate scope: ${input.ticket.mandate.scope}.`,
    ...input.portfolio,
    ...input.repoContext,
    'Sequencing rule: Pass dependsOn=["<ticketId>"] ONLY if this ticket conflicts with or depends on an active ticket above; otherwise leave dependsOn empty.',
    'Workspace rule: If the matched flow uses workspaceMode="in-place", set worktree.mode="in-place". For code/git edits under "worktree" or "auto", plan repoRoot, baseBranch, feat-* branch, and mergeTarget per target AGENTS.md.',
    'Available flows:',
    ...input.flows,
    'Pick the best matching flow via record_route (pass flowId), or pass none: true when no flow fits (unmatched tasks execute directly via the generic single-step fallback).',
  ].filter((l): l is string => l !== undefined && l !== '').join('\n\n')
}

export function buildStewardGatePrompt(input: {
  readonly ticket: TicketRecord
  readonly dispatchId: string
  readonly step?: FlowStepDef
  readonly reportLines: readonly string[]
}): string {
  const stepLines = input.step === undefined
    ? []
    : [
        `Step "${input.step.name}" (${input.step.id}):`,
        input.step.goal === undefined ? undefined : `Step criteria/goal: ${input.step.goal}`,
        input.step.skills.length === 0 ? undefined : `Mounted skills: ${input.step.skills.join(', ')}`,
      ].filter((v): v is string => v !== undefined)
  return [
    `Review the finished work on ticket ${input.ticket.id} (dispatch ${input.dispatchId}).`,
    ...stepLines,
    ...input.reportLines,
    'Decide through the record_review tool: pass when the step criteria/checks are satisfied and complete; otherwise record verdict="rework" with concrete missing checks or open issues.',
    'You may optionally propose a follow-up ticket via record_followup (scope may not widen parent mandate without approval).',
  ].filter(Boolean).join('\n\n')
}

export function buildStewardEndSuggestionPrompt(input: {
  readonly ticketId: string
  readonly triggerDetails: readonly string[]
}): string {
  return [
    `The external object behind ticket ${input.ticketId} may have ended.`,
    ...input.triggerDetails,
    'Suggest closing the ticket through suggest_end only if the trigger confirms it is closed/merged; otherwise call keep_open.',
  ].filter(Boolean).join('\n\n')
}
