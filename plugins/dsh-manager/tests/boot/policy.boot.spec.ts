/**
 * Main-seam spec for the versioned Policy and its decision records (spec
 * stories 45–48): the Steward proposes a standing rejection through its
 * propose_policy tool, the user's confirmation mints the next version, and
 * the same kind of trigger afterwards decides ignore on the binding record —
 * while a direct policy write from the session fails and changes nothing.
 */
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

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function testHome(): Promise<string> {
  const home = await tempRoot('dsh-policy-boot-')
  const execCwd = await tempRoot('dsh-policy-cwd-')
  await writeFile(join(home, 'policy.patch.yml'), [
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
    `          cwd: ${JSON.stringify(execCwd)}`,
    '',
  ].join('\n'))
  return home
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

/** The script one adaptive turn plays against. */
interface PolicyPlan {
  /** Whether the binding rejection record reached an eval prompt. */
  evalSawRejection: boolean
  /** Whether the session attempted a direct policy write. */
  directWriteAttempted: boolean
}

/** One adaptive turn: title probes, Steward evals and reviews share one adapter. */
function adaptiveTurn(plan: PolicyPlan): (options: GenerateOptions) => Promise<StreamChunk[]> {
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') return textResponse('done')
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) {
      if (tail.includes('依赖升级 MR 一律不接')) plan.evalSawRejection = true
      return toolCallsResponse([{
        name: 'record_decision',
        args: {
          action: tail.includes('依赖升级 MR 一律不接') ? 'ignore' : 'accept',
          strength: 'explicit',
          title: 'Accepted work',
          scope: 'the triggered change',
          rationale: tail.includes('依赖升级 MR 一律不接') ? 'the decision record rejects it' : 'the triggers support this work',
          evalId: evalIdOf(options),
        },
      }])
    }
    if (tail.includes('Review the finished work on ticket')) {
      return toolCallsResponse([
        { name: 'record_review', args: { verdict: 'pass', feedback: 'meets the mandate', dispatchId: 'whatever' } },
        {
          name: 'propose_policy',
          args: { change: 'add-rejection', statement: '依赖升级 MR 一律不接', rationale: 'the user declined the same work twice' },
        },
      ])
    }
    if (tail.includes('Ticket ticket-')) {
      return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: 'the work is done' } }])
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

async function awaitReady(ctx: Context, ticketId: string): Promise<void> {
  await vi.waitFor(async () => {
    const view = (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches[0]
    expect(view?.state).toBe('ended')
    expect(view?.outcome).toBe('ready')
  }, { timeout: 15_000 })
}

test(
  'a proposed rejection confirms into a new version, and the same kind of trigger afterwards decides ignore',
  async () => {
    const plan: PolicyPlan = { evalSawRejection: false, directWriteAttempted: false }
    const adapter = new AdaptiveAdapter(adaptiveTurn(plan))
    const home = await testHome()
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'policy.patch.yml')], home,
    })
    try {
      await waitUntilService(ctx, 'dshManagerExecutor')
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)

      // The initial eval runs with no decision records on file.
      const before = (await ctx.dshManagerPolicy.policyList()).policies
      expect(before).toHaveLength(1)
      expect(before[0]?.version).toBe('1')
      expect(before[0]?.decisions).toEqual([])

      // A dependency-upgrade thread is accepted and its work passes review;
      // the review turn proposes the standing rejection.
      await ctx.dshManagerSources.manualInput({ title: 'Upgrade the dependency', description: 'Bump the framework' })
      await ctx.dshManagerSteward.runPending()
      const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(tickets).toHaveLength(1)
      const ticket = tickets[0]!.id
      if ((await ctx.dshManagerExecutor.dispatchList({ ticketId: ticket })).dispatches.length === 0) {
        await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket })
      }
      await awaitReady(ctx, ticket)
      await ctx.dshManagerSteward.reviewPending()

      // The proposal is an attention, not a write: still only version 1.
      expect((await ctx.dshManagerPolicy.policyList()).policies).toHaveLength(1)
      const proposals = (await ctx.dshManagerExecutor.attentionList({})).attentions
        .filter(attention => attention.kind === 'policy' && attention.status === 'pending')
      expect(proposals).toHaveLength(1)
      expect(proposals[0]?.question).toContain('依赖升级 MR 一律不接')

      // The user confirms: version 2 carries the rejection record.
      await ctx.dshManagerExecutor.answerAttention({ attentionId: proposals[0]!.id, answer: 'approved' })
      const versions = (await ctx.dshManagerPolicy.policyList()).policies
      expect(versions).toHaveLength(2)
      expect(versions[0]?.version).toBe('2')
      expect(versions[0]?.decisions).toEqual([
        { id: expect.any(String), kind: 'rejection', statement: '依赖升级 MR 一律不接', createdAt: expect.any(Number) },
      ])
      // The diff between the versions names the new record.
      const { diff } = await ctx.dshManagerPolicy.policyDiff({ from: '1', to: '2' })
      expect(diff.entriesAdded.map(entry => entry.statement)).toEqual(['依赖升级 MR 一律不接'])

      // The same kind of trigger afterwards decides ignore on the binding record.
      await ctx.dshManagerSources.manualInput({ title: 'Upgrade lodash', description: 'Bump lodash to the next minor' })
      await ctx.dshManagerSteward.runPending()
      expect(plan.evalSawRejection).toBe(true)
      const decisions = await ctx.dshManagerSteward.listDecisions()
      expect(decisions[0]?.action).toBe('ignore')
      const evals = (await ctx.dshManagerSteward.evalList({ action: 'ignore' })).evals
      expect(evals).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  },
  240_000,
)

test(
  'a direct policy write from the main Session fails and changes nothing',
  async () => {
    const plan: PolicyPlan = { evalSawRejection: false, directWriteAttempted: false }
    // One adaptive turn whose eval turn calls a policy-writing tool the
    // Steward session does not have; the harness refuses it with a tool
    // error and the session falls back to the legitimate record tool.
    const adapter = new AdaptiveAdapter(async options => {
      const last = options.messages.at(-1)
      if (last === undefined) return textResponse('done')
      const tail = JSON.stringify(options.messages.slice(-2))
      const lastSerialized = JSON.stringify(last)
      if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
      if (tail.includes('set_policy')) {
        // The refused write surfaced as a tool error; record the eval
        // decision through the legitimate tool instead.
        plan.directWriteAttempted = true
        return toolCallsResponse([{
          name: 'record_decision',
          args: {
            action: 'accept',
            strength: 'explicit',
            title: 'Accepted work',
            scope: 'the triggered change',
            rationale: 'the triggers support this work',
            evalId: 'in-flight',
          },
        }])
      }
      if (last.role !== 'user') return textResponse('done')
      if (/eval (eval-[0-9a-f-]+)/.test(tail)) {
        // The attempted direct write: no such tool exists on the session.
        return toolCallsResponse([{
          name: 'set_policy',
          args: { version: '9', decisions: [], approvalCategories: [] },
        }])
      }
      return textResponse('done')
    })
    const home = await testHome()
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [join(home, 'policy.patch.yml')], home,
    })
    try {
      await waitUntilService(ctx, 'dshManagerExecutor')
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)

      await ctx.dshManagerSources.manualInput({ title: 'Fix the login flow', description: 'Investigate and fix' })
      await ctx.dshManagerSteward.runPending()

      // The write was attempted and refused: no new version, no record.
      expect(plan.directWriteAttempted).toBe(true)
      const policies = (await ctx.dshManagerPolicy.policyList()).policies
      expect(policies).toHaveLength(1)
      expect(policies[0]?.version).toBe('1')
      expect(policies[0]?.decisions).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  },
  240_000,
)

afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
})
