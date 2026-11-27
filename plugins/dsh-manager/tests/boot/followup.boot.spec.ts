/**
 * Main-seam spec for follow-up tickets and mandate inheritance (spec
 * stories 61–63): the Steward proposes a follow-up while reviewing — an
 * equal-or-narrower scope mints the ticket directly under the inherited
 * mandate, and a widened scope first mints a mandate-expansion Approval;
 * only the human's approval mints it, a rejection leaves it unminted, and
 * the ticket detail shows the chain both ways.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

/** Temp roots this file created; cleaned up after the suite. */
const tempRoots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

/** One test's isolated harness home and overlay: no board state crosses tests. */
async function testHome(): Promise<string> {
  const home = await tempRoot('dsh-followup-boot-')
  const execCwd = await tempRoot('dsh-followup-cwd-')
  await writeFile(join(home, 'followup.patch.yml'), [
    '- insert:',
    '    - id: dsh-manager',
    '      name: "@charonx/dsh-manager"',
    '      config:',
    '        steward:',
    '          provider: mock',
    '          model: steward-test',
    '          tickMs: 3600000',
    '        executor:',
    '          provider: mock',
    '          model: executor-test',
    '          maxConcurrent: 1',
    '          tickMs: 3600000',
    '          turnTimeoutMs: 60000',
    `          cwd: ${JSON.stringify(execCwd)}`,
    '',
  ].join('\n'))
  return home
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

function toolCall(name: string, args: unknown, index: number): StreamChunk[] {
  const callId = ToolCallId(`call-${index + 1}`)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
  ]
}

function toolCallsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap((call, index) => toolCall(call.name, call.args, index)),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** The eval id the Steward named in the turn prompt of this request. */
function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('scripted adapter: request does not name an eval')
  return evalId
}

function stewardAccept(options: GenerateOptions): StreamChunk[] {
  return toolCallsResponse([{
    name: 'record_decision',
    args: {
      action: 'accept',
      strength: 'explicit',
      title: 'Accepted work',
      scope: 'the triggered change',
      rationale: 'the triggers support this work',
      evalId: evalIdOf(options),
    },
  }])
}

/** The script one adaptive turn plays against. */
interface FollowUpPlan {
  /** The Steward's review verdicts, consumed in review-turn order. */
  readonly reviews: { verdict: 'pass' | 'rework'; feedback: string }[]
  /** The follow-up proposals, consumed in review-turn order. */
  readonly followups: { readonly title: string; readonly scope: string }[]
  /** The executor's ready-report messages, consumed in dispatch-turn order. */
  readonly reports: string[]
}

/**
 * One adaptive turn: title probes, Steward evals and reviews, and executor
 * sessions share one adapter. A review turn plays the next planned verdict
 * and proposal, naming the parent ticket the review prompt named.
 */
function adaptiveTurn(plan: FollowUpPlan): (options: GenerateOptions) => Promise<StreamChunk[]> {
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('Review the finished work on ticket')) {
      const review = plan.reviews.shift()
      const followup = plan.followups.shift()
      const ticketId = /Review the finished work on ticket ([A-Za-z0-9-]+)/.exec(tail)?.[1]
      const calls: { name: string; args: unknown }[] = []
      if (review !== undefined) {
        calls.push({ name: 'record_review', args: { verdict: review.verdict, feedback: review.feedback, dispatchId: 'whatever the service is reviewing' } })
      }
      if (followup !== undefined && ticketId !== undefined) {
        calls.push({
          name: 'record_followup',
          args: { parentTicketId: ticketId, title: followup.title, scope: followup.scope, rationale: 'the next step on this thread' },
        })
      }
      if (calls.length === 0) return textResponse('nothing to do')
      return toolCallsResponse(calls)
    }
    if (tail.includes('工单 ticket-')) {
      const message = plan.reports.shift() ?? 'the work is done'
      return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message } }])
    }
    return textResponse('done')
  }
}

/** Scripted adapter: one adaptive function serves every model call. */
class AdaptiveAdapter extends LlmAdapter {
  constructor(private entry: (options: GenerateOptions) => Promise<StreamChunk[]>) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of await this.entry(options)) yield chunk
  }
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} did not become ready within ${timeoutMs}ms`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

async function awaitReady(ctx: Context, ticketId: string): Promise<void> {
  await vi.waitFor(async () => {
    const view = (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches[0]
    expect(view?.state).toBe('ended')
    expect(view?.outcome).toBe('ready')
  }, { timeout: 15_000 })
}

/** One ticket's pending attention of one kind, once it appears. */
async function pendingAttentionOf(ctx: Context, ticketId: string, kind: 'approval'): Promise<{ id: string; kind: string; question: string; action?: { category: string; tool: string; payload: unknown } | undefined }> {
  let found: { id: string; kind: string; question: string; action?: { category: string; tool: string; payload: unknown } | undefined } | undefined
  let lastViews: readonly { kind: string; status: string; question: string }[] = []
  await vi.waitFor(async () => {
    const views = (await ctx.dshManagerExecutor.attentionList({ ticketId })).attentions
    lastViews = views.map(view => ({ kind: view.kind, status: view.status, question: view.question, answer: view.answer, dispatchId: view.dispatchId }))
    const pending = views.find(view => view.status === 'pending' && view.kind === kind)
    if (pending !== undefined) found = pending
    expect(found).toBeDefined()
  }, { timeout: 15_000 }).catch((error: unknown) => {
    throw new Error(`no pending ${kind} attention; reviews: ${JSON.stringify(ctx.dshManagerBoard.reviewStore().listReviews())}; attentions: ${JSON.stringify(lastViews)}`, { cause: error })
  })
  return found!
}

async function ticketIds(ctx: Context): Promise<readonly string[]> {
  return (await ctx.dshManagerBoard.ticketList()).tickets.map(ticket => ticket.id)
}

test(
  'a same-scope follow-up mints directly under the inherited mandate, and the detail shows the chain both ways',
  async () => {
    const plan: FollowUpPlan = {
      reviews: [{ verdict: 'pass', feedback: 'meets the mandate' }],
      followups: [{ title: 'Track the pipeline result', scope: 'the triggered change' }],
      reports: ['the fix is in'],
    }
    const adapter = new AdaptiveAdapter(adaptiveTurn(plan))
    const home = await testHome()
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'followup.patch.yml')], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    await ctx.dshManagerSources.manualInput({ title: 'Fix the login flow', description: 'Investigate and fix' })
    await ctx.dshManagerSteward.runPending()
    const parent = (await ticketIds(ctx))[0]!
    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: parent })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: parent })
    }
    await awaitReady(ctx, parent)

    // The review passes and the same-scope follow-up mints directly.
    await ctx.dshManagerSteward.reviewPending()
    const ids = await ticketIds(ctx)
    expect(ids).toHaveLength(2)
    const child = ids.find(id => id !== parent)!
    const childRecord = ctx.dshManagerBoard.ticketRecord(child)
    expect(childRecord?.followUpOf).toBe(parent)
    expect(childRecord?.mandate?.scope).toBe('the triggered change')
    expect(childRecord?.mandate?.strength).toBe('explicit')
    expect(childRecord?.state).toBe('todo')
    expect(childRecord?.threadId).toBe(ctx.dshManagerBoard.ticketRecord(parent)?.threadId)

    // The chain is visible from both ends.
    const parentDetail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: parent })
    expect(parentDetail.followUps).toEqual([{ id: child, title: 'Track the pipeline result', state: 'todo' }])
    expect(parentDetail.followUpOf).toBeUndefined()
    const childDetail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: child })
    expect(childDetail.followUpOf).toEqual({ id: parent, title: 'Accepted work', state: 'todo' })
    expect(childDetail.followUps).toEqual([])

    // No approval was needed: no mandate-expansion (or any) approval on the
    // parent — the pass's acceptance Attention is the only one.
    const attentions = (await ctx.dshManagerExecutor.attentionList({ ticketId: parent })).attentions
    expect(attentions.filter(attention => attention.kind === 'approval')).toEqual([])

    await ctx.fiber.dispose()
  },
  240_000,
)

test(
  'a widened scope first mints a mandate-expansion Approval; approval mints the ticket, a rejection does not',
  async () => {
    const wideScope = 'the triggered change, the payment repository'
    const plan: FollowUpPlan = {
      reviews: [
        { verdict: 'pass', feedback: 'meets the mandate' },
        { verdict: 'pass', feedback: 'meets the mandate again' },
      ],
      followups: [
        { title: 'Track the payment repo too', scope: wideScope },
        { title: 'Track the payment repo too', scope: wideScope },
      ],
      reports: ['the fix is in', 'the fix is still in'],
    }
    const adapter = new AdaptiveAdapter(adaptiveTurn(plan))
    const home = await testHome()
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'followup.patch.yml')], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    await ctx.dshManagerSources.manualInput({ title: 'Fix the login flow', description: 'Investigate and fix' })
    await ctx.dshManagerSteward.runPending()
    const parent = (await ticketIds(ctx))[0]!
    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: parent })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: parent })
    }
    await awaitReady(ctx, parent)

    // The widened proposal stops at an Approval; no ticket yet. The pass
    // also minted an acceptance Attention — both wait for the human.
    await ctx.dshManagerSteward.reviewPending()
    expect(await ticketIds(ctx)).toEqual([parent])
    const approval = await pendingAttentionOf(ctx, parent, 'approval')
    expect(approval.action?.category).toBe('mandate-expansion')
    expect(approval.action?.tool).toBe('record_followup')
    expect(approval.action?.payload).toMatchObject({ parentTicketId: parent, title: 'Track the payment repo too', scope: wideScope })

    // A rejection leaves the follow-up unminted.
    await ctx.dshManagerExecutor.answerAttention({ attentionId: approval.id, answer: 'rejected: too wide for now' })
    expect(await ticketIds(ctx)).toEqual([parent])

    // The still-pending acceptance holds the review backlog, so the human
    // answers it too: a bare return re-dispatches, the Steward passes and
    // proposes the same widening again, and this time the human approves.
    const acceptance = (await ctx.dshManagerExecutor.attentionList({ ticketId: parent })).attentions
      .find(attention => attention.kind === 'review' && attention.status === 'pending')
    expect(acceptance).toBeDefined()
    await ctx.dshManagerExecutor.answerAttention({ attentionId: acceptance!.id, answer: 'rejected' })
    await awaitReady(ctx, parent)
    await ctx.dshManagerSteward.reviewPending()
    const secondApproval = await pendingAttentionOf(ctx, parent, 'approval')
    await ctx.dshManagerExecutor.answerAttention({ attentionId: secondApproval.id, answer: 'approved' })
    await vi.waitFor(async () => {
      expect(await ticketIds(ctx)).toHaveLength(2)
    })
    const child = (await ticketIds(ctx)).find(id => id !== parent)!
    const childRecord = ctx.dshManagerBoard.ticketRecord(child)
    expect(childRecord?.followUpOf).toBe(parent)
    expect(childRecord?.mandate?.scope).toBe(wideScope)
    expect(childRecord?.mandate?.strength).toBe('explicit')

    await ctx.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
})
