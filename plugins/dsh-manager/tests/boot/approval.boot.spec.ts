/**
 * Main-seam spec for action-level approvals (spec stories 38–44, ADR-0002):
 * the executor's external-write tools are intercepted at the harness
 * tool-call layer — the scripted executor calls `post_mr_comment` directly
 * (as a prompt telling it to "just post" would), an Approval attention
 * appears while the fake GitLab records nothing, approval replays the write
 * through the Channel exactly once, and a rejection with an opinion returns
 * the feedback to the executor while the fake Jira stays untouched.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-approval-boot-'))
const execCwd = await mkdtemp(join(tmpdir(), 'dsh-approval-cwd-'))

/** One recorded HTTP request against a fake forge. */
interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** A fake forge: records every request, answers 200 JSON. */
async function fakeForge(): Promise<{ requests: RecordedRequest[]; baseUrl: string; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 1 }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => { server.close(() => resolve()) }),
  }
}

const gitlab = await fakeForge()
const jira = await fakeForge()

const overlayPath = join(home, 'approval.patch.yml')
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
  '          turnTimeoutMs: 120000',
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

function executorReady(): StreamChunk[] {
  return toolCallsResponse([
    { name: 'submit_report', args: { kind: 'ready', message: 'the external action settled' } },
  ])
}

/**
 * One adaptive turn: title probes, Steward evals, and executor sessions
 * share one adapter. The executor attempts its external write directly (no
 * ask_user) — the interception must still fire; on the tool result it
 * reports ready, whether the write ran or the rejection denied it.
 */
function adaptiveTurn(connectionIds: { gitlab: string; jira: string }): (options: GenerateOptions) => Promise<StreamChunk[]> {
  let executorTurns = 0
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role === 'tool') {
      // The write succeeded (approval granted, body ran) or was denied with
      // the user's opinion in the reason; either way the executor reports.
      if (tail.includes('posted') || tail.includes('applied')) return executorReady()
      if (tail.includes('the user rejected')) return executorReady()
      return textResponse('the action was denied; ending the turn')
    }
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('Ticket ticket-')) {
      executorTurns += 1
      return executorTurns === 1
        ? toolCallsResponse([{
          name: 'post_mr_comment',
          args: { connectionId: connectionIds.gitlab, projectId: 7, iid: 42, body: 'LGTM from the executor' },
        }])
        : toolCallsResponse([{
          name: 'set_jira_status',
          args: { connectionId: connectionIds.jira, issueKey: 'PROJ-12', transitionId: '31' },
        }])
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

/** The pending approval attention of one ticket, once it appears. */
async function pendingApprovalOf(ctx: Context, ticketId: string): Promise<{ id: string; kind: string; status: string; question: string; action?: { category: string; tool: string; payload: unknown } | undefined }> {
  let found: { id: string; kind: string; status: string; question: string; action?: { category: string; tool: string; payload: unknown } | undefined } | undefined
  await vi.waitFor(async () => {
    const views = (await ctx.dshManagerExecutor.attentionList({ ticketId })).attentions
    const pending = views.find(view => view.status === 'pending' && view.kind === 'approval')
    if (pending !== undefined) found = pending
    expect(found).toBeDefined()
  }, { timeout: 15_000 })
  return found!
}

test(
  'an external write is intercepted, approved through the board, and replayed once; a rejection returns the opinion',
  async () => {
    const connectionIds = { gitlab: '', jira: '' }
    const adapter = new AdaptiveAdapter(adaptiveTurn(connectionIds))
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    // The two fakes are the only world the Channel writes into.
    const gitlabConnection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'gl', deployment: 'server-dc', baseUrl: gitlab.baseUrl, authMethod: 'pat', secret: 'gl-pat',
    })
    connectionIds.gitlab = gitlabConnection.id
    const jiraConnection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'jira', deployment: 'server-dc', baseUrl: jira.baseUrl, authMethod: 'basic', authIdentity: 'user@example.com', secret: 'jira-pass',
    })
    connectionIds.jira = jiraConnection.id

    // The comment flow: the executor attempts the write directly.
    await ctx.dshManagerSources.manualInput({ title: 'Comment the MR', description: 'Post the review comment' })
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    const ticketA = tickets[0]!.id

    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketA })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketA })
    }
    const approvalA = await pendingApprovalOf(ctx, ticketA)
    expect(approvalA.kind).toBe('approval')
    expect(approvalA.action?.tool).toBe('post_mr_comment')
    expect(approvalA.action?.category).toBe('comment')
    // The interception happened at the tool-call layer: no write reached
    // GitLab (the connection's GET probe is its own traffic).
    expect(gitlab.requests.filter(request => request.method === 'POST')).toHaveLength(0)
    // The ticket lifted into 待人工 while the approval is pending.
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketA)
      expect(card?.state).toBe('attention')
    })

    // The user approves; the Channel replays the write exactly once.
    await ctx.dshManagerExecutor.answerAttention({ attentionId: approvalA.id, answer: 'approved' })
    await vi.waitFor(async () => {
      expect(gitlab.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    }, { timeout: 20_000 })
    const write = gitlab.requests.find(request => request.method === 'POST')!
    expect(write.url).toContain('/api/v4/projects/7/merge_requests/42/notes')
    expect(JSON.parse(write.body)).toMatchObject({ body: 'LGTM from the executor' })
    await vi.waitFor(async () => {
      const ended = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketA })).dispatches
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    })
    expect(gitlab.requests.filter(request => request.method === 'POST')).toHaveLength(1)

    // The transition flow: intercepted the same way, rejected with an opinion.
    await ctx.dshManagerSources.manualInput({ title: 'Transition the issue', description: 'Move the Jira issue' })
    await ctx.dshManagerSteward.runPending()
    const ticketsAfter = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(ticketsAfter).toHaveLength(2)
    const ticketB = ticketsAfter.find(view => view.id !== ticketA)!.id

    if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketB })).dispatches.length === 0) {
      await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketB })
    }
    const approvalB = await pendingApprovalOf(ctx, ticketB)
    expect(approvalB.action?.tool).toBe('set_jira_status')
    expect(jira.requests.filter(request => request.method === 'POST')).toHaveLength(0)

    await ctx.dshManagerExecutor.answerAttention({ attentionId: approvalB.id, answer: 'rejected: use the API token first' })
    // The rejection denies the call: Jira stays untouched.
    await vi.waitFor(async () => {
      const ended = (await ctx.dshManagerExecutor.dispatchList({ ticketId: ticketB })).dispatches
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    })
    expect(jira.requests.filter(request => request.method === 'POST')).toHaveLength(0)
    // The opinion reached the record and drove the follow-up the adapter answered.
    const views = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticketB })).attentions
    expect(views[0]?.status).toBe('answered')
    expect(views[0]?.answer).toBe('rejected: use the API token first')
    // The ticket returned to 待办 once its attention resolved.
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticketB)
      expect(card?.state).toBe('todo')
    })

    await ctx.fiber.dispose()
  },
  180_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(execCwd, { recursive: true, force: true })
  await gitlab.close()
  await jira.close()
})
