/**
 * Main-seam spec for routing and the pipeline walk (team tickets 04/05): an
 * accepted ticket is routed through the resident main Session — a matching
 * rule annotates the ticket with its flow and auto-dispatches stage 1, whose
 * executor prompt opens with the crew member's duty and the stage
 * instruction; `none` raises the human's attention with the suggestion to
 * add a rule, and the ticket waits. A three-stage pipeline then walks: a
 * skippable middle stage goes through the steward's skip proposal, and the
 * human's approval or rejection either walks past the stage or runs it.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const hitHome = await mkdtemp(join(tmpdir(), 'dsh-route-hit-'))
const noneHome = await mkdtemp(join(tmpdir(), 'dsh-route-none-'))
const flowHome = await mkdtemp(join(tmpdir(), 'dsh-route-flow-'))
const rejectHome = await mkdtemp(join(tmpdir(), 'dsh-route-reject-'))
const execCwd = await mkdtemp(join(tmpdir(), 'dsh-route-cwd-'))

/** One dynamic overlay per scenario: steward + executor configs, and a webserver port that never collides with a running desktop instance. */
async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'route.patch.yml')
  await writeFile(overlayPath, [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
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
  return overlayPath
}

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

/** One adaptive turn: eval, route, skip, executor, and review prompts share one adapter. */
function adaptiveTurn(pick: { ruleId?: string; none?: boolean; skip?: { readonly skip: boolean; readonly rationale: string } }): (options: GenerateOptions) => StreamChunk[] {
  let dispatches = 0
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (tail.includes('Evaluate the pending changes')) {
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
    if (tail.includes('Route the accepted ticket')) {
      return toolCallsResponse([{
        name: 'record_route',
        args: { ...(pick.ruleId === undefined ? {} : { ruleId: pick.ruleId }), ...(pick.none === true ? { none: true } : {}), rationale: 'the routed call' },
      }])
    }
    if (tail.includes('Decide whether pipeline stage')) {
      return toolCallsResponse([{
        name: 'decide_skip',
        args: pick.skip === undefined
          ? { skip: false, rationale: 'the stage is needed' }
          : { skip: pick.skip.skip, rationale: pick.skip.rationale },
      }])
    }
    if (tail.includes('executor dispatched for ticket')) {
      dispatches += 1
      return toolCallsResponse([
        { name: 'present', args: { files: [{ path: 'stage-note.md', description: 'The stage note' }] } },
        { name: 'submit_report', args: { kind: 'ready', message: 'the stage work is complete' } },
      ])
    }
    if (tail.includes('review')) {
      return toolCallsResponse([{ name: 'record_review', args: { verdict: 'pass', feedback: 'meets the mandate', dispatchId: 'unknown' } }])
    }
    return textResponse('done')
  }
}

/** Scripted adapter: one adaptive function serves every model call. */
class AdaptiveAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private entry: (options: GenerateOptions) => StreamChunk[]) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.entry(options)) yield chunk
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

/** Seed one member, one pipeline, and one rule; return the ids. */
async function seedRoute(ctx: Context): Promise<{ memberId: string; pipelineId: string; ruleId: string }> {
  const { member } = await ctx.dshManagerCrew.crewAdd({
    name: 'Stage Worker',
    role: 'execute the stage work carefully and report what you did',
  })
  const { pipeline } = await ctx.dshManagerPipeline.pipelineAdd({
    name: 'Test line',
    stages: [{ memberId: member.id, instruction: 'produce the stage note' }],
  })
  const { rule } = await ctx.dshManagerRoute.ruleAdd({
    condition: 'any testing task that needs a stage run',
    pipelineId: pipeline.id,
  })
  return { memberId: member.id, pipelineId: pipeline.id, ruleId: rule.id }
}

/** Seed one member, one three-stage pipeline (the middle stage is skippable), and one rule; return the ids. */
async function seedFlow(ctx: Context): Promise<{ memberId: string; pipelineId: string; ruleId: string }> {
  const { member } = await ctx.dshManagerCrew.crewAdd({
    name: 'Stage Worker',
    role: 'execute the stage work carefully and report what you did',
  })
  const { pipeline } = await ctx.dshManagerPipeline.pipelineAdd({
    name: 'Test line',
    stages: [
      { memberId: member.id, instruction: 'produce the stage note' },
      { memberId: member.id, instruction: 'write the stage docs', skippable: true, skipLogic: 'skip when the mandate does not mention documentation' },
      { memberId: member.id, instruction: 'final check of the stage note' },
    ],
  })
  const { rule } = await ctx.dshManagerRoute.ruleAdd({
    condition: 'any testing task that needs a stage run',
    pipelineId: pipeline.id,
  })
  return { memberId: member.id, pipelineId: pipeline.id, ruleId: rule.id }
}

/** The accepted ticket of the polled thread, waiting until it exists. */
async function acceptedTicketOf(ctx: Context): Promise<{ id: string; flow?: { pipelineId: string; pipelineName: string; stageIndex: number; stageCount: number } }> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    const ticket = tickets[0]
    if (ticket !== undefined) return ticket
    if (Date.now() > deadline) throw new Error('the accepted ticket never minted')
    await new Promise(resolve => { setTimeout(resolve, 200) })
  }
}

/** Poll until the finder returns a value; the walk and the attention queue move on their own schedule. */
async function waitFor<T>(poll: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} never happened`)
    await new Promise(resolve => { setTimeout(resolve, 200) })
  }
}

/** The review scheduler is the steward's tick, which the test config parks; the poll drives it instead. */
async function waitForReview<T>(ctx: Context, poll: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await ctx.dshManagerSteward.reviewPending()
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} never happened`)
    await new Promise(resolve => { setTimeout(resolve, 200) })
  }
}

interface FlowPick {
  ruleId?: string
  none?: boolean
  skip?: { readonly skip: boolean; readonly rationale: string }
}

/** Boot one flow scenario: seed the three-stage pipeline, feed one trigger, and let the steward accept and route it. */
async function bootFlow(home: string, port: number, skip?: { readonly skip: boolean; readonly rationale: string }): Promise<Context> {
  const overlayPath = await writeOverlay(home, port)
  let pick: FlowPick = {}
  const adapter = new AdaptiveAdapter(options => adaptiveTurn(pick)(options))
  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home })
  await waitUntilService(ctx, 'dshManagerSteward')
  ctx.llm.registerAdapter(['mock'], adapter)
  const ids = await seedFlow(ctx)
  pick = { ruleId: ids.ruleId, ...(skip === undefined ? {} : { skip }) }
  const connection = await ctx.dshManagerConnections.connectionAdd({
    connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
  })
  const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
  await ctx.dshManagerSources.sourcePoll({ id: source.id })
  await ctx.dshManagerSteward.runPending()
  await acceptedTicketOf(ctx)
  return ctx
}

test(
  'a matched rule annotates the ticket with its flow and auto-dispatches stage 1 with the member prompt',
  async () => {
    const overlayPath = await writeOverlay(hitHome, 3091)
    // The rule id is generated at seed time, so the pick reads it lazily.
    let pick: { ruleId?: string; none?: boolean } = { ruleId: '' }
    const adapter = new AdaptiveAdapter((options) => adaptiveTurn(pick)(options))

    const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: hitHome })
    try {
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)

      const ids = await seedRoute(ctx)
      pick = { ruleId: ids.ruleId }

      const connection = await ctx.dshManagerConnections.connectionAdd({
        connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
      })
      const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
      await ctx.dshManagerSources.sourcePoll({ id: source.id })
      await ctx.dshManagerSteward.runPending()

      // The accepted ticket carries the flow annotation and auto-dispatched.
      const ticket = await acceptedTicketOf(ctx)
      expect(ticket.flow).toMatchObject({ pipelineId: ids.pipelineId, pipelineName: 'Test line', stageIndex: 0, stageCount: 1 })
      // Wait for the dispatch, then read the executor's session log (the
      // session goes cold after its turn, so read through the query layer).
      const deadline = Date.now() + 30_000
      let prompt = ''
      for (;;) {
        const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket.id })).dispatches
        const sessionId = dispatches[0]?.sessionId
        if (sessionId !== undefined) {
          // The query layer's Context declaration lives in the host's
          // session-query package, which the manager does not depend on —
          // read cold sessions through a structural seam instead.
          const query = ctx as unknown as {
            sessionQuery: { observeSession(id: string): Promise<{ readonly events: readonly unknown[] } & AsyncDisposable> }
          }
          await using observation = await query.sessionQuery.observeSession(sessionId)
          prompt = JSON.stringify(observation.events)
          if (prompt.includes('Stage Worker')) {
            expect(prompt).toContain('execute the stage work carefully')
            expect(prompt).toContain('produce the stage note')
            expect(prompt).toContain('stage 1 of 1')
            break
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`the routed executor prompt never appeared; dispatch=${JSON.stringify(dispatches[0] ?? null)} prompt=${prompt.slice(0, 300)}`)
        }
        await new Promise(resolve => { setTimeout(resolve, 200) })
      }
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

test(
  'a none pick raises the human attention and the ticket waits without a dispatch',
  async () => {
    const overlayPath = await writeOverlay(noneHome, 3092)
    const adapter = new AdaptiveAdapter(adaptiveTurn({ none: true }))
    const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: noneHome })
    try {
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)

      await seedRoute(ctx)
      const connection = await ctx.dshManagerConnections.connectionAdd({
        connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
      })
      const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
      await ctx.dshManagerSources.sourcePoll({ id: source.id })
      await ctx.dshManagerSteward.runPending()

      // The human's attention asks how to proceed; the ticket stays todo.
      const deadline = Date.now() + 30_000
      for (;;) {
        const attentions = (await ctx.dshManagerExecutor.attentionList({})).attentions
          .filter(attention => attention.status === 'pending')
        if (attentions.length > 0) {
          expect(attentions[0]!.question).toContain('no configured route fits')
          expect(attentions[0]!.question).toContain('add a route rule')
          break
        }
        if (Date.now() > deadline) throw new Error('the none pick never raised the attention')
        await new Promise(resolve => { setTimeout(resolve, 200) })
      }
      const ticket = await acceptedTicketOf(ctx)
      expect(ticket.flow).toBeUndefined()
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket.id })).dispatches
      expect(dispatches).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

test(
  'an approved skip walks the pipeline past the middle stage and finishes with the acceptance',
  async () => {
    const skip = { skip: true, rationale: 'the mandate does not mention documentation' }
    const ctx = await bootFlow(flowHome, 3093, skip)
    try {
      // The steward reviews the stage 1 result, walks on, and proposes
      // skipping stage 2 through its skip logic.
      const skipAttention = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({})).attentions
          .find(attention => attention.status === 'pending' && attention.question.startsWith('[skip]')), 'the skip proposal')
      expect(skipAttention.question).toContain('skip stage 2/3')
      expect(skipAttention.question).toContain('Test line')
      expect(skipAttention.details).toBe(skip.rationale)
      const walked = await acceptedTicketOf(ctx)
      expect(walked.flow).toMatchObject({ pipelineId: expect.any(String), stageIndex: 0, stageCount: 3 })
      // Nothing past stage 1 mints while the skip waits for the human.
      const waiting = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(waiting.filter(ticket => (ticket.flow?.stageIndex ?? 0) >= 1)).toHaveLength(0)
      // The human approves: the walk resumes past stage 2 and mints stage 3.
      await ctx.dshManagerExecutor.answerAttention({ attentionId: skipAttention.id, answer: 'confirmed' })
      const last = await waitFor(async () =>
        (await ctx.dshManagerBoard.ticketList()).tickets.find(ticket => ticket.flow?.stageIndex === 2), 'the stage 3 ticket')
      expect(last.flow).toMatchObject({
        pipelineName: 'Test line',
        stageIndex: 2,
        stageCount: 3,
        skipped: [{ stageIndex: 1, reason: skip.rationale }],
      })
      expect(last.title).toContain('Test line 3/3')
      // The markdown mirror in the executor cwd reflects the walk: the
      // pipeline, the approved skip's reason, and the walked stages.
      const mirror = await readFile(join(execCwd, '.dsh-manager', 'flows', `${walked.id}.md`), 'utf8')
      expect(mirror).toContain('# 流程进度：Test line')
      expect(mirror).toContain(`流程工单：${walked.id}`)
      expect(mirror).toContain('第 2 环节：the mandate does not mention documentation')
      expect(mirror).toContain(last.title)
      // The last stage dispatches, its review passes, and the acceptance asks.
      await waitFor(async () =>
        (await ctx.dshManagerExecutor.dispatchList({ ticketId: last.id })).dispatches.length > 0 ? true : undefined, 'the stage 3 dispatch')
      const acceptance = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({ ticketId: last.id })).attentions
          .find(attention => attention.status === 'pending' && attention.kind === 'review'), 'the final acceptance')
      expect(acceptance.question).toContain('acceptance requested')
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

test(
  'a rejected skip runs the middle stage without re-proposing the skip',
  async () => {
    const ctx = await bootFlow(rejectHome, 3094, { skip: true, rationale: 'documentation seems optional' })
    try {
      const skipAttention = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({})).attentions
          .find(attention => attention.status === 'pending' && attention.question.startsWith('[skip]')), 'the skip proposal')
      // The human refuses: the rejected stage runs, nothing counts as skipped.
      await ctx.dshManagerExecutor.answerAttention({ attentionId: skipAttention.id, answer: 'rejected: we need the docs' })
      const middle = await waitFor(async () =>
        (await ctx.dshManagerBoard.ticketList()).tickets.find(ticket => ticket.flow?.stageIndex === 1), 'the stage 2 ticket')
      expect(middle.flow).toMatchObject({ pipelineName: 'Test line', stageIndex: 1, stageCount: 3 })
      expect(middle.flow?.skipped).toBeUndefined()
      await waitFor(async () =>
        (await ctx.dshManagerExecutor.dispatchList({ ticketId: middle.id })).dispatches.length > 0 ? true : undefined, 'the stage 2 dispatch')
      const reProposals = (await ctx.dshManagerExecutor.attentionList({ ticketId: skipAttention.ticketId })).attentions
        .filter(attention => attention.status === 'pending' && attention.question.startsWith('[skip]'))
      expect(reProposals).toHaveLength(0)
      // The walk continues: stage 3 mints after the middle stage passes review.
      const last = await waitForReview(ctx, async () =>
        (await ctx.dshManagerBoard.ticketList()).tickets.find(ticket => ticket.flow?.stageIndex === 2), 'the stage 3 ticket')
      expect(last.flow?.skipped).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  // A freshly disposed webserver can still hold its storage files briefly;
  // a failed temp cleanup is not a test failure.
  for (const dir of [hitHome, noneHome, flowHome, rejectHome, execCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
