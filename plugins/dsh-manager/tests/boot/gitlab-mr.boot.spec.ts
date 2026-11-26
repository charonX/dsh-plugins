/**
 * Main-seam spec for the GitLab MR Source: an assigned MR becomes a Thread,
 * the Steward's acceptance mints a ticket, and a follow-up comment on the
 * same MR fans into that ticket as context — no new ticket, no new eval
 * (spec stories 17 and 34).
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
const home = await mkdtemp(join(tmpdir(), 'dsh-gitlab-mr-boot-'))

const MR_1 = {
  iid: 12,
  project_id: 7,
  title: 'Fix the login flow',
  state: 'opened',
  updated_at: '2026-01-01T00:00:00.000Z',
  web_url: 'https://gl.example.com/group/alpha/-/merge_requests/12',
  references: { full: 'group/alpha!12' },
}
const notes: { id: number; body: string; created_at: string; author: { username: string } }[] = []

const server: Server = createServer((request: IncomingMessage, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const json = (body: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/v4/user') {
    json({ id: 1, username: 'test-user' })
    return
  }
  if (url.pathname === '/api/v4/merge_requests') {
    json(url.searchParams.get('scope') === 'assigned_to_me' ? [MR_1] : [])
    return
  }
  if (url.pathname === '/api/v4/projects/7/merge_requests/12/notes') {
    json(notes)
    return
  }
  response.writeHead(404)
  response.end('not found')
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

/** The eval id the Steward named in the turn prompt of this request. */
function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('scripted adapter: request does not name an eval')
  return evalId
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

/**
 * One reusable Steward turn: an accept tool call on the eval prompt, a plain
 * closing text on the tool result, and a title for the harness's title probe.
 */
function stewardTurn(): (options: GenerateOptions) => StreamChunk[] {
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Steward thread')
    if (JSON.stringify(options.messages.slice(-2)).includes('executor dispatched')) return textResponse('done')
    if (last.role === 'user') {
      const callId = ToolCallId('call-1')
      const argumentsJson = JSON.stringify({
        action: 'accept',
        strength: 'explicit',
        title: 'Fix the login flow',
        scope: 'the assigned MR',
        rationale: 'the MR is assigned to me',
        evalId: evalIdOf(options),
      })
      return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'record_decision', argumentsDelta: argumentsJson.slice(0, 5) },
        { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'record_decision', arguments: argumentsJson } },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    }
    return textResponse('done')
  }
}

/** Scripted adapter: every model call consumes the next entry and is recorded. */
class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private script: ((options: GenerateOptions) => StreamChunk[])[]) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('scripted adapter: script exhausted')
    for (const chunk of entry(options)) yield chunk
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
  'an assigned MR mints one ticket and follow-up comments fan into it without a second eval',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 12 }, () => stewardTurn()))
    ctx.llm.registerAdapter(['mock'], adapter)

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'corp-gl', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'gl-pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id, kind: 'gitlab-mr' })
    expect(source.kind).toBe('gitlab-mr')

    // The poll collects the assigned MR; one thread sits in the inbox backlog.
    const first = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(first).toMatchObject({ added: 1, duplicates: 0 })
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(1)

    // The Steward accepts the assigned MR; one todo ticket appears.
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      title: 'Fix the login flow',
      state: expect.stringMatching(/^(todo|running)$/),
      externalKey: 'group/alpha!12',
      sourceConnectionId: connection.id,
    })
    expect(tickets[0]!.fanIn).toBeUndefined()
    const requestsAfterAccept = adapter.requests.length
    expect(requestsAfterAccept).toBeGreaterThanOrEqual(2)

    // A reviewer comments on the same MR: one new trigger, one fan-in.
    notes.push({ id: 3, body: 'looks good, one nit', created_at: '2026-01-03T00:00:00.000Z', author: { username: 'reviewer-1' } })
    // The MR trigger re-fingerprints as a duplicate; the note is the new one.
    const second = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(second).toMatchObject({ added: 1, duplicates: 1 })

    // The subscribed thread skips the eval backlog: no new eval, no new ticket.
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBe(requestsAfterAccept)
    const after = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(after).toHaveLength(1)
    expect(after[0]!.fanIn).toHaveLength(1)
    expect(after[0]!.fanIn![0]).toMatchObject({
      externalKey: 'group/alpha!12',
      url: 'https://gl.example.com/group/alpha/-/merge_requests/12#note_3',
    })
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(0)
    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true })
})
