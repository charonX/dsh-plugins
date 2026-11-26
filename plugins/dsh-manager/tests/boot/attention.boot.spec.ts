/**
 * Main-seam spec for attentions (spec stories 55/77/78): the scripted
 * executor asks through the structured `ask_user` tool, the ticket lifts
 * into the 待人工 column with a pending attention and a GUI notification,
 * the user's answer rides the effects queue into the live Executor Session
 * as a new message, and the executor finishes on it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-attention-boot-'))
const execCwd = await mkdtemp(join(tmpdir(), 'dsh-attention-cwd-'))

const overlayPath = join(home, 'attention.patch.yml')
await writeFile(overlayPath, [
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

/** The executor's second turn: report ready on the user's answer. */
function executorReady(): StreamChunk[] {
  return toolCallsResponse([
    { name: 'submit_report', args: { kind: 'ready', message: 'the answer unblocked the work' } },
  ])
}

/**
 * One adaptive turn: title probes, Steward evals, and executor sessions
 * share one adapter. The executor asks on its first turn, idles on the ask's
 * tool result, and finishes on the delivered answer.
 */
function adaptiveTurn(): (options: GenerateOptions) => Promise<StreamChunk[]> {
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    // The first turn of a fresh session closes with the session-info
    // reminder; the actual prompt sits one message earlier, so the tail of
    // two messages decides.
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('standing by for the answer')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('executor dispatched for ticket')) {
      return toolCallsResponse([{
        name: 'ask_user',
        args: { question: 'Which database should this target?', details: 'The ticket does not name one.' },
      }])
    }
    if (tail.includes('The user answered your question')) return executorReady()
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

test(
  'the executor asks, the ticket lifts into 待人工, and the answer reaches the session',
  async () => {
    const adapter = new AdaptiveAdapter(adaptiveTurn())
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    await ctx.dshManagerSources.manualInput({ title: 'Pick a database', description: 'Choose the storage engine' })
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    const ticketId = tickets[0]!.id

    // Dispatch: the scripted executor asks on its first turn (auto-dispatched or explicit).
    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId })
    }
    let attention: { id: string; status: string; question: string; answer?: string | undefined } | undefined
    await vi.waitFor(async () => {
      const views = (await ctx.dshManagerExecutor.attentionList({})).attentions
      const pending = views.find(view => view.status === 'pending')
      if (pending !== undefined) attention = pending
      expect(attention?.question).toBe('Which database should this target?')
    })
    expect(attention).toBeDefined()

    // The dispatch stays running — asking is not an ending.
    const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches
    expect(dispatches[0]?.state).toBe('running')
    expect(dispatches[0]?.reports.some(report => report.kind === 'waiting')).toBe(false)

    // The ticket lifts into 待人工 while the attention is pending.
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketId)
      expect(card?.state).toBe('attention')
    })
    const summary = await ctx.dshManagerBoard.summary()
    expect(summary.columns.find(column => column.id === 'attention')?.count).toBe(1)

    // The GUI feed holds the notification with the question as its copy.
    const feed = (await ctx.dshManagerNotifications.notificationList()).notifications
    expect(feed.some(notification => notification.kind === 'attention' && notification.attentionId === attention!.id
      && notification.ticketId === ticketId && notification.title === 'Which database should this target?')).toBe(true)

    // The user answers on the board; the delivery reaches the session.
    const answered = await ctx.dshManagerExecutor.answerAttention({ attentionId: attention!.id, answer: 'Use Postgres' })
    expect(answered.status).toBe('answered')
    expect(answered.answer).toBe('Use Postgres')
    await vi.waitFor(async () => {
      const ended = (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
      expect(ended[0]?.reports.some(report => report.kind === 'ready' && report.message.includes('the answer unblocked'))).toBe(true)
    })

    // The answered attention keeps its answer; the ticket returns to 待办.
    const views = (await ctx.dshManagerExecutor.attentionList({ ticketId })).attentions
    expect(views[0]?.status).toBe('answered')
    expect(views[0]?.answer).toBe('Use Postgres')
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketId)
      expect(card?.state).toBe('todo')
    })

    // Answering again is refused by the host.
    await expect(ctx.dshManagerExecutor.answerAttention({ attentionId: attention!.id, answer: 'Use MySQL' }))
      .rejects.toThrow()

    await ctx.fiber.dispose()
  },
  120_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(execCwd, { recursive: true, force: true })
})
