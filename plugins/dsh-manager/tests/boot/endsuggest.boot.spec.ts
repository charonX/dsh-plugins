/**
 * Main-seam spec for suggesting a ticket's end (spec story 66): the fake
 * GitLab's MR is merged, the Source collects the ended-state trigger and it
 * fans out to the subscribed ticket, the Steward's main Session marks the
 * ticket 建议结束 through its suggest_end tool — never ending it itself —
 * and the user's confirmation ends it.
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

/** Temp roots this file created; cleaned up after the suite. */
const tempRoots: string[] = []

/** The fake GitLab's mutable MR state; the test flips the MR to merged. */
const mrState = {
  opened: [] as readonly Record<string, unknown>[],
  merged: [] as readonly Record<string, unknown>[],
  closed: [] as readonly Record<string, unknown>[],
}

const MR = {
  iid: 5,
  project_id: 7,
  title: 'Fix the login flow',
  updated_at: '2026-11-13T09:00:00.000Z',
  web_url: 'http://127.0.0.1:1/group/alpha/-/merge_requests/5',
  references: { full: 'group/alpha!5' },
}

/** One fake GitLab: identity, per-state MR sweeps, no notes. */
const server: Server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const json = (body: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v4/user') return json({ id: 1, username: 'dsh-bot' })
  if (url.pathname === '/api/v4/merge_requests') {
    const state = url.searchParams.get('state')
    return json(state === 'merged' ? mrState.merged : state === 'closed' ? mrState.closed : mrState.opened)
  }
  if (/^\/api\/v4\/projects\/\d+\/merge_requests\/\d+\/notes$/.test(url.pathname)) return json([])
  response.writeHead(404)
  response.end('not found')
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
const gitlabPort = typeof address === 'object' && address !== null ? address.port : 0

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
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
 * One adaptive turn: title probes, the Steward's eval, and its end-suggestion
 * turns share one adapter. An end-suggestion turn suggests closing.
 */
function adaptiveTurn(): (options: GenerateOptions) => Promise<StreamChunk[]> {
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
    if (tail.includes('has ended.')) {
      return toolCallsResponse([{
        name: 'suggest_end',
        args: { ticketId: 'whatever the service is suggesting', reason: 'the merge request was merged' },
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

test(
  'a merged MR fans out to its ticket, the Steward marks 建议结束, and the user\'s confirmation ends the ticket',
  async () => {
    const adapter = new AdaptiveAdapter(adaptiveTurn())
    const home = await tempRoot('dsh-endsuggest-boot-')
    await writeFile(join(home, 'endsuggest.patch.yml'), [
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
      '',
    ].join('\n'))
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'endsuggest.patch.yml')], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    // The open MR is collected and accepted into a ticket.
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'gl', deployment: 'server-dc', baseUrl: `http://127.0.0.1:${gitlabPort}`, authMethod: 'pat', secret: 'gl-pat',
    })
    await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id, kind: 'gitlab-mr' })
    mrState.opened = [MR]
    mrState.merged = []
    const pollOpen = await ctx.dshManagerSources.sourcePoll({ id: (await ctx.dshManagerSources.sourceList()).sources[0]!.id })
    expect(pollOpen.added).toBe(1)
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    const ticket = tickets[0]!
    expect(ticket.state).toBe('todo')

    // The MR is merged: the next sweep collects the ended-state trigger and
    // it fans out to the subscribed ticket as context.
    mrState.opened = []
    mrState.merged = [{ ...MR, updated_at: '2026-11-13T10:00:00.000Z', state: 'merged' }]
    const pollMerged = await ctx.dshManagerSources.sourcePoll({ id: (await ctx.dshManagerSources.sourceList()).sources[0]!.id })
    expect(pollMerged.added).toBe(1)
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticket.id)
      expect(card?.fanIn).toHaveLength(1)
    })

    // The Steward marks 建议结束: a suggest-end attention appears, the ticket
    // lifts into 待人工, and it is not ended.
    await ctx.dshManagerSteward.runEndSuggestions()
    const attentions = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket.id })).attentions
    expect(attentions).toHaveLength(1)
    expect(attentions[0]?.kind).toBe('suggest-end')
    expect(attentions[0]?.status).toBe('pending')
    expect(attentions[0]?.details).toBe('the merge request was merged')
    await vi.waitFor(async () => {
      const card = (await ctx.dshManagerBoard.ticketList()).tickets.find(view => view.id === ticket.id)
      expect(card?.state).toBe('attention')
    })
    expect(ctx.dshManagerBoard.ticketRecord(ticket.id)?.state).not.toBe('ended')

    // The suggestion is not repeated for the same ticket.
    await ctx.dshManagerSteward.runEndSuggestions()
    expect((await ctx.dshManagerExecutor.attentionList({ ticketId: ticket.id })).attentions).toHaveLength(1)

    // The user confirms: only then does the ticket end.
    await ctx.dshManagerExecutor.answerAttention({ attentionId: attentions[0]!.id, answer: 'confirmed' })
    await vi.waitFor(async () => {
      expect(ctx.dshManagerBoard.ticketRecord(ticket.id)?.state).toBe('ended')
    }, { timeout: 15_000 })

    await ctx.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})
