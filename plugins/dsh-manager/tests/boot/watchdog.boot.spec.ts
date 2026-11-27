/**
 * Main-seam spec for the Watchdog (spec story 81): a live dispatch gone
 * silent past the progress timeout raises an attention on the ticket, and a
 * connection failing its connectivity test raises a connection anomaly —
 * each once, never repeatedly for the same open problem.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { touchDispatch } from '../../src/dispatch/dispatch-core.ts'
import { bootTestProfile, installFakeGlab } from './boot-test-profile.ts'

/** Temp roots this file created; cleaned up after the suite. */
const tempRoots: string[] = []
const fakeGlabRoot = await mkdtemp(join(tmpdir(), 'dsh-watchdog-bin-'))
tempRoots.push(fakeGlabRoot)
const restorePath = await installFakeGlab(join(fakeGlabRoot, 'bin'))

/** The fake GitLab refuses every credential: the connectivity test fails. */
const server: Server = createServer((_request, response) => {
  response.writeHead(401, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ message: '401 Unauthorized' }))
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const gitlabPort = typeof address === 'object' && address !== null ? address.port : 0

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function testHome(watchdog: Record<string, number>): Promise<string> {
  const home = await tempRoot('dsh-watchdog-boot-')
  const execCwd = await tempRoot('dsh-watchdog-cwd-')
  await writeFile(join(home, 'watchdog.patch.yml'), [
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
    `        watchdog: ${JSON.stringify(watchdog)}`,
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

/**
 * One adaptive turn: the Steward accepts the trigger, the executor reports
 * progress once and then goes silent — the dispatch never reaches a terminal
 * report.
 */
function silentTurn(): (options: GenerateOptions) => Promise<StreamChunk[]> {
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) {
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
    if (tail.includes('工单 ticket-')) {
      return toolCallsResponse([{ name: 'submit_report', args: { kind: 'progress', message: 'working on it' } }])
    }
    // The turn after the progress report: plain text, no terminal report.
    return textResponse('still working, no result yet')
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
  'a dispatch silent past the progress timeout raises one stall attention on its ticket',
  async () => {
    const adapter = new AdaptiveAdapter(silentTurn())
    const home = await testHome({ intervalMs: 300, progressTimeoutMs: 1500, failureThreshold: 3 })
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'watchdog.patch.yml')], home,
    })
    try {
      await waitUntilService(ctx, 'dshManagerExecutor')
      await waitUntilService(ctx, 'dshManagerSteward')
      await waitUntilService(ctx, 'dshManagerWatchdog')
      ctx.llm.registerAdapter(['mock'], adapter)

      // Accept a trigger into a ticket and dispatch it; the scripted
      // executor reports progress once and then goes silent.
      await ctx.dshManagerSources.manualInput({ title: 'Long investigation', description: 'Take your time' })
      await ctx.dshManagerSteward.runPending()
      const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(tickets).toHaveLength(1)
      const ticket = tickets[0]!.id
      if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket })).dispatches.length === 0) {
        await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket })
      }
      await vi.waitFor(async () => {
        const view = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket })).dispatches[0]
        expect(view?.state).toBe('running')
      }, { timeout: 15_000 })

      // Past the progress timeout the sweep raises one question attention.
      await vi.waitFor(async () => {
        const stall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
          .find(entry => entry.details?.startsWith('watchdog:stall:'))
        expect(stall?.kind).toBe('question')
        expect(stall?.status).toBe('pending')
        expect(stall?.question).toContain('no progress')
      }, { timeout: 15_000 })

      // The ticket lifts into 待人工.
      await vi.waitFor(async () => {
        const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticket)
        expect(card?.state).toBe('attention')
      }, { timeout: 15_000 })

      // The same open problem never mints again across further sweeps.
      await new Promise(resolve => { setTimeout(resolve, 2000) })
      const stalls = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
        .filter(entry => entry.details?.startsWith('watchdog:stall:'))
      expect(stalls).toHaveLength(1)

      // Answering `'confirmed'` ("继续等待") refreshes the heartbeat without
      // cancelling or duplicating the live dispatch.
      const stalledDispatchId = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket })).dispatches[0]!.id
      await ctx.dshManagerExecutor.answerAttention({ attentionId: stalls[0]!.id, answer: 'confirmed' })
      const stillRunning = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket })).dispatches[0]
      expect(stillRunning?.state).toBe('running')

      // When it stalls a second time, resuming heartbeat activity auto-settles
      // the pending stall notice cleanly with `'activity resumed'`.
      await vi.waitFor(async () => {
        const pendingStalls = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
          .filter(entry => entry.details?.startsWith('watchdog:stall:') && entry.status === 'pending')
        expect(pendingStalls).toHaveLength(1)
      }, { timeout: 15_000 })
      const secondStall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
        .find(entry => entry.details?.startsWith('watchdog:stall:') && entry.status === 'pending')!
      await touchDispatch(ctx.dshManagerBoard.dispatchStore(), stalledDispatchId, Date.now() + 50)
      await ctx.dshManagerWatchdog.runOnce()
      const resumedStall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
        .find(entry => entry.id === secondStall.id)
      expect(resumedStall?.status).toBe('answered')
      expect(resumedStall?.answer).toBe('activity resumed')

      // Once that dispatch ends, the next watchdog sweep automatically settles
      // the stale stall prompt so it does not stay stuck in 待人工.
      await vi.waitFor(async () => {
        const pendingStalls = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
          .filter(entry => entry.details?.startsWith('watchdog:stall:') && entry.status === 'pending')
        expect(pendingStalls).toHaveLength(1)
      }, { timeout: 15_000 })
      const thirdStall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
        .find(entry => entry.details?.startsWith('watchdog:stall:') && entry.status === 'pending')!
      await ctx.dshManagerExecutor.dispatchCancel({ dispatchId: stalledDispatchId })
      await ctx.dshManagerWatchdog.runOnce()
      const resolvedStall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket })).attentions
        .find(entry => entry.id === thirdStall.id)
      expect(resolvedStall?.status).toBe('answered')

      // Answering `'rejected'` ("中止派工") cancels the stalled running dispatch.
      await ctx.dshManagerSources.manualInput({ title: 'Abortable silent run', description: 'Cancel on stall' })
      await ctx.dshManagerSteward.runPending()
      const ticket2 = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id !== ticket)!.id
      if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket2 })).dispatches.length === 0) {
        await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket2 })
      }
      let stallToAbortId = ''
      await vi.waitFor(async () => {
        const stall = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket2 })).attentions
          .find(entry => entry.details?.startsWith('watchdog:stall:') && entry.status === 'pending')
        expect(stall).toBeDefined()
        stallToAbortId = stall!.id
      }, { timeout: 15_000 })
      await ctx.dshManagerExecutor.answerAttention({ attentionId: stallToAbortId, answer: 'rejected' })
      await vi.waitFor(async () => {
        const d = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket2 })).dispatches[0]
        expect(d?.state).toBe('ended')
        expect(d?.outcome).toBe('interrupted')
        expect(d?.reports.some(r => r.message === 'cancelled from stall attention')).toBe(true)
      }, { timeout: 15_000 })
    } finally {
      await ctx.fiber.dispose()
    }
  },
  240_000,
)

test(
  'a connection failing its connectivity test raises one unhealthy-connection attention',
  async () => {
    const adapter = new AdaptiveAdapter(silentTurn())
    const home = await testHome({ intervalMs: 300, progressTimeoutMs: 600000, failureThreshold: 3 })
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'watchdog.patch.yml')], home,
    })
    try {
      await waitUntilService(ctx, 'dshManagerWatchdog')
      ctx.llm.registerAdapter(['mock'], adapter)

      // The connection's own probe already fails (401 everywhere) — the
      // stored status says so, but the problem is not silently swallowed:
      // the Watchdog still raises it onto the board.
      const connection = await ctx.dshManagerConnections.connectionAdd({
        connector: 'gitlab', name: 'expired gl', deployment: 'server-dc', baseUrl: `http://127.0.0.1:${gitlabPort}`, authMethod: 'pat', secret: 'stale-pat',
      })
      expect(connection.status).toBe('invalid-credentials')

      await vi.waitFor(async () => {
        const finding = (await ctx.dshManagerExecutor.attentionList({})).attentions
          .find(entry => entry.details === `watchdog:connection:${connection.id}`)
        expect(finding?.kind).toBe('question')
        expect(finding?.status).toBe('pending')
        expect(finding?.question).toContain('expired gl')
        expect(finding?.question).toContain('invalid-credentials')
      }, { timeout: 15_000 })

      // The same open problem never mints again across further sweeps.
      await new Promise(resolve => { setTimeout(resolve, 2000) })
      const findings = (await ctx.dshManagerExecutor.attentionList({})).attentions
        .filter(entry => entry.details === `watchdog:connection:${connection.id}`)
      expect(findings).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  },
  240_000,
)

afterAll(async () => {
  restorePath()
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})
