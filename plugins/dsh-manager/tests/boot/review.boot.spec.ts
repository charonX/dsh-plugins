/**
 * Main-seam spec for review, rework, and acceptance (spec stories 58–60,
 * 64/65): the executor reports ready, the Steward's main Session reviews
 * through its `record_review` tool — a rework re-dispatches with the opinion
 * as the executor's input, and a pass mints an acceptance Attention; only
 * the human's approval ends the ticket, and a third non-passing verdict
 * goes to the human instead of another automatic rework.
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
  const home = await tempRoot('dsh-review-boot-')
  const execCwd = await tempRoot('dsh-review-cwd-')
  await writeFile(join(home, 'review.patch.yml'), [
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

/** The script one adaptive turn plays against: verdicts and reports in order. */
interface ReviewPlan {
  /** The Steward's review verdicts, consumed in review-turn order. */
  readonly reviews: { verdict: 'pass' | 'rework'; feedback: string }[]
  /** The executor's ready-report messages, consumed in dispatch-turn order. */
  readonly reports: string[]
  /** Every dispatch prompt the executor saw, for the input assertions. */
  readonly dispatchPrompts: string[]
}

/**
 * One adaptive turn: title probes, Steward evals and reviews, and executor
 * sessions share one adapter. A review turn plays the next planned verdict;
 * a dispatch turn reports ready with the next planned message.
 */
function adaptiveTurn(plan: ReviewPlan): (options: GenerateOptions) => Promise<StreamChunk[]> {
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('Review the finished work on ticket')) {
      const next = plan.reviews.shift()
      if (next === undefined) return textResponse('nothing left to review')
      return toolCallsResponse([{
        name: 'record_review',
        args: { verdict: next.verdict, feedback: next.feedback, dispatchId: 'whatever the service is reviewing' },
      }])
    }
    if (tail.includes('工单 ticket-')) {
      // The dispatch prompt sits one message under the fresh session's
      // session-info reminder; take the user text block itself so opinions
      // keep their un-escaped quotes.
      const prompt = options.messages
        .filter(message => message.role === 'user')
        .flatMap(message => (message.content as readonly { type: string; text?: string }[] | undefined) ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .find(text => text.includes('工单 ticket-'))
      if (prompt !== undefined) plan.dispatchPrompts.push(prompt)
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

/** The newest dispatch view of one ticket. */
async function latestDispatch(ctx: Context, ticketId: string) {
  return (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches[0]
}

/** Wait until the newest dispatch of one ticket has ended ready. */
async function awaitReady(ctx: Context, ticketId: string): Promise<void> {
  await vi.waitFor(async () => {
    const view = await latestDispatch(ctx, ticketId)
    expect(view?.state).toBe('ended')
    expect(view?.outcome).toBe('ready')
  }, { timeout: 15_000 })
}

/** One ticket's pending attention of one kind, once it appears. */
async function pendingAttentionOf(ctx: Context, ticketId: string, kind: 'review' | 'question'): Promise<{ id: string; kind: string; question: string; details?: string | undefined }> {
  let found: { id: string; kind: string; question: string; details?: string | undefined } | undefined
  await vi.waitFor(async () => {
    const views = (await ctx.dshManagerExecutor.attentionList({ ticketId })).attentions
    const pending = views.find(view => view.status === 'pending' && view.kind === kind)
    if (pending !== undefined) found = pending
    expect(found).toBeDefined()
  }, { timeout: 15_000 })
  return found!
}

test(
  'a ready report is reviewed: a rework re-dispatches with the opinion, a pass mints an acceptance, and only the human ends the ticket',
  async () => {
    const plan: ReviewPlan = {
      reviews: [
        { verdict: 'rework', feedback: 'add the error path' },
        { verdict: 'pass', feedback: 'meets the mandate' },
        { verdict: 'pass', feedback: 'meets the mandate after the return' },
      ],
      reports: ['the first result', 'the second result', 'the returned result'],
      dispatchPrompts: [],
    }
    const adapter = new AdaptiveAdapter(adaptiveTurn(plan))
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(await testHome(), 'review.patch.yml')], home: tempRoots.at(-1)!,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    await ctx.dshManagerSources.manualInput({ title: 'Fix the login flow', description: 'Investigate and fix' })
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    const ticketA = tickets[0]!.id

    // The first dispatch runs and reports ready.
    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketA })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketA })
    }
    await awaitReady(ctx, ticketA)

    // The Steward reviews: a rework records the verdict and re-dispatches.
    await ctx.dshManagerSteward.reviewPending()
    const reviews = ctx.dshManagerBoard.reviewStore().listReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.verdict).toBe('rework')
    expect(reviews[0]?.origin).toBe('steward')
    expect(reviews[0]?.feedback).toBe('add the error path')
    await vi.waitFor(async () => {
      expect((await latestDispatch(ctx, ticketA))?.state).toBe('running')
    }, { timeout: 15_000 })
    await awaitReady(ctx, ticketA)
    // The opinion arrived as the re-dispatched executor's input.
    expect(plan.dispatchPrompts.some(prompt => prompt.includes('The Steward reworked this work with this opinion: "add the error path"'))).toBe(true)

    // The second review passes: an acceptance Attention is minted and the
    // ticket lifts into 待人工 while it waits.
    await ctx.dshManagerSteward.reviewPending()
    expect(ctx.dshManagerBoard.reviewStore().listReviews()).toHaveLength(2)
    const acceptance = await pendingAttentionOf(ctx, ticketA, 'review')
    expect(acceptance.details).toBe('meets the mandate')
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketA)
      expect(card?.state).toBe('attention')
    })

    // A dispatch-ready state never ends the ticket — only the acceptance
    // answer does. The human returns the work with an opinion: the record
    // keeps the human's verdict, the return re-dispatches with the opinion
    // as input, the Steward passes again, and the human's approval ends it.
    await ctx.dshManagerExecutor.answerAttention({ attentionId: acceptance.id, answer: 'rejected: the error path is still missing' })
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketA)
      expect(card?.state).toBe('todo')
    })
    const returnReviews = ctx.dshManagerBoard.reviewStore().listReviews()
    expect(returnReviews).toHaveLength(3)
    expect(returnReviews[2]?.origin).toBe('human')
    expect(returnReviews[2]?.feedback).toBe('the error path is still missing')
    await awaitReady(ctx, ticketA)
    expect(plan.dispatchPrompts.some(prompt => prompt.includes('The user returned this work with this opinion: "the error path is still missing"'))).toBe(true)
    await ctx.dshManagerSteward.reviewPending()
    // The pass mints a fresh acceptance even after a human return.
    const secondAcceptance = await pendingAttentionOf(ctx, ticketA, 'review')
    expect(ctx.dshManagerBoard.reviewStore().listReviews().at(-1)?.verdict).toBe('pass')
    await ctx.dshManagerExecutor.answerAttention({ attentionId: secondAcceptance.id, answer: 'approved' })
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketA)
      expect(card?.state).toBe('ended')
    }, { timeout: 15_000 })
    // The ended ticket leaves the review backlog: no further dispatch.
    await ctx.dshManagerSteward.reviewPending()
    expect((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketA })).dispatches).toHaveLength(3)

    await ctx.fiber.dispose()
  },
  240_000,
)

test(
  'three non-passing reviews in a row hand the decision to a human instead of re-dispatching',
  async () => {
    const plan: ReviewPlan = {
      reviews: [
        { verdict: 'rework', feedback: 'first gap' },
        { verdict: 'rework', feedback: 'second gap' },
        { verdict: 'rework', feedback: 'third gap' },
      ],
      reports: ['result one', 'result two', 'result three'],
      dispatchPrompts: [],
    }
    const adapter = new AdaptiveAdapter(adaptiveTurn(plan))
    const home = await testHome()
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'review.patch.yml')], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    await ctx.dshManagerSources.manualInput({ title: 'Fix the report flow', description: 'Investigate and fix' })
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    const ticketB = tickets[0]!.id

    // Dispatch once; every later dispatch is the Steward's automatic rework.
    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketB })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketB })
    }
    for (let round = 1; round <= 3; round++) {
      await awaitReady(ctx, ticketB)
      await ctx.dshManagerSteward.reviewPending()
      if (round < 3) {
        // The automatic budget lasts two rounds; each re-dispatch carries
        // the latest opinion.
        await vi.waitFor(async () => {
          expect((await latestDispatch(ctx, ticketB))?.state).toBe('running')
        }, { timeout: 15_000 })
      }
    }
    // The budget is spent: the third non-passing verdict mints a human
    // attention instead of a fourth dispatch.
    const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketB })).dispatches
    expect(dispatches).toHaveLength(3)
    const reviews = ctx.dshManagerBoard.reviewStore().listReviews().filter(review => review.ticketId === ticketB)
    expect(reviews).toHaveLength(3)
    const escalation = await pendingAttentionOf(ctx, ticketB, 'question')
    expect(escalation.details).toBe('third gap')
    const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketB)
    expect(card?.state).toBe('attention')

    await ctx.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
})
