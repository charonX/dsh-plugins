import { describe, expect, test } from 'vitest'
import {
  PROMPT_VARIABLES,
  buildPromptContext,
  findUnknownTemplateVariables,
  renderTemplate,
  validateTemplateVariables,
} from '../../src/prompt/prompt-vars.ts'
import { TURN_IDS, TURN_REGISTRY } from '../../src/prompt/prompt-sections.ts'
import { resolveSections, validateGlobalPrompts, validateScopePrompt } from '../../src/prompt/prompt-resolve.ts'
import { MAX_RENDERED_PROMPT_BYTES, renderTurn } from '../../src/prompt/prompt-render.ts'
import { formatSkillPromptLines, type DiscoveredSkill } from '../../src/dispatch/workspace-skills.ts'
import { formatLandingDiscoveryPromptLines, type ProjectLandingFacts } from '../../src/dispatch/landing-discovery.ts'
import { buildExternalCliPrompt } from '../../src/dispatch/cli-backend.ts'
import { buildPortfolioSnapshot, formatPortfolioPromptLines } from '../../src/steward/portfolio-context.ts'
import type { TicketRecord } from '../../src/board-domain.ts'
import type { CrewMember } from '../../src/crew/crew-core.ts'
import type { PipelineRecord, PipelineStage } from '../../src/pipeline/pipeline-core.ts'

describe('prompt-vars & template interpolation', () => {
  test('catalog includes all required variables and rejects unknown variables', () => {
    const names = new Set(PROMPT_VARIABLES.map(v => v.name))
    for (const required of [
      'ticket.id', 'ticket.title', 'ticket.state', 'ticket.mandate.scope', 'ticket.mandate.strength',
      'ticket.acceptanceCriteria', 'ticket.projectId', 'ticket.handoffSessionId',
      'stage.index', 'stage.count', 'stage.mode', 'stage.instruction', 'stage.skipLogic',
      'pipeline.id', 'pipeline.name', 'member.id', 'member.name', 'member.role',
      'flow.index', 'flow.stageId',
      'project.id', 'project.name', 'project.root', 'project.agentsMd', 'project.gitFlow',
      'project.verifyDocs', 'project.landingMode', 'project.baseBranch', 'project.mergeTarget',
      'skills.list', 'portfolio.lines', 'rules.lines', 'triggers.lines',
      'env.scratchDir', 'env.cwd', 'env.worktreePath', 'env.today',
    ]) {
      expect(names.has(required)).toBe(true)
    }

    expect(findUnknownTemplateVariables('Hello {{nope}} and {{ticket.id}}')).toEqual(['nope'])
    expect(() => validateTemplateVariables('executor', 'identity', 'Hello {{nope}}')).toThrow(
      'prompt turn "executor" section "identity" uses unknown variable "nope"',
    )
  })

  test('renderTemplate omits lines that become empty when variables are missing', () => {
    const res = renderTemplate('Line 1: {{ticket.id}}\n{{project.verifyDocs}}\nLine 3: static', {
      'ticket.id': 'T-1',
      'project.verifyDocs': undefined,
    })
    expect(res.text).toBe('Line 1: T-1\nLine 3: static')
    expect(res.missing).toEqual(['project.verifyDocs'])
    expect(res.unknown).toEqual([])
  })
})

describe('prompt-resolve & validation', () => {
  test('three-tier precedence resolves stage > pipeline > global > builtin and keeps locked sections immutable', () => {
    const config = {
      prompts: {
        turns: {
          executor: {
            sections: {
              identity: 'global identity',
              skills: 'global skills',
              artifacts: 'global artifacts',
            },
          },
        },
      },
    }
    const pipeline = { prompt: { sections: { skills: 'pipeline skills', artifacts: 'pipeline artifacts' } } }
    const stage = { prompt: { sections: { artifacts: 'stage artifacts' } } }

    const allThree = resolveSections('executor', { config, pipeline, stage })
    const byId = new Map(allThree.map(s => [s.id, s]))
    expect(byId.get('identity')).toMatchObject({ text: 'global identity', source: 'global' })
    expect(byId.get('skills')).toMatchObject({ text: 'pipeline skills', source: 'pipeline' })
    expect(byId.get('artifacts')).toMatchObject({ text: 'stage artifacts', source: 'stage' })
    expect(byId.get('report')?.source).toBe('builtin')
    expect(byId.get('report')?.locked).toBe(true)

    const dropStage = resolveSections('executor', { config, pipeline })
    expect(dropStage.find(s => s.id === 'artifacts')).toMatchObject({ text: 'pipeline artifacts', source: 'pipeline' })

    const dropPipeline = resolveSections('executor', { config })
    expect(dropPipeline.find(s => s.id === 'artifacts')).toMatchObject({ text: 'global artifacts', source: 'global' })

    const allBuiltin = resolveSections('executor', {})
    expect(allBuiltin.find(s => s.id === 'artifacts')?.source).toBe('builtin')
  })

  test('validation rejects unknown turns, unknown sections, locked sections, and oversized sections', () => {
    expect(() => validateGlobalPrompts({ turns: { bogus: { sections: { a: 'b' } } } })).toThrow(
      'unknown prompt turn "bogus"',
    )
    expect(() => validateGlobalPrompts({ turns: { executor: { sections: { bogus: 'b' } } } })).toThrow(
      'prompt turn "executor" has unknown section "bogus"',
    )
    expect(() => validateGlobalPrompts({ turns: { executor: { sections: { report: 'hack' } } } })).toThrow(
      'prompt section "report" is locked and cannot be overridden',
    )
    expect(() => validateScopePrompt({ sections: { scope: 'hack' } }, 'pipeline "p1"')).toThrow(
      'prompt section "scope" is locked and cannot be overridden',
    )
    expect(() => validateGlobalPrompts({ turns: { executor: { sections: { identity: 'x'.repeat(4001) } } } })).toThrow(
      /exceeds max length/,
    )
  })
})

describe('AC-0 golden parity across all 8 turns', () => {
  const now = 1_700_000_000_000

  const ticket: TicketRecord = {
    id: 'ticket-golden-1',
    title: 'Implement prompt template studio',
    state: 'todo',
    threadId: 'thread-golden-1',
    projectId: 'proj-dsh',
    externalKey: 'PROJ-101',
    mandate: {
      scope: 'Add layered prompt templates and UI editor',
      strength: 'explicit',
      policyVersion: '1',
    },
    acceptanceCriteria: 'All 8 turns render identically by default',
    handoffSessionId: 'sess-handoff-1',
    flow: {
      pipelineId: 'pipe-1',
      pipelineName: 'Feature Flow',
      stageIndex: 1,
      stageCount: 3,
    },
    worktree: {
      mode: 'worktree',
      repoRoot: '/workspace/repos/dsh',
      baseBranch: 'main',
      branch: 'feat-dsh-manager-prompt-template-studio',
      mergeTarget: 'test',
    },
    createdAt: now,
    updatedAt: now,
  }

  const member: CrewMember = {
    id: 'crew-impl',
    name: 'Implementer',
    role: 'Implement vertical slices with TDD.',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }

  const stage: PipelineStage = {
    memberId: 'crew-impl',
    instruction: 'Build prompt kernel and schema v2.',
    skippable: true,
  }

  const pipeline: PipelineRecord = {
    id: 'pipe-1',
    name: 'Feature Flow',
    stages: [
      { memberId: 'crew-impl', instruction: 'Design', skippable: false },
      stage,
      { memberId: 'crew-impl', instruction: 'Review', skippable: false, mode: 'review' },
    ],
    createdAt: now,
    updatedAt: now,
  }

  const skills: readonly DiscoveredSkill[] = [
    { name: 'tdd', description: 'Behavior-focused Red-Green-Refactor discipline', path: '.agents/skills/tdd/SKILL.md' },
    { name: 'verify', description: 'Generic app verification protocol', path: 'skills/verify/SKILL.md' },
  ]

  const landingFacts: ProjectLandingFacts = {
    repoRoot: '/workspace/repos/dsh',
    currentBranch: 'feat-dsh-manager-prompt-template-studio',
    upstreamBranch: 'origin/feat-dsh-manager-prompt-template-studio',
    originUrl: 'https://github.com/charonX/dsh-plugins.git',
    forge: 'github',
    existingBaseBranches: ['main', 'test'],
    defaultBaseBranch: 'main',
    docs: [
      {
        path: '/workspace/repos/dsh/AGENTS.md',
        scope: 'repo',
        excerpt: '# AGENTS.md\nRun ./check-plugins-against-harness.sh before merging to test.',
        mentionsLandingWorkflow: true,
      },
    ],
    deliverySkills: [
      { name: 'ship-pr', description: 'Clean up, commit, and draft PR summary', path: 'skills/ship-pr/SKILL.md' },
    ],
    hasExplicitLandingPolicy: true,
    recommendedFallback: 'remote-pr',
  }

  const cwd = '/workspace/repos/dsh/.dsh-worktrees/ticket-golden-1'
  const taskScratchDir = '/workspace/scratch/tasks/ticket-golden-1'
  const projectId = 'proj-dsh'

  const handoffLines = [
    `Acceptance criteria: ${ticket.acceptanceCriteria}`,
    `Origin discussion session: ${ticket.handoffSessionId}`,
    'Recent context from requirement discussion:',
    'user: Align on prompt studio design\nassistant: Confirmed 3-layer overrides and locked sections.',
  ]
  const stageLines = [
    'You are "Implementer", one stage of the "Feature Flow" pipeline (stage 2 of 3).',
    'Your duty: Implement vertical slices with TDD.',
    'This stage\'s instruction: Build prompt kernel and schema v2.',
  ]
  const upstreamLines = [
    '- Stage 1 (Design): Completed design doc [deliverables: /workspace/scratch/tasks/ticket-golden-1/design.md]',
  ]
  const answeredLines = [
    '- [question] Which branch should be base? => "main"',
  ]
  const worktreeLine = 'Worktree plan: mode=worktree, repoRoot=/workspace/repos/dsh, baseBranch=main, branch=feat-dsh-manager-prompt-template-studio, mergeTarget=test.'
  const landingLines = formatLandingDiscoveryPromptLines(landingFacts)
  const portfolioLines = formatPortfolioPromptLines(buildPortfolioSnapshot([ticket], { projectId, now }))
  const repoContextLines = [
    'Mapped workspace & repository context (for worktree planning):',
    '- Workspace home-repos (/workspace)',
    '  - sub-repo: /workspace/repos/dsh [doc hints: base=main, mergeTarget=test]',
  ]
  const ruleLines = [
    '- rule rule-1 → pipeline "Feature Flow" (3 stages): new feature requests',
  ]
  const decisionLines = ['- [preference] Keep PRs scoped to one plugin']

  test('all 8 turn IDs are registered and render byte-for-byte identically to legacy builders', () => {
    expect(TURN_IDS).toHaveLength(8)
    for (const id of TURN_IDS) {
      expect(TURN_REGISTRY[id].id).toBe(id)
    }

    // 1. executor
    const execCtx = buildPromptContext({
      ticket,
      pipeline,
      stage,
      member,
      projectId,
      skills,
      handoffLines,
      upstreamLines,
      answeredLines,
      worktreeLine,
      landingLines,
      landingFacts,
      cwd,
      scratchDir: taskScratchDir,
      stageMode: 'execute',
      now,
    })
    const execRendered = renderTurn('executor', execCtx, resolveSections('executor', { variants: execCtx.variants }))
    const legacyExec = [
      `You are the executor dispatched for ticket ${ticket.id}: ${ticket.title}.`,
      `Your mandate covers ${ticket.mandate!.scope} (strength ${ticket.mandate!.strength}).`,
      ...handoffLines,
      ...stageLines,
      'Upstream stage outputs:',
      ...upstreamLines,
      'Recent human answers / confirmations for this ticket (act on these directly):',
      ...answeredLines,
      ...formatSkillPromptLines(skills),
      worktreeLine,
      ...landingLines,
      `Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into ${cwd}): ${taskScratchDir}`,
      `If ${taskScratchDir}/review-report.md or ${taskScratchDir}/test-report.log exists from an earlier review/failure, read them first and resolve every open finding before reporting ready.`,
      `Save your final test/gate verification output to ${taskScratchDir}/test-report.log (and any design/repro logs to ${taskScratchDir}/).`,
      `This ticket is mapped to project ${projectId}. Work in the worktree at ${cwd}: edit files and run tests there; local edits and test runs are pre-approved, external actions are not.`,
      'Report through the submit_report tool: progress while working, waiting when input is pending, blocked when stuck, failed when the work cannot be done, not-needed when nothing is required, ready when the work is complete.',
      'When the work needs the user\'s input, ask through the ask_user tool with a concrete question and end your turn; the answer arrives as your next message.',
      'External writes & repository landing actions (post_mr_comment, set_jira_status, local_merge_branch, push_branch, create_mr_or_pr) wait for the user\'s approval before executing — use check_branch_rebase first for non-destructive baseline checks, and follow repository AGENTS.md + project-local skills (fallback: keep verified changes ready on branch and ask human if ambiguous).',
      'Declare final deliverable files with the present tool before reporting ready.',
    ].join('\n')
    expect(execRendered.text).toBe(legacyExec)

    // 2. external-cli
    const extRendered = renderTurn('external-cli', execCtx, resolveSections('external-cli', { variants: execCtx.variants }))
    const extFinal = buildExternalCliPrompt({
      candidates: [stage.instruction, ticket.mandate!.scope, ticket.title],
      bodyLines: [extRendered.text],
    })
    const legacyExt = buildExternalCliPrompt({
      candidates: [stage.instruction, ticket.mandate!.scope, ticket.title],
      bodyLines: [
        `Ticket ${ticket.id}: ${ticket.title}.`,
        `Mandate scope: ${ticket.mandate!.scope} (strength ${ticket.mandate!.strength}).`,
        ...handoffLines,
        ...stageLines,
        'Upstream stage outputs:',
        ...upstreamLines,
        'Recent human answers / confirmations for this ticket (act on these directly):',
        ...answeredLines,
        ...formatSkillPromptLines(skills),
        worktreeLine,
        ...landingLines,
        `Task scratch directory (store ALL intermediate process artifacts here — e.g. design.md, repro-red.log, test-report.log, review-report.md, verify/ — NEVER write temporary process docs into ${cwd}): ${taskScratchDir}`,
        `If ${taskScratchDir}/review-report.md or ${taskScratchDir}/test-report.log exists from an earlier review/failure, read them first and resolve every open finding before reporting ready.`,
        `Save your final test/gate verification output to ${taskScratchDir}/test-report.log (and any design/repro logs to ${taskScratchDir}/).`,
        `Work directly in the git worktree at ${cwd}. Edit files, run tests/typecheck as needed, and finish with a concise summary of changes and verification results.`,
        'You are running in non-interactive headless CLI mode: do NOT call interactive ask_question or ask_user tools. If any open decisions remain, include them concisely with your recommended defaults in your final Markdown output.',
      ],
    })
    expect(extFinal).toBe(legacyExt)

    // 3. steward.batch-eval
    const batchCtx = buildPromptContext({
      batchCount: 1,
      dataBlocks: {
        items: [
          'Items:',
          '1. thread thread-golden-1 (eval eval-1)\n- [PROJ-101] https://jira.example.com/PROJ-101 (collected 2023-11-14T22:13:20.000Z; jira issue PROJ-101 (Open))',
        ],
        decisions: ['Decision records (binding):', ...decisionLines],
        portfolio: portfolioLines,
        repoContext: repoContextLines,
        rules: ['Configured route rules:', ...ruleLines],
      },
      now,
    })
    const batchRendered = renderTurn('steward.batch-eval', batchCtx, resolveSections('steward.batch-eval'))
    expect(batchRendered.text).toBe([
      'Batch-triage 1 pending threads (Evaluate and route each item in one pass).',
      'Items:',
      '1. thread thread-golden-1 (eval eval-1)\n- [PROJ-101] https://jira.example.com/PROJ-101 (collected 2023-11-14T22:13:20.000Z; jira issue PROJ-101 (Open))',
      'Decision records (binding):',
      ...decisionLines,
      ...portfolioLines,
      ...repoContextLines,
      'Dedup / Subsumption rule: If an incoming thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, pass action="ignore" with supersededBy="<ticketId>" and explain why in rationale.',
      'Parallel vs Sequencing rule: When accepting and routing inline onto a pipeline, pass dependsOn=["<ticketId>"] ONLY if it touches the same module/files or must land after an active ticket; otherwise omit dependsOn so independent work runs in parallel.',
      'Worktree plan rule (AI Native): When accepting and routing inline, analyze which real git repoRoot is targeted, set worktree.mode ("worktree" for edits, "none" for read-only analysis), baseBranch (default "main"), a semantic branch starting with "feat-" (e.g. feat-<plugin>-<summary>), and mergeTarget per that repo\'s AGENTS.md / git-flow (e.g. "test" when configured).',
      'Configured route rules:',
      ...ruleLines,
      'Submit every decision through record_triage_batch (passing each evalId, action, strength, title, scope, rationale, optional supersededBy when ignoring, and when accepting with rules configured also ruleId or none: true plus optional dependsOn and worktree). You may alternatively call record_decision for individual evalIds.',
    ].join('\n'))

    // 4. steward.eval
    const evalCtx = buildPromptContext({
      evalId: 'eval-1',
      threadId: 'thread-golden-1',
      dataBlocks: {
        triggers: ['Triggers:', '- [PROJ-101] https://jira.example.com/PROJ-101 (collected 2023-11-14T22:13:20.000Z; jira issue PROJ-101 (Open))'],
        decisions: ['Decision records (binding):', ...decisionLines],
        portfolio: portfolioLines,
      },
      now,
    })
    expect(renderTurn('steward.eval', evalCtx, resolveSections('steward.eval')).text).toBe([
      'Evaluate the pending changes of thread thread-golden-1 (eval eval-1).',
      'Triggers:',
      '- [PROJ-101] https://jira.example.com/PROJ-101 (collected 2023-11-14T22:13:20.000Z; jira issue PROJ-101 (Open))',
      'Decision records (binding):',
      ...decisionLines,
      ...portfolioLines,
      'Dedup / Subsumption rule: If this thread/bug is already resolved or being fixed by an active or recently ended portfolio ticket, call record_decision with action="ignore" and supersededBy="<ticketId>".',
      'Decide through the record_decision tool: accept the work explicitly supported by the triggers, or ignore or stop it.',
    ].join('\n'))

    // 5. steward.route
    const routeCtx = buildPromptContext({
      ticket,
      dataBlocks: {
        portfolio: portfolioLines,
        repoContext: repoContextLines,
        rules: ruleLines,
      },
      now,
    })
    expect(renderTurn('steward.route', routeCtx, resolveSections('steward.route', { variants: routeCtx.variants })).text).toBe([
      `Route the accepted ticket ${ticket.id}: "${ticket.title}".`,
      `Its mandate covers ${ticket.mandate!.scope}.`,
      ...portfolioLines,
      ...repoContextLines,
      'Sequencing rule: If this ticket modifies the same module/files or clearly depends on an active ticket above, pass its ticket id(s) in dependsOn on record_route; otherwise leave dependsOn empty so independent work runs in parallel.',
      'Worktree plan rule (AI Native): Also fill worktree on record_route — set mode ("worktree" for code/doc edits, "none" for read-only research/review), repoRoot (exact sub-repo git root if targeting e.g. repos/<name>), baseBranch (default "main"), semantic branch starting with "feat-" (e.g. feat-<plugin>-<summary>), and mergeTarget matching that repo\'s AGENTS.md / docs/git-flow.md (e.g. "test" when specified).',
      'The configured route rules are:',
      ...ruleLines,
      'Pick the rule whose pipeline best carries this ticket through the record_route tool (pass its ruleId), or declare none fits (pass none: true) — an unmatched ticket waits for a human judgment.',
    ].join('\n'))

    // 6. steward.skip
    const skipCtx = buildPromptContext({
      ticket,
      stageIndex: 1,
      hasSkipLogic: false,
      dataBlocks: {
        context: [
          `Mandate scope: ${ticket.mandate!.scope}`,
          `Agreed acceptance criteria (already aligned with the user): ${ticket.acceptanceCriteria}`,
          `Originates from aligned discussion session: ${ticket.handoffSessionId}`,
          `The stage's member: ${member.name} (${member.role}).`,
        ],
      },
      now,
    })
    expect(renderTurn('steward.skip', skipCtx, resolveSections('steward.skip')).text).toBe([
      `Decide whether pipeline stage 2 can be skipped for ticket ${ticket.id}: "${ticket.title}".`,
      `Mandate scope: ${ticket.mandate!.scope}`,
      `Agreed acceptance criteria (already aligned with the user): ${ticket.acceptanceCriteria}`,
      `Originates from aligned discussion session: ${ticket.handoffSessionId}`,
      `The stage's member: ${member.name} (${member.role}).`,
      'The stage is marked skippable but carries no skip logic; skip it only when the mandate clearly does not need it.',
      'Decide through the decide_skip tool.',
    ].join('\n'))

    // 7. steward.review
    const reviewCtx = buildPromptContext({
      ticket,
      dispatchId: 'dispatch-golden-1',
      stageMode: 'review',
      dataBlocks: {
        reports: [
          'The executor\'s summary report:\nImplemented S1 and S2; all unit tests pass.',
          'The earlier rework opinion: Missing edge case check for empty lines.',
        ],
      },
      now,
    })
    expect(renderTurn('steward.review', reviewCtx, resolveSections('steward.review', { variants: reviewCtx.variants })).text).toBe([
      `Review the finished work on ticket ${ticket.id} (dispatch dispatch-golden-1).`,
      'The executor\'s summary report:\nImplemented S1 and S2; all unit tests pass.',
      'The earlier rework opinion: Missing edge case check for empty lines.',
      'This dispatch ran the dedicated read-only Review stage. Read its concise review report and verify from the facts reported whether review & verification actually passed (all required tests, typechecks, and gates ran and passed with zero open blocking findings). Record verdict "pass" when review is complete and all checks passed; record "rework" when any tests failed, checks were skipped, or blocking issues remain (carrying the open finding IDs, failing command outputs, and review-report.md / test-report.log paths in feedback so the implementation stage fixes them).',
      'You may propose the next step on this thread through the record_followup tool (parent ticket id, title, proposed mandate scope, rationale); its scope may only narrow the parent mandate — a wider scope waits for the user\'s approval.',
    ].join('\n'))

    // 8. steward.end-suggestion
    const endCtx = buildPromptContext({
      ticket,
      dataBlocks: {
        trigger: ['Trigger: [MR-42] merge request (merged) — https://gitlab.example.com/mr/42'],
      },
      now,
    })
    expect(renderTurn('steward.end-suggestion', endCtx, resolveSections('steward.end-suggestion')).text).toBe([
      `The external object behind ticket ${ticket.id} (thread ${ticket.threadId}) has ended.`,
      'Trigger: [MR-42] merge request (merged) — https://gitlab.example.com/mr/42',
      'Decide through the suggest_end tool whether the user should be asked to close this ticket, or keep it open through the keep_open tool.',
    ].join('\n'))
  })

  test('buildPromptContext expands template variables inside operator member.role and stage.instruction cleanly', () => {
    const ctx = buildPromptContext({
      ticket: {
        ...ticket,
        scratchDir: '/repo/.dsh-scratch/t-42',
      },
      stage: {
        memberId: 'crew-1',
        instruction: 'Write plan to {{env.scratchDir}}/design.md under {{project.root}}.\n{{project.verifyDocs}}\nKeep {{custom_literal}} intact.',
        skippable: false,
      },
      member: {
        id: 'crew-1',
        name: 'Analyst',
        role: 'Audit repo rules in {{env.worktreePath}}.\n{{project.agentsMd}}',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      projectRoot: '/repo',
      cwd: '/repo/wt',
      projectFacts: {
        root: '/repo',
        agentsMd: '# AGENTS Rules',
      },
      now,
    })
    expect(ctx.vars['member.role']).toBe('Audit repo rules in /repo/wt.\n# AGENTS Rules')
    expect(ctx.vars['stage.instruction']).toBe('Write plan to /repo/.dsh-scratch/t-42/design.md under /repo.\nKeep {{custom_literal}} intact.')
    const rendered = renderTurn('executor', ctx, resolveSections('executor', { variants: ctx.variants }))
    expect(rendered.text).toContain('Your duty: Audit repo rules in /repo/wt.\n# AGENTS Rules')
    expect(rendered.text).toContain('Write plan to /repo/.dsh-scratch/t-42/design.md under /repo.')
    expect(rendered.text).not.toContain('{{env.')
    expect(rendered.text).not.toContain('{{project.')
  })

  test('renderTurn caps output at 64 KB and marks truncated=true', () => {
    const bigCtx = buildPromptContext({
      ticket,
      dataBlocks: {
        rework: ['R'.repeat(MAX_RENDERED_PROMPT_BYTES + 2000)],
      },
      now,
    })
    const rendered = renderTurn('executor', bigCtx, resolveSections('executor', { variants: bigCtx.variants }))
    expect(rendered.truncated).toBe(true)
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(MAX_RENDERED_PROMPT_BYTES)
  })
})
