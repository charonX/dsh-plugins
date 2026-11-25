/**
 * Main-seam spec for executor dispatch (spec §8, stories 50–57): a ticket
 * dispatched through the effects queue starts its Executor Session under the
 * dedicated preset, the executor declares a deliverable with `present` and
 * reports `ready` through `submit_report`, the ticket detail serves the
 * deliverable as a "Session id + turn" reference, an unmapped ticket's
 * executor is pinned read-only, a dispatch beyond the concurrency ceiling
 * queues, and a restart marks an interrupted dispatch without losing it.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-dispatch-boot-'))
const execCwd = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-dispatch-cwd-')))
await mkdir(join(execCwd, 'out'), { recursive: true })
await writeFile(join(execCwd, 'analysis.md'), '# Analysis\nThe read-only findings.\n')

// One dynamic overlay: the Steward and the Executor facet configs together.
const overlayPath = join(home, 'dispatch.patch.yml')
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
  '          turnTimeoutMs: 30000',
  `          cwd: ${JSON.stringify(execCwd)}`,
  '',
].join('\n'))

const server: Server = createServer((request: IncomingMessage, response) => {
  if (request.url?.includes('/rest/api/2/myself')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'jira-user' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    issues: [
      { key: 'PROJ-1', fields: { summary: 'Fix the login flow', updated: '2026-01-01T00:00:00.000+0000' } },
      { key: 'PROJ-2', fields: { summary: 'Ship the report', updated: '2026-01-02T00:00:00.000+0000' } },
    ],
  }))
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One scripted tool call's stream chunks. */
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

/** The Steward's accept turn for one eval prompt. */
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

/** The executor's deliverable + ready turn for one dispatched ticket. */
function executorReady(): StreamChunk[] {
  return toolCallsResponse([
    { name: 'present', args: { files: [{ path: 'analysis.md', description: 'The analysis notes' }] } },
    { name: 'submit_report', args: { kind: 'ready', message: 'the analysis is complete' } },
  ])
}

/** One adaptive turn: title probes, Steward evals, and executor prompts share one adapter. */
function adaptiveTurn(gates: {
  releaseFirst: Promise<void>
  hangThird: (signal?: AbortSignal) => Promise<void>
}): (options: GenerateOptions) => Promise<StreamChunk[]> {
  let executorCalls = 0
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    // The first turn of a fresh session closes with the session-info
    // reminder; the actual prompt sits one message earlier, so the tail of
    // two messages decides.
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('executor dispatched for ticket')) {
      executorCalls += 1
      if (executorCalls === 1) await gates.releaseFirst
      if (executorCalls === 3) await gates.hangThird(options.signal)
      return executorReady()
    }
    return textResponse('done')
  }
}

/** Scripted adapter: one adaptive function serves every model call. */
class AdaptiveAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private entry: (options: GenerateOptions) => Promise<StreamChunk[]>) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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

/** The dispatch view of one ticket, newest first. */
async function dispatchesOf(ctx: Context, ticketId: string) {
  return (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches
}

test(
  'a dispatched ticket runs an executor that presents and reports ready; extra dispatches queue; restart interrupts',
  async () => {
    let releaseFirst!: () => void
    const releaseFirstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const hangThird = (signal?: AbortSignal): Promise<void> => new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return }
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    const adapter = new AdaptiveAdapter(adaptiveTurn({ releaseFirst: releaseFirstGate, hangThird }))

    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)

    // Two unmapped Jira tickets through the normal accept path.
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })
    await ctx.dshManagerSteward.runPending()
    const jiraTickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(jiraTickets, 'jira tickets minted').toHaveLength(2)

    // Dispatch the first ticket: the effects queue starts its Executor Session.
    const dispatchA = await ctx.dshManagerExecutor.dispatchTicket({ ticketId: jiraTickets[0]!.id })
    expect(dispatchA.state).toBe('queued')
    await vi.waitFor(async () => {
      const running = await dispatchesOf(ctx, jiraTickets[0]!.id)
      expect(running[0]?.state).toBe('running')
      expect(running[0]?.sessionId).toMatch(/^dsh-manager-exec-/)
    })

    // The second dispatch exceeds the ceiling (1) and queues behind it.
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: jiraTickets[1]!.id })
    await ctx.dshManagerExecutor.pump()
    expect((await dispatchesOf(ctx, jiraTickets[1]!.id))[0]?.state).toBe('queued')

    // Releasing the first executor: it presents the deliverable and reports ready.
    releaseFirst()
    await vi.waitFor(async () => {
      const ended = await dispatchesOf(ctx, jiraTickets[0]!.id)
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    })
    const dispatchAView = (await dispatchesOf(ctx, jiraTickets[0]!.id))[0]
    expect(dispatchAView?.reports.some(report => report.kind === 'ready' && report.message === 'the analysis is complete')).toBe(true)

    // The freed slot starts the queued dispatch, which reports ready directly.
    await ctx.dshManagerExecutor.pump()
    await vi.waitFor(async () => {
      const ended = await dispatchesOf(ctx, jiraTickets[1]!.id)
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    })

    // The ticket detail serves the deliverable as a session+turn reference,
    // pointing at the executor session — no copy stored.
    const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: jiraTickets[0]!.id })
    expect(detail.dispatches[0]?.id).toBe(dispatchAView?.id)
    expect(detail.deliverables).toHaveLength(1)
    expect(detail.deliverables[0]).toMatchObject({
      sessionId: dispatchAView?.sessionId,
      path: join(execCwd, 'analysis.md'),
      description: 'The analysis notes',
    })
    expect(detail.deliverables[0]!.turn).toBeGreaterThan(0)
    expect(detail.deliverables[0]!.index).toBe(0)

    // An unmapped ticket's executor is pinned read-only in its session log.
    const executorSession = ctx.sessions.get(dispatchAView!.sessionId as never)
    expect(executorSession).toBeDefined()
    const modeEvents = executorSession!.snapshotEvents()
      .filter(event => (event as { readonly type: string }).type === 'sandbox/mode')
    expect(modeEvents.length).toBeGreaterThan(0)
    expect((modeEvents.at(-1) as unknown as { data: { mode: string } }).data.mode).toBe('read-only')

    // A third ticket dispatches and its executor hangs mid-turn.
    await ctx.dshManagerSources.manualInput({
      title: 'Prepare the migration plan',
      description: 'Draft the cutover plan for the storage migration',
    })
    await ctx.dshManagerSteward.runPending()
    const manualTicket = (await ctx.dshManagerBoard.ticketList()).tickets
      .find(ticket => ticket.externalKey?.startsWith('manual-'))
    expect(manualTicket).toBeDefined()
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: manualTicket!.id })
    await vi.waitFor(async () => {
      expect((await dispatchesOf(ctx, manualTicket!.id))[0]?.state).toBe('running')
    })

    // A restart over the same home marks the interrupted dispatch, keeps the
    // finished ones, and never loses the work.
    await ctx.fiber.dispose()
    const restarted = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(restarted, 'dshManagerExecutor')
    const interrupted = (await dispatchesOf(restarted, manualTicket!.id))[0]
    expect(interrupted).toMatchObject({ state: 'ended', outcome: 'interrupted' })
    expect((await dispatchesOf(restarted, jiraTickets[0]!.id))[0]?.outcome).toBe('ready')
    expect((await dispatchesOf(restarted, jiraTickets[1]!.id))[0]?.outcome).toBe('ready')
    // The interrupted dispatch's ticket stays a live todo, untouched by the
    // dispatch lifecycle.
    expect((await restarted.dshManagerBoard.ticketList()).tickets
      .find(ticket => ticket.id === manualTicket!.id)?.state).toBe('todo')
    await restarted.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(execCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
