/**
 * Main-seam spec for accept modes and inbox candidates: an inferred-evidence
 * acceptance under the default auto mode lands as a candidate (no ticket), a
 * repeated pass does not re-evaluate it, the user's acceptance mints the
 * ticket with a human-confirmed mandate, and observe mode offers even
 * explicit evidence as a candidate (spec stories 23, 25, 31, 32).
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
const home = await mkdtemp(join(tmpdir(), 'dsh-candidate-boot-'))
const observeHome = await mkdtemp(join(tmpdir(), 'dsh-candidate-observe-'))

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

function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('scripted adapter: request does not name an eval')
  return evalId
}

/** One reusable Steward turn whose decision carries the given strength. */
function stewardTurn(strength: 'explicit' | 'inferred'): (options: GenerateOptions) => StreamChunk[] {
  return options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Steward thread')
    if (last.role === 'user') {
      const callId = ToolCallId('call-1')
      const argumentsJson = JSON.stringify({
        action: 'accept',
        strength,
        title: 'Fix the login flow',
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
  'an inferred acceptance becomes a candidate and a human confirmation mints the ticket',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 8 }, () => stewardTurn('inferred')))
    ctx.llm.registerAdapter(['mock'], adapter)

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    // The default accept mode is auto: inferred evidence asks the human.
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    expect(source.acceptMode).toBe('auto')
    await ctx.dshManagerSources.sourcePoll({ id: source.id })

    await ctx.dshManagerSteward.runPending()
    const candidates = (await ctx.dshManagerSteward.candidateList()).candidates
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({
        title: 'Fix the login flow',
        externalKey: expect.stringMatching(/^PROJ-\d$/),
        strength: 'inferred',
      })
    }
    // No ticket yet; the inbox counts the waiting candidates.
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(0)
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(2)

    // A candidate covers its triggers: another pass evaluates nothing.
    const requestsAfterFirst = adapter.requests.length
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBe(requestsAfterFirst)

    // The user accepts one candidate: the ticket mints with a human-confirmed
    // mandate, and the confirmation lands on the audit trail.
    const evalId = candidates[0]!.evalId
    await ctx.dshManagerSteward.acceptCandidate({ evalId })
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      title: 'Fix the login flow',
      state: 'todo',
      mandate: { strength: 'explicit', scope: 'the triggered change', policyVersion: '1' },
    })
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(1)
    const decisions = await ctx.dshManagerSteward.listDecisions()
    const confirmation = decisions.find(record => record.evalId === evalId && record.rationale.includes('accepted by the user'))
    expect(confirmation).toMatchObject({ action: 'accept', strength: 'explicit' })

    // Accepting the same candidate again is an error, not a second ticket.
    await expect(ctx.dshManagerSteward.acceptCandidate({ evalId })).rejects.toThrow()
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(1)

    // The eval records page shows the accepted candidate as an accepted eval.
    const evals = (await ctx.dshManagerSteward.evalList({ status: 'candidate' })).evals
    expect(evals).toHaveLength(1)
    await ctx.fiber.dispose()
  },
  300_000,
)

test(
  'observe mode offers even explicit evidence as a candidate; off mode offers nothing',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: observeHome,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 8 }, () => stewardTurn('explicit')))
    ctx.llm.registerAdapter(['mock'], adapter)

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'observe-prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id, acceptMode: 'observe' })
    expect(source.acceptMode).toBe('observe')
    await ctx.dshManagerSources.sourcePoll({ id: source.id })

    // Observe mode: explicit evidence still waits for the human.
    await ctx.dshManagerSteward.runPending()
    expect((await ctx.dshManagerSteward.candidateList()).candidates).toHaveLength(2)
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(0)
    const requestsAfterFirst = adapter.requests.length
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBe(requestsAfterFirst)

    // Switching the instance to off: nothing new is offered, nothing mints.
    await ctx.dshManagerSources.sourceUpdate({ id: source.id, acceptMode: 'off' })
    const view = await ctx.dshManagerSources.sourceList()
    expect(view.sources[0]?.acceptMode).toBe('off')
    const evals = (await ctx.dshManagerSteward.evalList({ status: 'candidate' })).evals
    expect(evals).toHaveLength(2)
    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true })
  await rm(observeHome, { recursive: true, force: true })
})
