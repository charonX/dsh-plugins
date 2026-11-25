/**
 * Main-seam spec for the board filter (spec story 33): one accepted Jira
 * ticket and one accepted manual ticket coexist, and the combined
 * connection/project/kind filter returns the intersection both on
 * `ticketList` and on the `summary` column counts.
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
const home = await mkdtemp(join(tmpdir(), 'dsh-board-filter-boot-'))

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

/** The eval id the Steward named in the turn prompt of this request. */
function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('scripted adapter: request does not name an eval')
  return evalId
}

/** One reusable Steward turn: a decision tool call on the eval prompt, a plain closing text otherwise. */
function stewardTurn(): (options: GenerateOptions) => StreamChunk[] {
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const serialized = JSON.stringify(last)
    if (serialized.includes('Generate the session title')) return textResponse('Steward thread')
    if (last.role === 'user') {
      const callId = ToolCallId('call-1')
      const argumentsJson = JSON.stringify({
        action: 'accept',
        strength: 'explicit',
        title: 'Accepted work',
        scope: 'the triggered change',
        rationale: 'the triggers support this work',
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
  'the combined board filter narrows tickets to the matching connection, project, and kind',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 8 }, () => stewardTurn()))
    ctx.llm.registerAdapter(['mock'], adapter)

    // The Jira side: one connection, one source, one poll, one accepted ticket.
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })
    await ctx.dshManagerSteward.runPending()

    // The manual side: one entry with a project, accepted by the same Steward.
    await ctx.dshManagerSources.manualInput({
      title: 'Write the release note',
      description: 'Summarize the shipped changes for the users',
      projectId: 'proj-alpha',
    })
    await ctx.dshManagerSteward.runPending()

    const unfiltered = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(unfiltered).toHaveLength(2)
    const jira = unfiltered.find(ticket => ticket.sourceConnectionId === connection.id)
    const manual = unfiltered.find(ticket => ticket.projectId === 'proj-alpha')
    expect(jira).toBeDefined()
    expect(manual).toBeDefined()
    expect(jira!.externalKey).toBe('PROJ-1')
    expect(manual!.externalKey).toMatch(/^manual-/)

    // The connection filter keeps only the Jira ticket; the manual one rides
    // the singleton `manual` pseudo-connection.
    const byConnection = (await ctx.dshManagerBoard.ticketList({ connectionId: connection.id })).tickets
    expect(byConnection).toHaveLength(1)
    expect(byConnection[0]!.id).toBe(jira!.id)
    expect((await ctx.dshManagerBoard.ticketList({ connectionId: 'manual' })).tickets.map(ticket => ticket.id))
      .toEqual([manual!.id])

    // The project filter keeps only the manual ticket (Jira carries none).
    const byProject = (await ctx.dshManagerBoard.ticketList({ projectId: 'proj-alpha' })).tickets
    expect(byProject).toHaveLength(1)
    expect(byProject[0]!.id).toBe(manual!.id)

    // The kind filter separates the threads' source kinds.
    expect((await ctx.dshManagerBoard.ticketList({ kind: 'jira' })).tickets.map(ticket => ticket.id))
      .toEqual([jira!.id])
    expect((await ctx.dshManagerBoard.ticketList({ kind: 'manual' })).tickets.map(ticket => ticket.id))
      .toEqual([manual!.id])

    // Combined fields intersect: a Jira connection with a manual kind matches nothing.
    expect((await ctx.dshManagerBoard.ticketList({ connectionId: connection.id, kind: 'jira' })).tickets.map(ticket => ticket.id))
      .toEqual([jira!.id])
    expect((await ctx.dshManagerBoard.ticketList({ connectionId: connection.id, kind: 'manual' })).tickets).toHaveLength(0)

    // The summary's column counts follow the same filter.
    expect((await ctx.dshManagerBoard.summary({ kind: 'jira' })).columns.find(column => column.id === 'todo')?.count).toBe(1)
    expect((await ctx.dshManagerBoard.summary({ kind: 'manual' })).columns.find(column => column.id === 'todo')?.count).toBe(1)
    expect((await ctx.dshManagerBoard.summary({ projectId: 'proj-alpha' })).columns.find(column => column.id === 'todo')?.count).toBe(1)
    expect((await ctx.dshManagerBoard.summary({ connectionId: connection.id, kind: 'manual' })).columns.find(column => column.id === 'todo')?.count).toBe(0)

    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true })
})
