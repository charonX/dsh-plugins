/** Unit tests for the minimal Skill + Goal + Locked-Contract prompt builder. */
import { describe, expect, test } from 'vitest'
import { buildExecutorTurnPrompt, buildStewardGatePrompt, buildStewardRoutePrompt } from '../../src/prompt/prompt-builder.ts'
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
      skills: [
        { name: 'how', description: 'Explore docs read-only', path: '.dsh/skills/how/SKILL.md' },
        { name: 'tdd', description: 'Behavior TDD', path: '.dsh/skills/tdd/SKILL.md' },
      ],
      scratchDir: '/tmp/scratch/t1',
      readOnly: true,
      worktree: { mode: 'in-place' },
      templateRevision: 3,
    })

    expect(out.text).toContain('Flow "知识创作" — Step 1/1: "资料梳理".')
    expect(out.text).toContain('Mounted skills: how.')
    expect(out.text).toContain('Required step skills')
    expect(out.text).toContain('Workspace mode: in-place')
    expect(out.text).toContain('Inspect /tmp/knowledge strictly read-only')
    expect(out.text).toContain('/tmp/scratch/t1/prototype/')
    expect(out.text).toContain('submit_report')
    expect(out.record.sections.filter(s => s.locked).map(s => s.id)).toEqual(['scope', 'report', 'ask', 'approval', 'deliver'])
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
