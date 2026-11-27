/**
 * Main-seam spec for Flow IR routing and step walks:
 * 1) An accepted ticket routed to a Flow IR annotates the ticket and dispatches Step 1 with skills + goal.
 * 2) `none: true` (or unmatched flow) falls back immediately to single-step generic execution without raising a blocking Attention.
 * 3) A 3-step Flow IR with `humanConfirm` on Step 1 pauses cleanly for human approval (`approved`),
 *    advances deterministically through Step 2, runs Step 3's `onFail` review gate, and asks final acceptance.
 * 4) Rejecting `humanConfirm` re-dispatches the current step with human feedback before continuing.
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

/** One adaptive turn: eval, route, executor, and review prompts share one adapter. */
function adaptiveTurn(pick: { flowId?: string; none?: boolean }): (options: GenerateOptions) => StreamChunk[] {
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
    if (tail.includes('Route ticket ')) {
      return toolCallsResponse([{
        name: 'record_route',
        args: { ...(pick.flowId === undefined ? {} : { flowId: pick.flowId }), ...(pick.none === true ? { none: true } : {}), rationale: 'the routed call' },
      }])
    }
    if (tail.includes('工单 ticket-')) {
      return toolCallsResponse([
        { name: 'present', args: { files: [{ path: 'stage-note.md', description: 'The stage note' }] } },
        { name: 'submit_report', args: { kind: 'ready', message: 'the stage work is complete' } },
      ])
    }
    if (tail.includes('Review the finished work on ticket')) {
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

/** Seed a single-step Flow IR rule; return its id. */
async function seedRoute(ctx: Context): Promise<{ flowId: string }> {
  const { flow } = await ctx.dshManagerFlow.flowAdd({
    name: 'Test line',
    when: 'any testing task that needs a stage run',
    workspaceMode: 'in-place',
    steps: [{
      id: 'stage-1',
      name: 'Stage Worker',
      skills: ['tdd'],
      goal: 'produce the stage note',
    }],
  })
  return { flowId: flow.id }
}

/** Seed a three-step Flow IR (Step 1 requires `humanConfirm`, Step 3 gates Step 2 via `onFail`); return its id. */
async function seedFlow(ctx: Context): Promise<{ flowId: string }> {
  const { flow } = await ctx.dshManagerFlow.flowAdd({
    name: 'Test line',
    when: 'any testing task that needs a stage run',
    workspaceMode: 'in-place',
    steps: [
      { id: 'plan', name: 'Align & Plan', skills: ['how'], goal: 'produce the outline', readOnly: true, humanConfirm: true },
      { id: 'draft', name: 'Draft Work', skills: ['tdd'], goal: 'produce the stage note' },
      { id: 'review', name: 'Review Check', skills: ['verify'], goal: 'final check of the stage note', readOnly: true, onFail: 'draft' },
    ],
  })
  return { flowId: flow.id }
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
  flowId?: string
  none?: boolean
}

/** Boot one flow scenario: seed the three-step Flow IR, feed one trigger, and let the steward accept and route it. */
async function bootFlow(home: string, port: number): Promise<Context> {
  const overlayPath = await writeOverlay(home, port)
  let pick: FlowPick = {}
  const adapter = new AdaptiveAdapter(options => adaptiveTurn(pick)(options))
  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home })
  await waitUntilService(ctx, 'dshManagerSteward')
  ctx.llm.registerAdapter(['mock'], adapter)
  const ids = await seedFlow(ctx)
  pick = { flowId: ids.flowId }
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
  'a matched flow annotates the ticket and auto-dispatches step 1 with mounted skills and goal',
  async () => {
    const overlayPath = await writeOverlay(hitHome, 3091)
    let pick: FlowPick = { flowId: '' }
    const adapter = new AdaptiveAdapter((options) => adaptiveTurn(pick)(options))

    const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: hitHome })
    try {
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)

      const ids = await seedRoute(ctx)
      pick = { flowId: ids.flowId }

      const connection = await ctx.dshManagerConnections.connectionAdd({
        connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
      })
      const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
      await ctx.dshManagerSources.sourcePoll({ id: source.id })
      await ctx.dshManagerSteward.runPending()

      const ticket = await acceptedTicketOf(ctx)
      expect(ticket.flow).toMatchObject({ pipelineId: ids.flowId, pipelineName: 'Test line', stageIndex: 0, stageCount: 1 })
      const deadline = Date.now() + 30_000
      let prompt = ''
      for (;;) {
        const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket.id })).dispatches
        const sessionId = dispatches[0]?.sessionId
        if (sessionId !== undefined) {
          const query = ctx as unknown as {
            sessionQuery: { observeSession(id: string): Promise<{ readonly events: readonly unknown[] } & AsyncDisposable> }
          }
          await using observation = await query.sessionQuery.observeSession(sessionId)
          prompt = JSON.stringify(observation.events)
          if (prompt.includes('Stage Worker')) {
            expect(prompt).toContain('produce the stage note')
            expect(prompt).toContain('tdd')
            expect(prompt).toContain('第 1/1 步')
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
  'a none pick falls back directly to single-step generic execution without raising a blocking attention',
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

      const ticket = await acceptedTicketOf(ctx)
      expect(ticket.flow).toBeUndefined()
      const dispatches = await waitFor(async () => {
        const list = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket.id })).dispatches
        return list.some(d => d.outcome === 'ready') ? list : undefined
      }, 'single-step fallback dispatch')
      expect(dispatches).toHaveLength(1)

      const blockingRouteAsks = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket.id })).attentions
        .filter(attention => attention.status === 'pending' && attention.dispatchId === 'steward' && attention.question.includes('no configured'))
      expect(blockingRouteAsks).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

test(
  'humanConfirm pauses Step 1 until approved, walks Step 2 without gate LLM, and finishes Step 3 with acceptance',
  async () => {
    const ctx = await bootFlow(flowHome, 3093)
    try {
      // Wait for Step 1 to finish and ask for `humanConfirm` before minting Step 2.
      const confirmAttention = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({})).attentions
          .find(attention => attention.status === 'pending' && attention.kind === 'review' && attention.question.includes('confirm step 1/3')),
        'step 1 humanConfirm gate')
      expect(confirmAttention.question).toContain('Align & Plan')
      expect(confirmAttention.question).toContain('Test line')
      const walked = await acceptedTicketOf(ctx)
      expect(walked.flow).toMatchObject({ pipelineId: expect.any(String), stageIndex: 0, stageCount: 3 })
      const waiting = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(waiting.filter(ticket => (ticket.flow?.stageIndex ?? 0) >= 1)).toHaveLength(0)

      // Human approves -> walks Step 2 (no gate LLM) -> Step 3 -> final acceptance!
      await ctx.dshManagerExecutor.answerAttention({ attentionId: confirmAttention.id, answer: 'approved' })
      const step3 = await waitForReview(ctx, async () =>
        (await ctx.dshManagerBoard.ticketList()).tickets.find(ticket => ticket.flow?.stageIndex === 2), 'the step 3 ticket')
      expect(step3.flow).toMatchObject({
        pipelineName: 'Test line',
        stageIndex: 2,
        stageCount: 3,
      })
      expect(step3.title).toContain('Test line 3/3')

      const mirror = await readFile(join(execCwd, '.dsh-manager', 'flows', `${walked.id}.md`), 'utf8')
      expect(mirror).toContain('# 流程进度：Test line')
      expect(mirror).toContain(`流程工单：${walked.id}`)
      expect(mirror).toContain(step3.title)

      await waitFor(async () =>
        (await ctx.dshManagerExecutor.dispatchList({ ticketId: step3.id })).dispatches.some(d => d.state === 'ended') ? true : undefined, 'the step 3 dispatch')
      const acceptance = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({ ticketId: step3.id })).attentions
          .find(attention => attention.status === 'pending' && attention.kind === 'review'), 'the final acceptance')
      expect(acceptance.question).toContain('acceptance requested')
    } finally {
      await ctx.fiber.dispose()
    }
  },
  300_000,
)

test(
  'rejecting humanConfirm re-runs the current step with feedback before continuing',
  async () => {
    const ctx = await bootFlow(rejectHome, 3094)
    try {
      const confirmAttention = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({})).attentions
          .find(attention => attention.status === 'pending' && attention.kind === 'review' && attention.question.includes('confirm step 1/3')),
        'step 1 confirmation')
      const step1TicketId = confirmAttention.ticketId

      // Human rejects Step 1 with feedback -> re-dispatches Step 1 without minting Step 2 yet.
      await ctx.dshManagerExecutor.answerAttention({ attentionId: confirmAttention.id, answer: 'rejected: add failure mode table' })
      await waitFor(async () =>
        (await ctx.dshManagerExecutor.dispatchList({ ticketId: step1TicketId })).dispatches.length >= 2 ? true : undefined,
        'step 1 rework dispatch')
      const noStep2Yet = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(noStep2Yet.some(t => (t.flow?.stageIndex ?? 0) >= 1)).toBe(false)

      // Approve the second attempt -> flow advances through Step 2 and Step 3.
      const secondConfirm = await waitForReview(ctx, async () =>
        (await ctx.dshManagerExecutor.attentionList({ ticketId: step1TicketId })).attentions
          .find(attention => attention.status === 'pending' && attention.kind === 'review' && attention.question.includes('confirm step 1/3')),
        'second confirmation after rework')
      await ctx.dshManagerExecutor.answerAttention({ attentionId: secondConfirm.id, answer: 'approved' })
      const step3 = await waitForReview(ctx, async () =>
        (await ctx.dshManagerBoard.ticketList()).tickets.find(ticket => ticket.flow?.stageIndex === 2), 'step 3 ticket after approval')
      expect(step3.flow?.stageIndex).toBe(2)
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
