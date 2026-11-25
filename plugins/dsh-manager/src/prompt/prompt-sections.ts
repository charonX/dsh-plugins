/**
 * Built-in prompt section registry: authoritative section ordering, default
 * texts, variants, locked contract flags, and system data-block anchors for all
 * 8 turns (executor, external-cli, and 6 Steward turns).
 */
export const TURN_IDS = [
  'executor',
  'external-cli',
  'steward.batch-eval',
  'steward.eval',
  'steward.route',
  'steward.skip',
  'steward.review',
  'steward.end-suggestion',
] as const

export type TurnId = (typeof TURN_IDS)[number]

/** Locked contract sections that cannot be overridden at any layer. */
export const LOCKED_SECTION_IDS = new Set([
  'scope',
  'report',
  'ask',
  'approval',
  'deliver',
  'headless',
  'tool',
])

export type ConditionalFlagKey =
  | 'hasMandate'
  | 'hasHandoff'
  | 'hasFlow'
  | 'hasUpstream'
  | 'hasAnswers'
  | 'hasSkills'
  | 'hasWorktree'
  | 'hasLanding'
  | 'hasArtifacts'
  | 'noSkipLogic'

export interface PromptSectionDef {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly defaultText: string
  readonly locked: boolean
  readonly variants?: Readonly<Record<string, string>>
  readonly conditionalOn?: ConditionalFlagKey
}

export interface PromptDataBlockDef {
  readonly id: string
  readonly label: string
  readonly description: string
}

export type PromptTurnEntry =
  | { readonly kind: 'section'; readonly id: string }
  | { readonly kind: 'dataBlock'; readonly id: string }

export interface PromptTurnDef {
  readonly id: TurnId
  readonly label: string
  readonly description: string
  readonly scopeConfigurable: boolean
  readonly sections: readonly PromptSectionDef[]
  readonly dataBlocks: readonly PromptDataBlockDef[]
  readonly entries: readonly PromptTurnEntry[]
}

const EXECUTOR_SHARED_SECTIONS: Record<string, PromptSectionDef> = {
  mandate: {
    id: 'mandate',
    label: 'Mandate',
    description: 'Ticket mandate scope and strength',
    defaultText: 'Your mandate covers {{ticket.mandate.scope}} (strength {{ticket.mandate.strength}}).',
    locked: false,
    conditionalOn: 'hasMandate',
  },
  handoff: {
    id: 'handoff',
    label: 'Handoff Context',
    description: 'Acceptance criteria and originating discussion excerpt',
    defaultText: '{{handoff.lines}}',
    locked: false,
    conditionalOn: 'hasHandoff',
  },
  stage: {
    id: 'stage',
    label: 'Stage Identity & Instruction',
    description: 'Assigned crew member, duty prompt, and stage instruction',
    defaultText: [
      'You are "{{member.name}}", one stage of the "{{pipeline.name}}" pipeline (stage {{stage.index}} of {{stage.count}}).',
      'Your duty: {{member.role}}',
      'This stage\'s instruction: {{stage.instruction}}',
    ].join('\n'),
    variants: {
      default: [
        'You are "{{member.name}}", one stage of the "{{pipeline.name}}" pipeline (stage {{stage.index}} of {{stage.count}}).',
        'Your duty: {{member.role}}',
        'This stage\'s instruction: {{stage.instruction}}',
      ].join('\n'),
      'no-instruction': [
        'You are "{{member.name}}", one stage of the "{{pipeline.name}}" pipeline (stage {{stage.index}} of {{stage.count}}).',
        'Your duty: {{member.role}}',
      ].join('\n'),
    },
    locked: false,
    conditionalOn: 'hasFlow',
  },
  upstream: {
    id: 'upstream',
    label: 'Upstream Stage Outputs',
    description: 'Completed upstream pipeline stage summaries and deliverables',
    defaultText: 'Upstream stage outputs:\n{{upstream.lines}}',
    locked: false,
    conditionalOn: 'hasUpstream',
  },
  answers: {
    id: 'answers',
    label: 'Human Answers',
    description: 'Recent answered attentions/confirmations on this ticket',
    defaultText: 'Recent human answers / confirmations for this ticket (act on these directly):\n{{answers.lines}}',
    locked: false,
    conditionalOn: 'hasAnswers',
  },
  skills: {
    id: 'skills',
    label: 'Workspace Skills',
    description: 'Discovered SKILL.md references in workspace and ancestors',
    defaultText: 'Workspace skills available (read matching SKILL.md when relevant):\n{{skills.list}}',
    locked: false,
    conditionalOn: 'hasSkills',
  },
  worktree: {
    id: 'worktree',
    label: 'Worktree Plan',
    description: 'Resolved git worktree mode, repoRoot, branches, and mergeTarget',
    defaultText: '{{worktree.line}}',
    locked: false,
    conditionalOn: 'hasWorktree',
  },
  landing: {
    id: 'landing',
    label: 'Landing Discovery',
    description: 'Dynamically probed repository docs, remotes, and delivery skills',
    defaultText: '{{landing.lines}}',
    locked: false,
    conditionalOn: 'hasLanding',
  },
  artifacts: {
    id: 'artifacts',
    label: 'Artifacts & Review Protocol',
    description: 'Task scratch directory and execute/review verification log conventions',
    defaultText: [
      'Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into {{env.cwd}}): {{env.scratchDir}}',
      'If {{env.scratchDir}}/review-report.md or {{env.scratchDir}}/test-report.log exists from an earlier review/failure, read them first and resolve every open finding before reporting ready.',
      'Save your final test/gate verification output to {{env.scratchDir}}/test-report.log (and any design/repro logs to {{env.scratchDir}}/).',
    ].join('\n'),
    variants: {
      execute: [
        'Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into {{env.cwd}}): {{env.scratchDir}}',
        'If {{env.scratchDir}}/review-report.md or {{env.scratchDir}}/test-report.log exists from an earlier review/failure, read them first and resolve every open finding before reporting ready.',
        'Save your final test/gate verification output to {{env.scratchDir}}/test-report.log (and any design/repro logs to {{env.scratchDir}}/).',
      ].join('\n'),
      review: [
        'Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into {{env.cwd}}): {{env.scratchDir}}',
        'Strictly READ-ONLY Review stage: do NOT edit or commit business source files or test files in {{env.cwd}}.',
        'Cumulative Review Fact File: {{env.scratchDir}}/review-report.md. On Round 1 (file absent), record baseSha (current git HEAD), Spec & Standards findings numbered F-01, F-02, ... with exact file:line, and Proven Failures. On Round 2+ (file present), run an INCREMENTAL review: verify previously open findings against git diff <prevSha>..HEAD and {{env.scratchDir}}/test-report.log, and inspect ONLY the incremental diff for new regressions (do NOT re-open already-cleared code or invent new stylistic nitpicks outside the incremental diff).',
        'Run all required checks and tests, write raw output tail to {{env.scratchDir}}/test-report.log, update {{env.scratchDir}}/review-report.md, and submit a concise review report summarizing: overall conclusion (passed or needs fixes), actual tests/gates run and their results, any open blocking issues (F-xx with file:line), and paths to review-report.md and test-report.log.',
      ].join('\n'),
    },
    locked: false,
    conditionalOn: 'hasArtifacts',
  },
}

export const TURN_REGISTRY: Readonly<Record<TurnId, PromptTurnDef>> = {
  executor: {
    id: 'executor',
    label: 'Built-in Executor Envelope',
    description: 'Prompt envelope sent to built-in DSH Executor sessions',
    scopeConfigurable: true,
    sections: [
      {
        id: 'identity',
        label: 'Executor Identity',
        description: 'Opening ticket identity line',
        defaultText: 'You are the executor dispatched for ticket {{ticket.id}}: {{ticket.title}}.',
        locked: false,
      },
      EXECUTOR_SHARED_SECTIONS.mandate!,
      EXECUTOR_SHARED_SECTIONS.handoff!,
      EXECUTOR_SHARED_SECTIONS.stage!,
      EXECUTOR_SHARED_SECTIONS.upstream!,
      EXECUTOR_SHARED_SECTIONS.answers!,
      EXECUTOR_SHARED_SECTIONS.skills!,
      EXECUTOR_SHARED_SECTIONS.worktree!,
      EXECUTOR_SHARED_SECTIONS.landing!,
      EXECUTOR_SHARED_SECTIONS.artifacts!,
      {
        id: 'scope',
        label: 'Project & Sandbox Scope',
        description: 'Locked workspace write/read-only boundary contract',
        defaultText: 'This ticket is mapped to project {{project.id}}. Work in the worktree at {{env.cwd}}: edit files and run tests there; local edits and test runs are pre-approved, external actions are not.',
        variants: {
          mapped: 'This ticket is mapped to project {{project.id}}. Work in the worktree at {{env.cwd}}: edit files and run tests there; local edits and test runs are pre-approved, external actions are not.',
          unmapped: 'This ticket has no mapped project: analyze read-only; do not write or change any files.',
          review: 'This ticket is mapped to project {{project.id}}. Review the shared worktree at {{env.cwd}} read-only against source/test files, run verification commands, and write review artifacts only into {{env.scratchDir}}.',
          'review-cwd': 'This ticket is mapped to project {{project.id}}. Review the shared worktree at {{env.cwd}} read-only against source/test files, run verification commands, and write review artifacts only into {{env.cwd}}.',
        },
        locked: true,
      },
      {
        id: 'report',
        label: 'Report Contract',
        description: 'Locked submit_report tool contract',
        defaultText: 'Report through the submit_report tool: progress while working, waiting when input is pending, blocked when stuck, failed when the work cannot be done, not-needed when nothing is required, ready when the work is complete.',
        locked: true,
      },
      {
        id: 'ask',
        label: 'User Question Contract',
        description: 'Locked ask_user tool contract',
        defaultText: 'When the work needs the user\'s input, ask through the ask_user tool with a concrete question and end your turn; the answer arrives as your next message.',
        locked: true,
      },
      {
        id: 'approval',
        label: 'External Write & Landing Approval',
        description: 'Locked approval gate & check_branch_rebase requirement',
        defaultText: 'External writes & repository landing actions (post_mr_comment, set_jira_status, local_merge_branch, push_branch, create_mr_or_pr) wait for the user\'s approval before executing — use check_branch_rebase first for non-destructive baseline checks, and follow repository AGENTS.md + project-local skills (fallback: keep verified changes ready on branch and ask human if ambiguous).',
        locked: true,
      },
      {
        id: 'deliver',
        label: 'Deliverable Declaration',
        description: 'Locked present tool requirement before reporting ready',
        defaultText: 'Declare final deliverable files with the present tool before reporting ready.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'rework', label: 'Rework Feedback', description: 'Appended when re-dispatching after Steward/human rework' },
    ],
    entries: [
      { kind: 'section', id: 'identity' },
      { kind: 'section', id: 'mandate' },
      { kind: 'section', id: 'handoff' },
      { kind: 'section', id: 'stage' },
      { kind: 'section', id: 'upstream' },
      { kind: 'section', id: 'answers' },
      { kind: 'section', id: 'skills' },
      { kind: 'section', id: 'worktree' },
      { kind: 'section', id: 'landing' },
      { kind: 'section', id: 'artifacts' },
      { kind: 'section', id: 'scope' },
      { kind: 'section', id: 'report' },
      { kind: 'section', id: 'ask' },
      { kind: 'section', id: 'approval' },
      { kind: 'section', id: 'deliver' },
      { kind: 'dataBlock', id: 'rework' },
    ],
  },

  'external-cli': {
    id: 'external-cli',
    label: 'External CLI Envelope',
    description: 'Prompt envelope sent to headless external CLIs (claude-code, codex, agy, cursor, pi)',
    scopeConfigurable: true,
    sections: [
      {
        id: 'identity',
        label: 'Ticket Identity',
        description: 'Opening ticket identity line',
        defaultText: 'Ticket {{ticket.id}}: {{ticket.title}}.',
        locked: false,
      },
      {
        id: 'mandate',
        label: 'Mandate',
        description: 'Ticket mandate scope and strength',
        defaultText: 'Mandate scope: {{ticket.mandate.scope}} (strength {{ticket.mandate.strength}}).',
        locked: false,
        conditionalOn: 'hasMandate',
      },
      EXECUTOR_SHARED_SECTIONS.handoff!,
      EXECUTOR_SHARED_SECTIONS.stage!,
      EXECUTOR_SHARED_SECTIONS.upstream!,
      EXECUTOR_SHARED_SECTIONS.answers!,
      EXECUTOR_SHARED_SECTIONS.skills!,
      EXECUTOR_SHARED_SECTIONS.worktree!,
      EXECUTOR_SHARED_SECTIONS.landing!,
      EXECUTOR_SHARED_SECTIONS.artifacts!,
      {
        id: 'scope',
        label: 'Workspace Scope',
        description: 'Locked headless CLI read-only/worktree boundary',
        defaultText: 'Work directly in the git worktree at {{env.cwd}}. Edit files, run tests/typecheck as needed, and finish with a concise summary of changes and verification results.',
        variants: {
          mapped: 'Work directly in the git worktree at {{env.cwd}}. Edit files, run tests/typecheck as needed, and finish with a concise summary of changes and verification results.',
          unmapped: 'This ticket has no mapped project: analyze read-only; do not modify any files.',
          review: 'Inspect the shared git worktree at {{env.cwd}} (read-only against source/test files), run full tests/verification gates, and finish with a concise review summary covering test results, blocking findings (if any), and review-report.md / test-report.log paths.',
          'review-cwd': 'Inspect the shared git worktree at {{env.cwd}} (read-only against source/test files), run full tests/verification gates, and finish with a concise review summary covering test results, blocking findings (if any), and review-report.md / test-report.log paths.',
        },
        locked: true,
      },
      {
        id: 'headless',
        label: 'Non-interactive Headless Constraint',
        description: 'Locked ban on interactive blocking question tools',
        defaultText: 'You are running in non-interactive headless CLI mode: do NOT call interactive ask_question or ask_user tools. If any open decisions remain, include them concisely with your recommended defaults in your final Markdown output.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'rework', label: 'Rework Feedback', description: 'Appended when re-dispatching after Steward/human rework' },
    ],
    entries: [
      { kind: 'section', id: 'identity' },
      { kind: 'section', id: 'mandate' },
      { kind: 'section', id: 'handoff' },
      { kind: 'section', id: 'stage' },
      { kind: 'section', id: 'upstream' },
      { kind: 'section', id: 'answers' },
      { kind: 'section', id: 'skills' },
      { kind: 'section', id: 'worktree' },
      { kind: 'section', id: 'landing' },
      { kind: 'section', id: 'artifacts' },
      { kind: 'section', id: 'scope' },
      { kind: 'section', id: 'headless' },
      { kind: 'dataBlock', id: 'rework' },
    ],
  },

  'steward.batch-eval': {
    id: 'steward.batch-eval',
    label: 'Steward: Batch Eval & Route',
    description: 'Multi-thread batch triage & inline routing turn',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'Batch Header',
        description: 'Opening instruction for batch triage',
        defaultText: 'Batch-triage {{batch.count}} pending threads (Evaluate and route each item in one pass).',
        locked: false,
      },
      {
        id: 'dedup',
        label: 'Dedup / Subsumption Rule',
        description: 'Guidance for ignoring threads already covered by portfolio tickets',
        defaultText: 'Dedup / Subsumption rule: If an incoming thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, pass action="ignore" with supersededBy="<ticketId>" and explain why in rationale.',
        locked: false,
      },
      {
        id: 'scheduling',
        label: 'Parallel vs Sequencing Rule',
        description: 'Guidance for setting dependsOn on conflicting work',
        defaultText: 'Parallel vs Sequencing rule: When accepting and routing inline onto a pipeline, pass dependsOn=["<ticketId>"] ONLY if it touches the same module/files or must land after an active ticket; otherwise omit dependsOn so independent work runs in parallel.',
        locked: false,
      },
      {
        id: 'worktree',
        label: 'Worktree Plan Rule',
        description: 'AI-native guidance for target repoRoot, branch, and mergeTarget',
        defaultText: 'Worktree plan rule (AI Native): When accepting and routing inline, analyze which real git repoRoot is targeted, set worktree.mode ("worktree" for edits, "none" for read-only analysis), baseBranch (default "main"), a semantic branch starting with "feat-" (e.g. feat-<plugin>-<summary>), and mergeTarget per that repo\'s AGENTS.md / git-flow (e.g. "test" when configured).',
        locked: false,
      },
      {
        id: 'tool',
        label: 'Batch Triage Tool Contract',
        description: 'Locked record_triage_batch / record_decision tool contract',
        defaultText: 'Submit every decision through record_triage_batch (passing each evalId, action, strength, title, scope, rationale, optional supersededBy when ignoring, and when accepting with rules configured also ruleId or none: true plus optional dependsOn and worktree). You may alternatively call record_decision for individual evalIds.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'items', label: 'Pending Threads', description: 'Thread & trigger items' },
      { id: 'decisions', label: 'Decision Records', description: 'Binding Policy decision records' },
      { id: 'portfolio', label: 'Portfolio Context', description: 'Active & recently ended tickets' },
      { id: 'repoContext', label: 'Workspace & Sub-repos', description: 'Mapped workspace & sub-repo hints' },
      { id: 'rules', label: 'Configured Route Rules', description: 'Active route rules' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'items' },
      { kind: 'dataBlock', id: 'decisions' },
      { kind: 'dataBlock', id: 'portfolio' },
      { kind: 'dataBlock', id: 'repoContext' },
      { kind: 'section', id: 'dedup' },
      { kind: 'section', id: 'scheduling' },
      { kind: 'section', id: 'worktree' },
      { kind: 'dataBlock', id: 'rules' },
      { kind: 'section', id: 'tool' },
    ],
  },

  'steward.eval': {
    id: 'steward.eval',
    label: 'Steward: Single Eval',
    description: 'Single-thread trigger evaluation turn',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'Eval Header',
        description: 'Opening thread evaluation instruction',
        defaultText: 'Evaluate the pending changes of thread {{thread.id}} (eval {{eval.id}}).',
        locked: false,
      },
      {
        id: 'dedup',
        label: 'Dedup / Subsumption Rule',
        description: 'Guidance for ignoring threads covered by portfolio tickets',
        defaultText: 'Dedup / Subsumption rule: If this thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, call record_decision with action="ignore" and supersededBy="<ticketId>".',
        locked: false,
      },
      {
        id: 'tool',
        label: 'Decision Tool Contract',
        description: 'Locked record_decision tool contract',
        defaultText: 'Decide through the record_decision tool: accept the work explicitly supported by the triggers, or ignore or stop it.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'triggers', label: 'Triggers', description: 'Trigger details in batch' },
      { id: 'decisions', label: 'Decision Records', description: 'Binding Policy decision records' },
      { id: 'portfolio', label: 'Portfolio Context', description: 'Active & recently ended tickets' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'triggers' },
      { kind: 'dataBlock', id: 'decisions' },
      { kind: 'dataBlock', id: 'portfolio' },
      { kind: 'section', id: 'dedup' },
      { kind: 'section', id: 'tool' },
    ],
  },

  'steward.route': {
    id: 'steward.route',
    label: 'Steward: Route Ticket',
    description: 'Pipeline routing & worktree planning turn for an accepted ticket',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'Route Header',
        description: 'Ticket title and mandate header',
        defaultText: [
          'Route the accepted ticket {{ticket.id}}: "{{ticket.title}}".',
          'Its mandate covers {{ticket.mandate.scope}}.',
        ].join('\n'),
        variants: {
          'with-mandate': [
            'Route the accepted ticket {{ticket.id}}: "{{ticket.title}}".',
            'Its mandate covers {{ticket.mandate.scope}}.',
          ].join('\n'),
          'no-mandate': 'Route the accepted ticket {{ticket.id}}: "{{ticket.title}}".',
        },
        locked: false,
      },
      {
        id: 'sequencing',
        label: 'Sequencing Rule',
        description: 'Guidance for setting dependsOn across conflicting tickets',
        defaultText: 'Sequencing rule: If this ticket modifies the same module/files or clearly depends on an active ticket above, pass its ticket id(s) in dependsOn on record_route; otherwise leave dependsOn empty so independent work runs in parallel.',
        locked: false,
      },
      {
        id: 'worktree',
        label: 'Worktree Plan Rule',
        description: 'AI-native guidance for repoRoot, baseBranch, branch, and mergeTarget',
        defaultText: 'Worktree plan rule (AI Native): Also fill worktree on record_route — set mode ("worktree" for code/doc edits, "none" for read-only research/review), repoRoot (exact sub-repo git root if targeting e.g. repos/<name>), baseBranch (default "main"), semantic branch starting with "feat-" (e.g. feat-<plugin>-<summary>), and mergeTarget matching that repo\'s AGENTS.md / docs/git-flow.md (e.g. "test" when specified).',
        locked: false,
      },
      {
        id: 'rulesIntro',
        label: 'Route Rules Intro',
        description: 'Lead-in line before the configured route rules list',
        defaultText: 'The configured route rules are:',
        locked: false,
      },
      {
        id: 'tool',
        label: 'Route Tool Contract',
        description: 'Locked record_route tool contract',
        defaultText: 'Pick the rule whose pipeline best carries this ticket through the record_route tool (pass its ruleId), or declare none fits (pass none: true) — an unmatched ticket waits for a human judgment.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'portfolio', label: 'Portfolio Context', description: 'Active & recently ended tickets' },
      { id: 'repoContext', label: 'Workspace & Sub-repos', description: 'Mapped workspace & sub-repo hints' },
      { id: 'rules', label: 'Configured Route Rules', description: 'Active route rules' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'portfolio' },
      { kind: 'dataBlock', id: 'repoContext' },
      { kind: 'section', id: 'sequencing' },
      { kind: 'section', id: 'worktree' },
      { kind: 'section', id: 'rulesIntro' },
      { kind: 'dataBlock', id: 'rules' },
      { kind: 'section', id: 'tool' },
    ],
  },

  'steward.skip': {
    id: 'steward.skip',
    label: 'Steward: Skip Stage Decision',
    description: 'Decides whether a skippable pipeline stage may be skipped',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'Skip Header',
        description: 'Stage number and ticket header',
        defaultText: 'Decide whether pipeline stage {{stage.index}} can be skipped for ticket {{ticket.id}}: "{{ticket.title}}".',
        locked: false,
      },
      {
        id: 'criteria',
        label: 'Default Conservative Criteria',
        description: 'Fallback criteria used when the stage carries no skipLogic',
        defaultText: 'The stage is marked skippable but carries no skip logic; skip it only when the mandate clearly does not need it.',
        locked: false,
        conditionalOn: 'noSkipLogic',
      },
      {
        id: 'tool',
        label: 'Skip Tool Contract',
        description: 'Locked decide_skip tool contract',
        defaultText: 'Decide through the decide_skip tool.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'context', label: 'Stage & Ticket Context', description: 'Mandate scope, acceptance criteria, handoff session, member, and skipLogic' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'context' },
      { kind: 'section', id: 'criteria' },
      { kind: 'section', id: 'tool' },
    ],
  },

  'steward.review': {
    id: 'steward.review',
    label: 'Steward: Dispatch Review',
    description: 'Evaluates completed executor dispatch report and optionally proposes follow-up',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'Review Header',
        description: 'Ticket and dispatch identifier header',
        defaultText: 'Review the finished work on ticket {{ticket.id}} (dispatch {{dispatch.id}}).',
        locked: false,
      },
      {
        id: 'criteria',
        label: 'Review Verdict Criteria',
        description: 'Pass/rework criteria for review vs standard execution stages',
        defaultText: 'Decide through the record_review tool: pass when the work is verified and complete (ready for human acceptance), otherwise rework with concrete missing checks or issues.',
        variants: {
          default: 'Decide through the record_review tool: pass when the work is verified and complete (ready for human acceptance), otherwise rework with concrete missing checks or issues.',
          review: 'This dispatch ran the dedicated read-only Review stage. Read its concise review report and verify from the facts reported whether review & verification actually passed (all required tests, typechecks, and gates ran and passed with zero open blocking findings). Record verdict "pass" when review is complete and all checks passed; record "rework" when any tests failed, checks were skipped, or blocking issues remain (carrying the open finding IDs, failing command outputs, and review-report.md / test-report.log paths in feedback so the implementation stage fixes them).',
        },
        locked: false,
      },
      {
        id: 'followup',
        label: 'Follow-up Proposal',
        description: 'Guidance for proposing a follow-up ticket via record_followup',
        defaultText: 'You may propose the next step on this thread through the record_followup tool (parent ticket id, title, proposed mandate scope, rationale); its scope may only narrow the parent mandate — a wider scope waits for the user\'s approval.',
        locked: false,
      },
    ],
    dataBlocks: [
      { id: 'reports', label: 'Executor Report & Prior Rework', description: 'Ready summary report and previous rework opinion' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'reports' },
      { kind: 'section', id: 'criteria' },
      { kind: 'section', id: 'followup' },
    ],
  },

  'steward.end-suggestion': {
    id: 'steward.end-suggestion',
    label: 'Steward: End Suggestion',
    description: 'Suggests closing a ticket when its external object ended',
    scopeConfigurable: false,
    sections: [
      {
        id: 'header',
        label: 'End Suggestion Header',
        description: 'Ticket and thread ended-object notice',
        defaultText: 'The external object behind ticket {{ticket.id}} (thread {{thread.id}}) has ended.',
        locked: false,
      },
      {
        id: 'tool',
        label: 'End Suggestion Tool Contract',
        description: 'Locked suggest_end / keep_open tool contract',
        defaultText: 'Decide through the suggest_end tool whether the user should be asked to close this ticket, or keep it open through the keep_open tool.',
        locked: true,
      },
    ],
    dataBlocks: [
      { id: 'trigger', label: 'Trigger Details', description: 'External trigger key, summary, and URL' },
    ],
    entries: [
      { kind: 'section', id: 'header' },
      { kind: 'dataBlock', id: 'trigger' },
      { kind: 'section', id: 'tool' },
    ],
  },
}

/** Valid section IDs accepted on pipeline-level and stage-level `prompt.sections`. */
export const SCOPE_CONFIGURABLE_SECTION_IDS: ReadonlySet<string> = new Set([
  ...TURN_REGISTRY.executor.sections.map(s => s.id),
  ...TURN_REGISTRY['external-cli'].sections.map(s => s.id),
])

export function isTurnId(value: string): value is TurnId {
  return (TURN_IDS as readonly string[]).includes(value)
}

export function getTurnDef(turnId: TurnId): PromptTurnDef {
  return TURN_REGISTRY[turnId]
}
