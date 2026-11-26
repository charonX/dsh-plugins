/**
 * Main-seam spec for manual input: the user's own request becomes a `manual`
 * trigger, walks the normal eval path, and the Steward's acceptance — not
 * the form — mints the ticket with the optional project attached
 * (spec story 35).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, 'steward.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'dsh-manual-input-boot-'))

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

/** One reusable accept turn. */
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
        title: 'Write the release note',
        scope: 'the release documents',
        rationale: 'the user asked for it directly',
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
  'a manual entry walks the eval path and becomes a ticket with the named project',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerSteward')
    const adapter = new ScriptedAdapter(Array.from({ length: 12 }, () => stewardTurn()))
    ctx.llm.registerAdapter(['mock'], adapter)

    // The manual entry needs no connection or external system.
    const { threadId } = await ctx.dshManagerSources.manualInput({
      title: 'Write the release note',
      description: 'Summarize the shipped changes for the users',
      projectId: 'proj-alpha',
    })
    expect(threadId).toMatch(/^thr-/)

    // The entry queues one inbox thread and the Steward evaluates it.
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(1)
    await ctx.dshManagerSteward.runPending()
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)

    // The eval — not the form — minted the ticket, carrying the named project.
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      title: 'Write the release note',
      state: expect.stringMatching(/^(todo|running)$/),
      projectId: 'proj-alpha',
      threadId,
      mandate: { strength: 'explicit', scope: 'the release documents', policyVersion: '1' },
    })
    expect(tickets[0]!.externalKey).toMatch(/^manual-/)
    expect((await ctx.dshManagerBoard.summary()).columns.find(column => column.id === 'inbox')?.count).toBe(0)

    // The decision is on the audit trail like any other eval.
    const decisions = await ctx.dshManagerSteward.listDecisions()
    expect(decisions[0]).toMatchObject({ action: 'accept', strength: 'explicit', threadId })
    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})
