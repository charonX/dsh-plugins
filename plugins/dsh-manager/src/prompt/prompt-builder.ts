/**
 * Minimal, code-owned prompt builder for Executor sessions and Steward turns.
 * Replaces multi-tier prompt overrides with direct Skill + Goal + Locked-Contract
 * assembly while keeping full dispatched prompt snapshots on DispatchRecord.
 */
import type { TicketRecord, TicketWorktreePlan } from '../board-domain.ts'
import type { DispatchPromptRecord, DispatchPromptSectionRecord } from '../dispatch/dispatch-core.ts'
import { formatSkillPromptLines, type DiscoveredSkill } from '../dispatch/workspace-skills.ts'
import type { FlowDef, FlowStepDef } from '../flow/flow-ir.ts'

/** Hard character budget for one dispatch prompt (built-in executor and external CLI). */
export const MAX_DISPATCH_PROMPT_CHARS = 8_000

/** Coarse per-section attribution carried by {@link PromptBudgetExceededError}. */
export interface PromptSectionSize {
  readonly id: string
  readonly chars: number
}

/**
 * Raised when a dispatch prompt exceeds {@link MAX_DISPATCH_PROMPT_CHARS}.
 * Dispatch must fail loudly instead of silently truncating: a truncated prompt
 * loses its locked tool contracts and the executor then improvises.
 */
export class PromptBudgetExceededError extends Error {
  readonly chars: number
  readonly limit: number
  readonly sectionSizes: readonly PromptSectionSize[]

  constructor(chars: number, sectionSizes: readonly PromptSectionSize[]) {
    const largest = [...sectionSizes]
      .sort((left, right) => right.chars - left.chars)
      .slice(0, 4)
      .map(entry => `${entry.id}=${entry.chars}`)
      .join(', ')
    super(`dispatch prompt is ${chars} chars, over the ${MAX_DISPATCH_PROMPT_CHARS}-char budget (largest sections: ${largest})`)
    this.name = 'PromptBudgetExceededError'
    this.chars = chars
    this.limit = MAX_DISPATCH_PROMPT_CHARS
    this.sectionSizes = sectionSizes
  }
}

/** Steward-turn prompt cap (bytes); executor prompts use {@link MAX_DISPATCH_PROMPT_CHARS}. */
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
  /** Absolute path of the repo instruction file to point at (never its body). */
  readonly repoRulesPath?: string
  /**
   * Absolute path of the ticket's align card. When it exists the card carries the
   * scope and the slices, so the prompt only points at it instead of restating them.
   */
  readonly alignCardPath?: string
  readonly handoffLines?: readonly string[]
  readonly upstreamLines?: readonly string[]
  readonly answeredLines?: readonly string[]
  readonly reworkLines?: readonly string[]
  readonly templateRevision: number
}

/**
 * Fixed heading for each section id (undefined = the ticket line itself).
 * Headings are Chinese because the whole skeleton is Chinese; ticket text
 * (title, acceptance gates, human turns) stays verbatim in its own language.
 */
const SECTION_HEADINGS: Readonly<Record<string, string | undefined>> = {
  identity: undefined,
  mandate: '任务',
  handoff: '上下文',
  step: '流程',
  upstream: '上游产出',
  answers: '人类回答',
  skills: '技能',
  worktree: '环境',
  artifacts: '环境',
  repoRules: '约束',
  scope: '约束',
  report: '工具契约',
  ask: '工具契约',
  approval: '工具契约',
  deliver: '工具契约',
  headless: '工具契约',
  rework: '返工要求',
}

/**
 * Render sections under their headings, keeping section ids intact for the
 * dispatch snapshot (TicketDetail, budget attribution, tests).
 */
export function renderSectionBlocks(sections: readonly DispatchPromptSectionRecord[]): string {
  const groups: { heading: string | undefined; texts: string[] }[] = []
  for (const section of sections) {
    const heading = SECTION_HEADINGS[section.id]
    const last = groups[groups.length - 1]
    if (last !== undefined && last.heading === heading) last.texts.push(section.text)
    else groups.push({ heading, texts: [section.text] })
  }
  return groups
    .map(group => group.heading === undefined ? group.texts.join('\n') : `## ${group.heading}\n${group.texts.join('\n')}`)
    .join('\n\n')
}

function buildSection(id: string, text: string, locked: boolean): DispatchPromptSectionRecord {
  return { id, text, source: 'builtin', locked }
}

function worktreeContextLine(worktree: TicketWorktreePlan | undefined): string | undefined {
  if (worktree === undefined) return undefined
  if (worktree.mode === 'in-place') return '作业模式：就地（in-place），直接在目标目录改，不建工作树。'
  if (worktree.mode === 'none') return '作业模式：只读检查，不建工作树。'
  const parts = [
    worktree.repoRoot === undefined ? undefined : `repo=${worktree.repoRoot}`,
    worktree.baseBranch === undefined ? undefined : `base=${worktree.baseBranch}`,
    worktree.branch === undefined ? undefined : `branch=${worktree.branch}`,
    worktree.mergeTarget === undefined ? undefined : `mergeTarget=${worktree.mergeTarget}`,
  ].filter((v): v is string => v !== undefined)
  return parts.length === 0 ? undefined : `工作树：${parts.join(', ')}`
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
  add('identity', [`工单 ${input.ticket.id}：${input.ticket.title}`])

  if (input.alignCardPath !== undefined) {
    // The align card already holds scope, behaviours and slices: restating the
    // mandate in the prompt duplicates it and pushes the budget.
    add('mandate', [`按 ${input.alignCardPath} 的顺序执行；下方编号门禁即完成标准。`])
  } else if (input.ticket.mandate !== undefined) {
    add('mandate', [`范围：${input.ticket.mandate.scope}（${input.ticket.mandate.strength}）`])
  }

  add('handoff', input.handoffLines ?? [])

  if (input.flow !== undefined && input.step !== undefined) {
    const idx = (input.stepIndex ?? 0) + 1
    const total = input.stepCount ?? input.flow.steps.length
    add('step', [
      `流程「${input.flow.name}」第 ${idx}/${total} 步：「${input.step.name}」`,
      input.step.goal !== undefined && input.step.goal !== '' ? `本步目标：${input.step.goal}` : undefined,
      input.step.skills.length > 0 ? `挂载技能：${input.step.skills.join('、')}` : undefined,
    ])
  }

  add('upstream', (input.upstreamLines ?? []).length > 0
    ? ['上游产出：', ...(input.upstreamLines ?? [])]
    : [])

  add('answers', (input.answeredLines ?? []).length > 0
    ? ['人类回答与确认：', ...(input.answeredLines ?? [])]
    : [])

  const mountedSkills = input.step?.skills ?? []
  const skillLines = formatSkillPromptLines(input.skills, mountedSkills)
  add('skills', skillLines)

  const wtLine = worktreeContextLine(input.worktree)
  add('worktree', wtLine === undefined ? [] : [wtLine])

  if (input.scratchDir !== undefined) {
    add('artifacts', [
      `产出目录：${input.scratchDir}（只放过程产物，不要写进仓库）。`,
      input.readOnly
        ? `只读模式：把结论写进 ${input.scratchDir}/review-report.md 与 ${input.scratchDir}/test-report.log。`
        : `若目录里已有 review-report.md 或 test-report.log，ready 前逐条处理未关闭项。`,
    ])
  }

  if (input.repoRulesPath !== undefined) {
    // The agent reads its own repo rules: harness/Claude/Codex inject cwd AGENTS.md,
    // so inlining the body only duplicates it and burns the prompt budget.
    add('repoRules', [`仓库规则：动手前读 ${input.repoRulesPath}（正文不在这里重复）。`])
  }

  // Locked deterministic boundary & tool contracts.
  const mapped = input.projectId !== undefined
  const scopeText = !mapped
    ? '未映射项目：只分析，不修改文件。'
    : input.readOnly
      ? `在 ${input.cwd} 内只读作业，不修改任何被跟踪文件。`
      : `在 ${input.cwd} 内作业；本地编辑与自测已授权，外部动作需用户批准。`
  add('scope', [scopeText], true)

  if (!isExternal) {
    add('report', ['submit_report：progress / waiting / blocked / failed / not-needed / ready'], true)
    add('ask', ['ask_user：提出一个具体问题后结束本轮。'], true)
    add('approval', [
      '外部写与落地（local_merge_branch、push_branch、create_mr_or_pr 等）需用户批准；落地前先跑 check_branch_rebase。',
    ], true)
    add('deliver', ['present：ready 前先声明交付物。'], true)
  } else {
    add('headless', [
      '非交互 headless CLI 模式：不要调用 ask_question / ask_user 等交互工具；把结果与待决事项写进最终 Markdown 回复。',
    ], true)
  }

  add('rework', input.reworkLines ?? [])

  const sectionSizes: PromptSectionSize[] = sections.map(section => ({ id: section.id, chars: section.text.length }))
  const rawText = renderSectionBlocks(sections)
  if (rawText.length > MAX_DISPATCH_PROMPT_CHARS) {
    throw new PromptBudgetExceededError(rawText.length, sectionSizes)
  }
  return {
    text: rawText,
    record: {
      turnId: input.turnId,
      text: rawText,
      truncated: false,
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
