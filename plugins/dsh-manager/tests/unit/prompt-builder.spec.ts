/** Unit tests for the minimal Skill + Goal + Locked-Contract prompt builder. */
import { describe, expect, test } from 'vitest'
import {
  MAX_DISPATCH_PROMPT_CHARS,
  PromptBudgetExceededError,
  buildExecutorTurnPrompt,
  buildStewardGatePrompt,
  buildStewardRoutePrompt,
} from '../../src/prompt/prompt-builder.ts'
import type { TicketRecord } from '../../src/board-domain.ts'
import type { FlowDef } from '../../src/flow/flow-ir.ts'

const sampleTicket: TicketRecord = {
  id: 'ticket-1',
  title: 'Draft architecture summary',
  threadId: 'thread-1',
  projectId: 'proj-1',
  state: 'todo',
  mandate: { strength: 'explicit', scope: 'summarize docs', policyVersion: '1' },
  createdAt: 1,
  updatedAt: 1,
}

const sampleFlow: FlowDef = {
  id: 'flow-knowledge',
  name: '知识创作',
  enabled: true,
  when: '文章与笔记创作',
  workspaceMode: 'in-place',
  steps: [
    { id: 'research', name: '资料梳理', skills: ['how'], goal: '先读已有笔记', readOnly: true },
  ],
  createdAt: 1,
  updatedAt: 1,
}

const discoveredSkills = [
  { name: 'how', description: 'Explore docs read-only', path: '.dsh/skills/how/SKILL.md' },
  { name: 'tdd', description: 'Behavior TDD', path: '.dsh/skills/tdd/SKILL.md' },
]

describe('prompt-builder', () => {
  test('places mounted skills first, enforces readOnly scope, and locks tool contracts', () => {
    const step = sampleFlow.steps[0]!
    const out = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      flow: sampleFlow,
      step,
      stepIndex: 0,
      stepCount: 1,
      projectId: 'proj-1',
      cwd: '/tmp/knowledge',
      skills: discoveredSkills,
      scratchDir: '/tmp/scratch/t1',
      readOnly: true,
      worktree: { mode: 'in-place' },
      repoRulesPath: '/tmp/knowledge/AGENTS.md',
      templateRevision: 3,
    })

    expect(out.text).toContain('流程「知识创作」第 1/1 步：「资料梳理」')
    expect(out.text).toContain('挂载技能：how')
    expect(out.text).toContain('Required step skills')
    expect(out.text).toContain('作业模式：就地（in-place）')
    expect(out.text).toContain('在 /tmp/knowledge 内只读作业')
    expect(out.text).toContain('/tmp/scratch/t1/review-report.md')
    expect(out.text).toContain('submit_report')
    expect(out.record.sections.filter(s => s.locked).map(s => s.id)).toEqual(['scope', 'report', 'ask', 'approval', 'deliver'])
  })

  test('renders fixed Chinese headings in one deterministic order', () => {
    const out = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      cwd: '/tmp/knowledge',
      skills: [],
      readOnly: false,
      scratchDir: '/tmp/scratch/t1',
      alignCardPath: '/tmp/scratch/t1/align-card.md',
      repoRulesPath: '/tmp/knowledge/AGENTS.md',
      worktree: { mode: 'worktree', repoRoot: '/tmp/repos/knowledge', baseBranch: 'main', branch: 'feat-x', mergeTarget: 'test' },
      templateRevision: 3,
    })

    const headings = out.text.split('\n').filter(line => line.startsWith('## '))
    expect(headings).toEqual(['## 任务', '## 环境', '## 约束', '## 工具契约'])
    expect(out.text).toContain('工作树：repo=/tmp/repos/knowledge, base=main, branch=feat-x, mergeTarget=test')
    expect(out.text).toContain('产出目录：/tmp/scratch/t1（只放过程产物，不要写进仓库）')
    expect(out.text).toContain('submit_report：progress / waiting / blocked / failed / not-needed / ready')
  })

  test('points at the align card instead of restating the mandate', () => {
    const out = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      cwd: '/tmp/knowledge',
      skills: [],
      readOnly: false,
      scratchDir: '/tmp/scratch/t1',
      alignCardPath: '/tmp/scratch/t1/align-card.md',
      repoRulesPath: '/tmp/knowledge/AGENTS.md',
      templateRevision: 3,
    })

    expect(out.text).toContain('按 /tmp/scratch/t1/align-card.md 的顺序执行')
    expect(out.text).not.toContain('summarize docs')
    expect(out.record.sections.map(s => s.id)).not.toContain('landing')
  })

  test('points at repo rules instead of inlining the doc body', () => {
    const out = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      cwd: '/tmp/knowledge',
      skills: [],
      readOnly: false,
      repoRulesPath: '/tmp/knowledge/AGENTS.md',
      templateRevision: 3,
    })

    expect(out.text).toContain('仓库规则：动手前读 /tmp/knowledge/AGENTS.md')
    expect(out.text).not.toContain('Project instructions')
    expect(out.record.sections.map(s => s.id)).not.toContain('projectIndex')
  })

  test('lists only step-mounted skills and omits the section entirely otherwise', () => {
    const step = sampleFlow.steps[0]!
    const withStep = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      flow: sampleFlow,
      step,
      stepIndex: 0,
      stepCount: 1,
      cwd: '/tmp/knowledge',
      skills: discoveredSkills,
      readOnly: true,
      templateRevision: 3,
    })
    expect(withStep.text).toContain('- how (')
    expect(withStep.text).not.toContain('tdd')
    expect(withStep.text).not.toContain('Other available skills')

    const withoutStep = buildExecutorTurnPrompt({
      turnId: 'executor',
      ticket: sampleTicket,
      cwd: '/tmp/knowledge',
      skills: discoveredSkills,
      readOnly: false,
      templateRevision: 3,
    })
    expect(withoutStep.text).not.toContain('Available skills')
    expect(withoutStep.record.sections.map(s => s.id)).not.toContain('skills')
  })

  test('rejects an over-budget prompt instead of truncating it', () => {
    const bulky: TicketRecord = {
      ...sampleTicket,
      mandate: { strength: 'explicit', scope: 'x'.repeat(MAX_DISPATCH_PROMPT_CHARS), policyVersion: '1' },
    }
    let caught: unknown
    try {
      buildExecutorTurnPrompt({
        turnId: 'executor',
        ticket: bulky,
        cwd: '/tmp/knowledge',
        skills: [],
        readOnly: false,
        templateRevision: 3,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PromptBudgetExceededError)
    const budgetError = caught as PromptBudgetExceededError
    expect(budgetError.limit).toBe(MAX_DISPATCH_PROMPT_CHARS)
    expect(budgetError.chars).toBeGreaterThan(MAX_DISPATCH_PROMPT_CHARS)
    expect(budgetError.sectionSizes.map(entry => entry.id)).toContain('mandate')
  })

  test('builds domain-agnostic route & gate prompts', () => {
    const routePrompt = buildStewardRoutePrompt({
      ticket: sampleTicket,
      portfolio: [],
      repoContext: [],
      flows: ['- flow flow-knowledge "知识创作" (1 steps, workspace=in-place): 文章与笔记创作'],
    })
    expect(routePrompt).toContain('record_route')
    expect(routePrompt).toContain('single-step fallback')

    const gatePrompt = buildStewardGatePrompt({
      ticket: sampleTicket,
      dispatchId: 'dispatch-1',
      step: sampleFlow.steps[0]!,
      reportLines: ['The executor\'s summary report:\nall checks passed'],
    })
    expect(gatePrompt).toContain('Step criteria/goal: 先读已有笔记')
    expect(gatePrompt).toContain('record_review')
  })
})
