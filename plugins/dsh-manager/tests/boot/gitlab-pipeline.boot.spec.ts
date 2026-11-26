/**
 * Main-seam spec for the GitLab pipeline Source: a failing pipeline becomes a
 * Thread, the Steward's acceptance mints a ticket linking to the pipeline
 * page, a repeated poll never duplicates, and a re-run joins the same Thread
 * as fan-in without a second eval (spec stories 18, 24, 75).
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
const home = await mkdtemp(join(tmpdir(), 'dsh-gitlab-pipeline-boot-'))

/** The failed pipelines the fake GitLab currently reports; tests mutate it. */
let failedPipelines: { id: number; ref: string; status: string; updated_at: string; web_url: string }[] = []

const server: Server = createServer((request: IncomingMessage, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/api/v4/projects/group/alpha/pipelines' && url.searchParams.get('status') === 'failed') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(failedPipelines))
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

/** One reusable accept turn: a decision tool call on the eval prompt. */
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
        title: 'Pipeline failed on group/alpha',
        scope: 'the failed pipeline',
        rationale: 'a pipeline failure needs a fix',
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
  'a failed pipeline mints a ticket, repeats never duplicate, and a re-run fans into the same thread',
  async () => {
    failedPipelines = [{
      id: 101, ref: 'main', status: 'failed',
      updated_at: '2026-01-05T00:00:00.000Z', web_url: `${baseUrl}/group/alpha/-/pipelines/101`,
    }]
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 12 }, () => stewardTurn()))
    ctx.llm.registerAdapter(['mock'], adapter)

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'corp-gl', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'gl-pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({
      connectionId: connection.id, kind: 'gitlab-pipeline', projects: ['group/alpha'],
    })
    expect(source.kind).toBe('gitlab-pipeline')
    expect(source.projects).toEqual(['group/alpha'])

    // The poll collects the failed pipeline; one thread sits in the backlog.
    const first = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(first).toMatchObject({ added: 1, duplicates: 0 })
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(1)

    // The Steward accepts; the ticket links back to the pipeline page.
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      title: 'Pipeline failed on group/alpha',
      state: expect.stringMatching(/^(todo|running)$/),
      externalKey: 'group/alpha',
      url: `${baseUrl}/group/alpha/-/pipelines/101`,
    })
    const requestsAfterAccept = adapter.requests.length

    // A repeated poll of the same pipeline adds nothing.
    const repeat = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(repeat).toMatchObject({ added: 0, duplicates: 1 })

    // The pipeline re-runs and fails again: a new trigger on the same Thread.
    failedPipelines = [{
      id: 105, ref: 'main', status: 'failed',
      updated_at: '2026-01-06T00:00:00.000Z', web_url: `${baseUrl}/group/alpha/-/pipelines/105`,
    }]
    const rerun = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(rerun).toMatchObject({ added: 1, duplicates: 0 })

    // The live ticket is subscribed: the re-run fans in, no second eval, no second ticket.
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBe(requestsAfterAccept)
    const after = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(after).toHaveLength(1)
    expect(after[0]!.fanIn).toHaveLength(1)
    expect(after[0]!.fanIn![0]).toMatchObject({
      externalKey: 'group/alpha',
      url: `${baseUrl}/group/alpha/-/pipelines/105`,
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
