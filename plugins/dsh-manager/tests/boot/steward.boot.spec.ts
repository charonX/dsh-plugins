/**
 * Main-seam spec: the Steward against a scripted model — a runPending pass
 * evaluates each pending thread through the resident main Session, the
 * record_decision tool call mints an accepted ticket with its mandate, the
 * audit trail lands in the session log, and covered triggers never produce a
 * second ticket, across repeated polls and a restart (spec stories 30–32).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, 'steward.patch.yml')
const timeoutOverlayPath = join(import.meta.dirname, 'steward-timeout.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'dsh-steward-boot-'))
const ignoreHome = await mkdtemp(join(tmpdir(), 'dsh-steward-ignore-'))
const timeoutHome = await mkdtemp(join(tmpdir(), 'dsh-steward-timeout-'))
const batchHome = await mkdtemp(join(tmpdir(), 'dsh-steward-batch-'))

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

/** One scripted entry: computes the chunks for one model request, or hangs. */
type ScriptEntry = ((options: GenerateOptions) => StreamChunk[] | 'hang') | 'hang'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The eval id the Steward named in the turn prompt of this request. */
function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('scripted adapter: request does not name an eval')
  return evalId
}

function decisionResponse(options: GenerateOptions, kind: 'accept' | 'ignore'): StreamChunk[] {
  const callId = ToolCallId('call-1')
  const args = kind === 'accept'
    ? {
        action: 'accept',
        strength: 'explicit',
        title: 'Accepted work',
        scope: 'the triggered change',
        rationale: 'the triggers support this work',
      }
    : {
        action: 'ignore',
        strength: 'inferred',
        rationale: 'not actionable',
      }
  const argumentsJson = JSON.stringify({ ...args, evalId: evalIdOf(options) })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'record_decision', argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'record_decision', arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * One reusable Steward turn: a decision tool call on the eval prompt, a plain
 * closing text on the tool result, and a title for the harness's title probe.
 */
function stewardTurn(action: 'accept' | 'ignore' = 'accept'): ScriptEntry {
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const serialized = JSON.stringify(last)
    if (serialized.includes('Generate the session title')) return textResponse('Steward thread')
    if (last.role === 'user') return decisionResponse(options, action)
    return textResponse('done')
  }
}

/** Scripted adapter: every model call consumes the next entry and is recorded. */
class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private script: ScriptEntry[]) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('scripted adapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    if (chunks === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of chunks) yield chunk
  }
}

/**
 * Wait until one service is committed on the boot tree. boot() resolves the
 * root context while late overlay entries are still activating, so tests
 * poll instead of assuming immediate availability.
 */
async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} did not become ready within ${timeoutMs}ms`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

/**
 * One reusable hanging Steward turn: every eval prompt hangs until aborted;
 * anything else (the harness's title probe) closes as plain text.
 */
function hangingTurn(): ScriptEntry {
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Steward thread')
    if (last.role === 'user') return 'hang'
    return textResponse('done')
  }
}

/** Boot a profile over the shared fake Jira with the scripted adapter wired. */
async function bootSteward(
  script: ScriptEntry[],
  options: { overlayPaths?: string[]; home?: string } = {},
): Promise<{ ctx: Context; adapter: ScriptedAdapter }> {
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web',
    overlayPaths: options.overlayPaths ?? [overlayPath],
    home: options.home ?? home,
  })
  await waitUntilService(ctx, 'dshManagerSteward')
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

test(
  'the Steward mints one ticket per pending thread and never mints it twice',
  async () => {
    let { ctx, adapter } = await bootSteward(Array.from({ length: 6 }, () => stewardTurn()))
    const createdOptions: Parameters<typeof ctx.agents.create>[0][] = []
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    ctx.agents.create = async options => {
      createdOptions.push(options)
      return await originalCreate(options)
    }
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })

    // The poll collects both issues; both threads sit in the inbox backlog.
    const first = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(first).toMatchObject({ added: 2, duplicates: 0 })
    const inboxBefore = (await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')
    expect(inboxBefore?.count).toBe(2)

    // One runPending pass evaluates both threads through the main Session.
    await ctx.dshManagerSteward.runPending()
    // Two evals: one decision call + one closing turn each; the harness's
    // one-off session title probe may add a request.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(4)

    // Every accepted eval minted a todo ticket carrying its mandate.
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(2)
    for (const ticket of tickets) {
      expect(ticket.state).toBe('todo')
      expect(ticket.mandate).toMatchObject({ strength: 'explicit', scope: 'the triggered change', policyVersion: '1' })
      expect(ticket.title).toBe('Accepted work')
      expect(ticket.threadId).not.toBe('')
    }

    // The board's columns count both accepted tickets.
    const columns = (await ctx.dshManagerBoard.summary()).columns
    expect(columns.find(column => column.id === 'todo')?.count).toBe(2)
    expect(columns.find(column => column.id === 'inbox')?.count).toBe(0)

    // Every decision is on the audit trail with its thread identity.
    const decisions = await ctx.dshManagerSteward.listDecisions()
    expect(decisions).toHaveLength(2)
    for (const decision of decisions) {
      expect(decision.action).toBe('accept')
      expect(decision.strength).toBe('explicit')
      expect(decision.policyVersion).toBe('1')
      expect(decision.threadId).not.toBe('')
    }

    // Ephemeral Steward sessions omit `meta.cwd` so background triage stays
    // out of the workspace session tree, and never pin `dsh-manager-steward-v2`.
    const stewardCreates = createdOptions.filter(opt => opt.sessionId.startsWith('dsh-manager-steward-'))
    expect(stewardCreates.length).toBeGreaterThanOrEqual(2)
    for (const opt of stewardCreates) {
      expect(opt.meta?.cwd).toBeUndefined()
    }
    expect(ctx.sessions.get('dsh-manager-steward-v2' as never)).toBeUndefined()

    // Repeated polls of the same data add no backlog and no second ticket.
    await ctx.dshManagerSources.sourcePoll({ id: source.id })
    await ctx.dshManagerSteward.runPending()
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(2)
    expect(adapter.requests.length).toBeGreaterThanOrEqual(4)
    await ctx.fiber.dispose()

    // A restart over the same home keeps the decisions domain with no backlog.
    const restarted = await bootSteward([])
    ctx = restarted.ctx
    await ctx.dshManagerSteward.runPending()
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(2)
    // The recorded decisions survive the restart in the decisions domain.
    expect((await ctx.dshManagerSteward.listDecisions()).length).toBeGreaterThanOrEqual(2)
    await ctx.fiber.dispose()
  },
  300_000,
)

test(
  'an ignore decision covers the triggers without a ticket and lands on the eval records',
  async () => {
    const { ctx, adapter } = await bootSteward(Array.from({ length: 6 }, () => stewardTurn('ignore')), { home: ignoreHome })
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'ignore-prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })

    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBeGreaterThanOrEqual(4)

    // The board shows no ticket: an ignore never mints one.
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(0)
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(0)

    // Every eval record carries its ignore decision and its trigger batch.
    const evals = (await ctx.dshManagerSteward.evalList({})).evals
    expect(evals).toHaveLength(2)
    for (const record of evals) {
      expect(record.status).toBe('rejected')
      expect(record.decision).toMatchObject({ action: 'ignore', strength: 'inferred', policyVersion: '1', rationale: 'not actionable' })
      expect(record.threadId).not.toBe('')
      expect(record.sourceConnectionId).toBe(connection.id)
      expect(record.triggers.length).toBeGreaterThan(0)
    }
    // The records page filters by decision type and source connection.
    expect((await ctx.dshManagerSteward.evalList({ action: 'ignore' })).evals).toHaveLength(2)
    expect((await ctx.dshManagerSteward.evalList({ action: 'accept' })).evals).toHaveLength(0)
    expect((await ctx.dshManagerSteward.evalList({ connectionId: connection.id })).evals).toHaveLength(2)
    await ctx.fiber.dispose()
  },
  300_000,
)

test(
  'a timed-out eval re-queues its batch and a repeated inconclusive run retires it',
  async () => {
    const { ctx, adapter } = await bootSteward(Array.from({ length: 8 }, () => hangingTurn()), { overlayPaths: [timeoutOverlayPath], home: timeoutHome })
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'slow-prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })

    // The first pass: every turn overruns the tiny budget and is cancelled,
    // so each batch re-queues as `failed`.
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
    const first = (await ctx.dshManagerSteward.evalList({})).evals
    expect(first).toHaveLength(2)
    for (const record of first) {
      expect(record.status).toBe('failed')
      expect(record.decision).toBeUndefined()
    }
    // The re-queued batches still sit in the inbox; nothing was accepted.
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(0)
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(2)

    // The second pass: one inconclusive run already exists per batch, so the
    // system records an `incomplete` decision and retires them.
    const afterFirst = adapter.requests.length
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBeGreaterThanOrEqual(afterFirst + 2)
    const second = (await ctx.dshManagerSteward.evalList({ action: 'incomplete' })).evals
    expect(second).toHaveLength(2)
    for (const record of second) {
      expect(record.decision).toMatchObject({
        action: 'incomplete', strength: 'inferred',
        rationale: 'the eval was abandoned after 2 inconclusive runs',
      })
    }
    // The retired batches leave the inbox and consume no further evals.
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(0)
    const afterSecond = adapter.requests.length
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBe(afterSecond)
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(0)
    await ctx.fiber.dispose()
  },
  300_000,
)

test(
  'a transient Steward session creation failure marks the eval failed instead of stuck running',
  async () => {
    const { ctx } = await bootSteward([
      stewardTurn('accept'),
      stewardTurn('accept'),
      stewardTurn('accept'),
    ])
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    const seenCreates: Parameters<typeof ctx.agents.create>[0][] = []
    let failAllCreates = true
    ctx.agents.create = async options => {
      seenCreates.push(options)
      if (failAllCreates) throw new Error('ephemeral session create failed')
      return await originalCreate(options)
    }

    const created = await ctx.dshManagerSources.manualInput({ title: 'WeChat test task', description: 'Verify recovery' })
    await ctx.dshManagerSteward.runPending()
    const failedEvals = (await ctx.dshManagerSteward.evalList({}))
      .evals.filter(entry => entry.threadId === created.threadId)
    expect(failedEvals).toHaveLength(1)
    expect(failedEvals[0]?.status).toBe('failed')
    expect((await ctx.dshManagerBoard.ticketList()).tickets.some(ticket => ticket.threadId === created.threadId)).toBe(false)

    failAllCreates = false
    await ctx.dshManagerSteward.runPending()
    expect((await ctx.dshManagerBoard.ticketList()).tickets.some(ticket => ticket.threadId === created.threadId)).toBe(true)
    const stewardCreates = seenCreates.filter(opt => opt.sessionId.startsWith('dsh-manager-steward-'))
    expect(stewardCreates.length).toBeGreaterThanOrEqual(2)
    for (const opt of stewardCreates) {
      expect(opt.meta?.cwd).toBeUndefined()
    }
    ctx.agents.create = originalCreate
    await ctx.fiber.dispose()
  },
  120_000,
)

test(
  'configurable evalBatchSize chunks backlog and combines Eval + Route into one triage turn',
  async () => {
    const batchPrompts: string[] = []
    const singleEvalPrompts: string[] = []
    const routePrompts: string[] = []
    let ruleId = ''
    const triageEntry: ScriptEntry = options => {
      const last = options.messages.at(-1)
      if (last === undefined) return textResponse('done')
      const lastText = JSON.stringify(last)
      if (lastText.includes('Generate the session title')) return textResponse('Steward thread')
      if (last.role !== 'user') return textResponse('done')
      const tail = JSON.stringify(options.messages.slice(-2))
      if (tail.includes('Batch-triage ')) {
        batchPrompts.push(tail)
        const evalIds = [...tail.matchAll(/eval (eval-[0-9a-f-]+)/g)].map(match => match[1])
        const callId = ToolCallId('call-batch')
        const argumentsJson = JSON.stringify({
          items: evalIds.map((evalId, index) => ({
            evalId,
            action: 'accept',
            strength: 'explicit',
            title: `Batch task ${index + 1}`,
            scope: `batch scope ${index + 1}`,
            rationale: 'batch triage supported',
            ruleId,
          })),
        })
        return [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id: callId, name: 'record_triage_batch', argumentsDelta: argumentsJson },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'record_triage_batch', arguments: argumentsJson } },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]
      }
      if (tail.includes('Evaluate the pending changes')) {
        singleEvalPrompts.push(tail)
        return decisionResponse(options, 'accept')
      }
      if (tail.includes('Route the accepted ticket')) {
        routePrompts.push(tail)
        const callId = ToolCallId('call-route')
        const argumentsJson = JSON.stringify({ ruleId, rationale: 'single-item route' })
        return [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id: callId, name: 'record_route', argumentsDelta: argumentsJson },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'record_route', arguments: argumentsJson } },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]
      }
      return textResponse('done')
    }

    const { ctx } = await bootSteward(Array.from({ length: 24 }, () => triageEntry), { home: batchHome })
    const { member } = await ctx.dshManagerCrew.crewAdd({ name: 'Worker', role: 'do work' })
    const { pipeline } = await ctx.dshManagerPipeline.pipelineAdd({
      name: 'Fast Track',
      stages: [{ memberId: member.id, instruction: 'run task' }],
    })
    const { rule } = await ctx.dshManagerRoute.ruleAdd({ condition: 'all tasks', pipelineId: pipeline.id })
    ruleId = rule.id

    await ctx.dshManagerSettings.uiSettingsUpdate({ evalBatchSize: 2 })
    expect((await ctx.dshManagerSettings.uiSettings()).settings.evalBatchSize).toBe(2)

    await ctx.dshManagerSources.manualInput({ title: 'Task A', description: 'First item' })
    await ctx.dshManagerSources.manualInput({ title: 'Task B', description: 'Second item' })
    await ctx.dshManagerSources.manualInput({ title: 'Task C', description: 'Third item' })

    await ctx.dshManagerSteward.runPending()

    expect(batchPrompts).toHaveLength(1)
    expect(batchPrompts[0]).toContain('Batch-triage 2 pending threads')
    expect(singleEvalPrompts).toHaveLength(1)
    expect(routePrompts).toHaveLength(1)

    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(3)
    for (const ticket of tickets) {
      expect(ticket.flow?.pipelineId).toBe(pipeline.id)
    }
    await ctx.fiber.dispose()
  },
  120_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true })
  await rm(ignoreHome, { recursive: true, force: true })
  await rm(timeoutHome, { recursive: true, force: true })
  await rm(batchHome, { recursive: true, force: true })
})
