/**
 * Boot-tier integration spec verifying the three lifecycle fixes:
 * 1) Manual `closeTicket` aborts active work/attentions, closes the ticket (to `ended`),
 *    and wakes waiting downstream `dependsOn` tickets.
 * 2) Pipeline handover automatically moves completed upstream stage tickets out of `todo`
 *    to `ended` without releasing downstream `dependsOn` until the final stage passes human review.
 * 3) Human confirmations (Chinese free-text Steward confirm + answered questions after dispatch exit)
 *    reliably continue execution with the human's reply in prompt context.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const lifeHome = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-boot-'))
const lifeCwd = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-cwd-'))

async function writeOverlay(home: string): Promise<string> {
  const overlayPath = join(home, 'lifecycle.patch.yml')
  await writeFile(overlayPath, [
    '- insert:',
    '    - id: dsh-manager',
    '      name: "@charonx/dsh-manager"',
    '      config:',
    '        steward:',
    '          provider: mock',
    '          model: steward-test',
    '          tickMs: 250',
    '        executor:',
    '          provider: mock',
    '          model: executor-test',
    '          maxConcurrent: 2',
    '          tickMs: 200',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(lifeCwd)}`,
    '',
  ].join('\n'))
  return overlayPath
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap((call, index) => {
      const callId = ToolCallId(`call-${index + 1}`)
      const argumentsJson = JSON.stringify(call.args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' } as StreamChunk,
        { type: 'tool-call-delta', index, id: callId, name: call.name, argumentsDelta: argumentsJson } as StreamChunk,
        { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: call.name, arguments: argumentsJson } } as StreamChunk,
      ]
    }),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class LifecycleAdapter extends LlmAdapter {
  readonly executorPrompts: string[] = []
  readonly stewardReviewTicketIds: string[] = []
  private readonly askedOnce = new Set<string>()

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    if (last === undefined) {
      for (const c of textResponse('done')) yield c
      return
    }
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) {
      for (const c of textResponse('Title')) yield c
      return
    }
    if (last.role !== 'user') {
      for (const c of textResponse('done')) yield c
      return
    }
    if (tail.includes('Review the finished work on ticket')) {
      const reviewedTicket = tail.match(/Review the finished work on ticket ([A-Za-z0-9-]+)/)?.[1]
      if (reviewedTicket !== undefined) this.stewardReviewTicketIds.push(reviewedTicket)
      const dispatchId = tail.match(/\(dispatch (dispatch-[^)]+)\)/)?.[1] ?? ''
      for (const c of toolCallsResponse([{
        name: 'record_review',
        args: { dispatchId, verdict: 'pass', feedback: 'Review complete and all tests passed.' },
      }])) yield c
      return
    }
    if (tail.includes('executor dispatched for ticket')) {
      this.executorPrompts.push(tail)
      // For the ask-and-resume test ticket: first dispatch asks a question and waits (no ready report);
      // resumed dispatch sees the human answer in prompt and reports ready.
      if (tail.includes('Need-Input Ticket') && !tail.includes('target PostgreSQL')) {
        if (!this.askedOnce.has('need-input')) {
          this.askedOnce.add('need-input')
          for (const c of toolCallsResponse([{
            name: 'ask_user',
            args: { question: 'Which DB?', details: '' },
          }])) yield c
          return
        }
      }
      if (tail.includes('Manual-Close Victim')) {
        // Stay parked on ask_user waiting while closeTicket aborts it.
        for (const c of toolCallsResponse([{
          name: 'ask_user',
          args: { question: 'Should we keep waiting?', details: '' },
        }])) yield c
        return
      }
      for (const c of toolCallsResponse([{
        name: 'submit_report',
        args: { kind: 'ready', message: '审查完成：所有测试与构建门禁均已通过，无遗留阻塞项。' },
      }])) yield c
      return
    }
    for (const c of textResponse('done')) yield c
  }
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} timeout`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

afterAll(async () => {
  for (const dir of [lifeHome, lifeCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('covers manual closeTicket, flow stage todo cleanup, and post-confirmation continuation', async () => {
  const overlayPath = await writeOverlay(lifeHome)
  const adapter = new LifecycleAdapter()
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: lifeHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerBoard')
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    const now = Date.now()
    const { flow } = await ctx.dshManagerFlow.flowAdd({
      name: 'Two Stage Flow',
      when: 'Build and review features',
      workspaceMode: 'in-place',
      steps: [
        { id: 'build', name: 'Build it', skills: [], goal: 'Implement the change' },
        { id: 'review', name: 'Review it', skills: [], goal: 'Review read-only', readOnly: true, onFail: 'build' },
      ],
    })

    // --- 1) Manual closeTicket aborts pending work and unblocks downstream ticket ---
    const victim = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Manual-Close Victim',
      scope: 'Will be manually closed',
    }, now)
    const afterVictim = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'After-Victim Task',
      scope: 'Waits on victim',
      dependsOn: [victim.id],
    }, now + 1)
    await ctx.dshManagerBoard.annotateFlow(afterVictim.id, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 1,
      stageCount: 2,
    })
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: victim.id })
    await vi.waitFor(async () => {
      const views = (await ctx.dshManagerExecutor.attentionList({ ticketId: victim.id })).attentions
      expect(views.some(v => v.status === 'pending')).toBe(true)
    }, { timeout: 15_000 })

    const closedResult = await ctx.dshManagerBoard.closeTicket({ ticketId: victim.id, reason: 'cancelled by human' })
    expect(closedResult.ticket.state).toBe('ended')
    const victimAtts = (await ctx.dshManagerExecutor.attentionList({ ticketId: victim.id })).attentions
    expect(victimAtts.every(a => a.status === 'answered')).toBe(true)
    // Downstream unblocks immediately and executes.
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: afterVictim.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // --- 2) Flow handover removes finished Stage 0 from todo while holding dependent until Stage 1 acceptance ---
    const flowRoot = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Multi-Stage Feature',
      scope: 'Build then review',
    }, now + 2)
    await ctx.dshManagerBoard.annotateFlow(flowRoot.id, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 0,
      stageCount: 2,
    })
    const flowDependent = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Depends on Multi-Stage Feature',
      scope: 'Runs after flow completes',
      dependsOn: [flowRoot.id],
    }, now + 3)
    await ctx.dshManagerBoard.annotateFlow(flowDependent.id, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 1,
      stageCount: 2,
    })
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: flowRoot.id })

    // Wait for Stage 1 to mint & finish with acceptance pending.
    let stage1Id = ''
    let acceptAttId = ''
    await vi.waitFor(async () => {
      const tickets = ctx.dshManagerBoard.ticketRecords()
      const stage1 = tickets.find(t => t.followUpOf === flowRoot.id && t.flow?.stageIndex === 1)
      expect(stage1).toBeDefined()
      stage1Id = stage1!.id
      const atts = (await ctx.dshManagerExecutor.attentionList({ ticketId: stage1Id })).attentions
      const reviewAtt = atts.find(a => a.status === 'pending' && a.kind === 'review')
      expect(reviewAtt).toBeDefined()
      acceptAttId = reviewAtt!.id
    }, { timeout: 25_000 })

    // Critical check: Stage 0 (`flowRoot`) already handed off, so it is `ended` (no longer lingering in `todo`),
    // AND because Stage 0 was an intermediate execute stage, Steward did NOT waste an LLM review turn judging it
    // (only the read-only Review stage `stage1Id` goes through Steward report review before human acceptance!).
    expect(adapter.stewardReviewTicketIds).not.toContain(flowRoot.id)
    expect(adapter.stewardReviewTicketIds).toContain(stage1Id)
    expect(ctx.dshManagerBoard.ticketView(flowRoot.id)?.state).toBe('ended')
    expect(ctx.dshManagerBoard.ticketView(flowDependent.id)?.state).toBe('todo')
    expect(ctx.dshManagerBoard.ticketView(flowDependent.id)?.waitingOn).toHaveLength(1)

    // Pass Stage 1 acceptance -> whole chain ends and `flowDependent` wakes up automatically!
    await ctx.dshManagerExecutor.answerAttention({ attentionId: acceptAttId, answer: 'approved' })
    expect(ctx.dshManagerBoard.ticketView(stage1Id)?.state).toBe('ended')
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: flowDependent.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // --- 3a) Steward confirmation answered with Chinese natural text ('确认') continues dispatch ---
    const stewardAskTicket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Steward-Asked Ticket',
      scope: 'Needs human dispatch confirmation',
    }, now + 4)
    const { askAttention } = await import('../../src/attention/attention-core.ts')
    const routeAsk = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: stewardAskTicket.id,
      dispatchId: 'steward',
      kind: 'question',
      question: `no configured route fits ticket ${stewardAskTicket.id}`,
    }, now + 5)
    await ctx.dshManagerExecutor.answerAttention({ attentionId: routeAsk.id, answer: '确认' })
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: stewardAskTicket.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // --- 3b) Question answered after dispatch session ended (e.g., restart / CLI exit) wakes a fresh resume dispatch ---
    const resumeTicket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Need-Input Ticket',
      scope: 'Ask once then continue after session ends',
    }, now + 6)
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: resumeTicket.id })
    let askId = ''
    let firstDispatchId = ''
    await vi.waitFor(async () => {
      const atts = (await ctx.dshManagerExecutor.attentionList({ ticketId: resumeTicket.id })).attentions
      const pending = atts.find(a => a.status === 'pending' && a.question === 'Which DB?')
      expect(pending).toBeDefined()
      askId = pending!.id
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: resumeTicket.id })).dispatches
      expect(dispatches[0]).toBeDefined()
      firstDispatchId = dispatches[0]!.id
    }, { timeout: 20_000 })
    // Simulate session / headless CLI exiting after raising the question before the user answers.
    await ctx.dshManagerExecutor.dispatchCancel({ dispatchId: firstDispatchId })
    // Human answers -> automatically wakes a fresh dispatch carrying the human's answer!
    await ctx.dshManagerExecutor.answerAttention({ attentionId: askId, answer: 'target PostgreSQL' })
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: resumeTicket.id })
      expect(detail.dispatches.length).toBeGreaterThanOrEqual(2)
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // --- 4) Duplicate escalation attentions settle cleanly on answer or manual re-dispatch ---
    const escalatedRedispatch = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Escalated Redispatch Ticket',
      scope: 'Settle sibling escalations on manual re-dispatch',
    }, now + 7)
    const escA = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: escalatedRedispatch.id,
      dispatchId: 'dispatch-old-1',
      kind: 'question',
      question: `the Steward reworked ticket ${escalatedRedispatch.id} 2 times and it still falls short; decide whether to accept it or rework it yourself`,
    }, now + 8)
    const escB = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: escalatedRedispatch.id,
      dispatchId: 'dispatch-old-2',
      kind: 'question',
      question: `the Steward reworked ticket ${escalatedRedispatch.id} 2 times and it still falls short; decide whether to accept it or rework it yourself`,
    }, now + 9)
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: escalatedRedispatch.id })
    const remainingAfterRedispatch = (await ctx.dshManagerExecutor.attentionList({ ticketId: escalatedRedispatch.id })).attentions
      .filter(a => a.status === 'pending' && (a.id === escA.id || a.id === escB.id))
    expect(remainingAfterRedispatch).toHaveLength(0)
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: escalatedRedispatch.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    const escalatedConfirm = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Escalated Confirm Ticket',
      scope: 'Settle sibling escalations on confirm',
    }, now + 10)
    const escC = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: escalatedConfirm.id,
      dispatchId: 'dispatch-old-3',
      kind: 'question',
      question: `the Steward reworked ticket ${escalatedConfirm.id} 2 times and it still falls short; decide whether to accept it or rework it yourself`,
    }, now + 11)
    const escD = await askAttention(ctx.dshManagerBoard.attentionStore(), {
      ticketId: escalatedConfirm.id,
      dispatchId: 'dispatch-old-4',
      kind: 'question',
      question: `the Steward reworked ticket ${escalatedConfirm.id} 2 times and it still falls short; decide whether to accept it or rework it yourself`,
    }, now + 12)
    await ctx.dshManagerExecutor.answerAttention({ attentionId: escC.id, answer: 'confirmed' })
    const resolvedEsc = (await ctx.dshManagerExecutor.attentionList({ ticketId: escalatedConfirm.id })).attentions
      .find(a => a.id === escD.id)
    expect(resolvedEsc?.status).toBe('answered')
    expect(ctx.dshManagerBoard.ticketView(escalatedConfirm.id)?.state).toBe('ended')
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
