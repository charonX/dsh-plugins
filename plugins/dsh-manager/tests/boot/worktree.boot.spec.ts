/**
 * Main-seam spec for worktree dispatch (spec stories 49/73/82): a ticket
 * mapped to a workspace project gets its own git worktree (prepared through
 * the harness subprocess, branch and directory traceable to the ticket), the
 * executor edits files there through the sandboxed fs tools, the per-turn
 * diff lands as a workspace-changes Deliverable reference in the ticket
 * detail, parallel dispatches never touch each other's worktrees, and a
 * re-dispatch reuses the same worktree.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'
import { worktreePathFor } from '../../src/dispatch/worktree.ts'

const home = await mkdtemp(join(tmpdir(), 'dsh-worktree-boot-'))
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-worktree-repos-'))

// One real local git repository as the mapped project.
const repoRoot = join(tempRoot, 'repo')
await mkdir(repoRoot, { recursive: true })
execFileSync('git', ['init'], { cwd: repoRoot })
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
await writeFile(join(repoRoot, 'base.md'), 'base\n')
execFileSync('git', ['add', '.'], { cwd: repoRoot })
execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot })

const overlayPath = join(home, 'worktree.patch.yml')
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
  '          turnTimeoutMs: 60000',
  '',
].join('\n'))

// No external system: manual entries stand in for collected triggers, and
// the local git repository is the mapped world.

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

/** The executor's finish step: declare the deliverable and report ready. */
function executorFinish(fileName: string): StreamChunk[] {
  return toolCallsResponse([
    { name: 'present', args: { files: [{ path: fileName, description: 'The analysis notes' }] } },
    { name: 'submit_report', args: { kind: 'ready', message: 'the analysis is complete' } },
  ])
}

/**
 * One adaptive turn: title probes, Steward evals, and executor sessions
 * share one adapter. An executor turn writes its finding file first, then
 * declares and reports on the tool result.
 */
function adaptiveTurn(gates: { releaseFirst: Promise<void> }): (options: GenerateOptions) => Promise<StreamChunk[]> {
  let executorCalls = 0
  let presentPending: string | undefined
  return async options => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    // The first turn of a fresh session closes with the session-info
    // reminder; the actual prompt sits one message earlier, so the tail of
    // two messages decides.
    const tail = JSON.stringify(options.messages.slice(-2))
    const lastSerialized = JSON.stringify(last)
    if (lastSerialized.includes('Generate the session title')) return textResponse('Session title')
    if (last.role !== 'user') {
      if (presentPending !== undefined) {
        const fileName = presentPending
        presentPending = undefined
        return executorFinish(fileName)
      }
      return textResponse('done')
    }
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) return stewardAccept(options)
    if (tail.includes('executor dispatched for ticket')) {
      executorCalls += 1
      if (executorCalls === 1) await gates.releaseFirst
      const fileName = `finding-${executorCalls}.md`
      presentPending = fileName
      return toolCallsResponse([{
        name: 'write',
        args: { file_path: fileName, content: `findings from executor call ${executorCalls}\n` },
      }])
    }
    return textResponse('done')
  }
}

/** Scripted adapter: one adaptive function serves every model call. */
class AdaptiveAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private entry: (options: GenerateOptions) => Promise<StreamChunk[]>) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
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

/** The dispatch views of one ticket, newest first. */
async function dispatchesOf(ctx: Context, ticketId: string) {
  return (await ctx.dshManagerExecutor.dispatchList({ ticketId })).dispatches
}

test(
  'a mapped ticket gets its own worktree, produces a diff deliverable, runs isolated, and re-dispatch reuses the worktree',
  async () => {
    let releaseFirst!: () => void
    const releaseFirstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const adapter = new AdaptiveAdapter(adaptiveTurn({ releaseFirst: releaseFirstGate }))

    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    await waitUntilService(ctx, 'dshManagerExecutor')
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    // The mapped project: the local git repository registered as a workspace.
    const workspace = await ctx.workspaceRegistry.create(repoRoot)

    // Two tickets whose records carry no project: the mapping decides.
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl: 'http://127.0.0.1:1', authMethod: 'pat', secret: 'pat-value',
    })
    void connection
    await ctx.dshManagerSources.manualInput({ title: 'First finding', description: 'Investigate the login flow' })
    await ctx.dshManagerSources.manualInput({ title: 'Second finding', description: 'Investigate the report flow' })
    await ctx.dshManagerSteward.runPending()
    const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(tickets).toHaveLength(2)
    for (const ticket of tickets) {
      await ctx.dshManagerMappings.mappingSet({
        connectionId: 'manual',
        external: ticket.externalKey!,
        projectId: workspace.id,
      })
    }

    // Dispatch the first ticket: its worktree is created before the session.
    const dispatchA = await ctx.dshManagerExecutor.dispatchTicket({ ticketId: tickets[0]!.id })
    expect(dispatchA.state).toBe('queued')
    await vi.waitFor(async () => {
      expect((await dispatchesOf(ctx, tickets[0]!.id))[0]?.state).toBe('running')
    })
    const worktreeA = worktreePathFor(repoRoot, tickets[0]!.id)
    await vi.waitFor(() => {
      expect(existsSync(worktreeA)).toBe(true)
      expect(existsSync(join(worktreeA, 'base.md'))).toBe(true)
    })

    // The second dispatch queues behind the ceiling and stays untouched.
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: tickets[1]!.id })
    await ctx.dshManagerExecutor.pump()
    expect((await dispatchesOf(ctx, tickets[1]!.id))[0]?.state).toBe('queued')
    const worktreeB = worktreePathFor(repoRoot, tickets[1]!.id)
    expect(existsSync(worktreeB)).toBe(false)

    // Releasing the first executor: it writes inside its worktree, presents,
    // and reports ready.
    releaseFirst()
    await vi.waitFor(async () => {
      const ended = await dispatchesOf(ctx, tickets[0]!.id)
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    }, { timeout: 15_000 })
    expect(existsSync(join(worktreeA, 'finding-1.md'))).toBe(true)

    // The freed slot runs the second dispatch in its own worktree.
    await ctx.dshManagerExecutor.pump()
    await vi.waitFor(async () => {
      const ended = await dispatchesOf(ctx, tickets[1]!.id)
      expect(ended[0]?.state).toBe('ended')
      expect(ended[0]?.outcome).toBe('ready')
    }, { timeout: 15_000 })
    expect(existsSync(join(worktreeB, 'finding-2.md'))).toBe(true)
    // Parallel isolation: neither worktree holds the other's file.
    expect(existsSync(join(worktreeA, 'finding-2.md'))).toBe(false)
    expect(existsSync(join(worktreeB, 'finding-1.md'))).toBe(false)

    // The ticket detail carries the diff and the deliverable references, and
    // the harness diff view resolves each change ref to a real comparison.
    const detailA = await ctx.dshManagerExecutor.ticketDetail({ ticketId: tickets[0]!.id })
    expect(detailA.changes.length).toBeGreaterThan(0)
    expect(detailA.changes[0]!.files).toBeGreaterThan(0)
    expect(detailA.changes[0]!.sessionId).toMatch(/^dsh-manager-exec-/)
    expect(detailA.deliverables.length).toBeGreaterThan(0)
    expect(detailA.deliverables[0]!.path).toContain('finding-1.md')
    const changeA = detailA.changes[0]!
    const servedDiff = await ctx.dshManagerExecutor.ticketChangeDiff({
      sessionId: changeA.sessionId, seq: changeA.seq, index: 0,
    })
    expect(servedDiff.diff?.kind).toBe('text')
    if (servedDiff.diff?.kind === 'text') {
      expect(servedDiff.diff.display).toContain('finding-1')
      expect(servedDiff.diff.hunks.length).toBeGreaterThan(0)
      expect(servedDiff.diff.hunks[0]!.lines.join('\n')).toContain('findings from executor call 1')
    }

    // The mapped executor session runs workspace-write, attaches directly to the
    // mapped workspace (never falling into Ungrouped), carries a `[工单]` title
    // badge, and executes inside its isolated worktree.
    const sessionIdA = (await dispatchesOf(ctx, tickets[0]!.id))[0]!.sessionId!
    const sessionA = ctx.sessions.get(sessionIdA as never)
    const modeEvents = sessionA!.snapshotEvents()
      .filter(event => (event as { readonly type: string }).type === 'sandbox/mode')
    expect((modeEvents.at(-1) as unknown as { data: { mode: string } }).data.mode).toBe('workspace-write')
    expect(ctx.workspaceRegistry.get(workspace.id)?.sessionIds).toContain(sessionIdA)
    const titleEvent = sessionA!.snapshotEvents()
      .findLast(event => (event as { readonly type: string }).type === 'session/title') as
      | { readonly data?: { readonly title?: string } }
      | undefined
    expect(titleEvent?.data?.title).toMatch(/^\[工单\]/)

    // Re-dispatching reuses the same worktree: the earlier finding survives.
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: tickets[0]!.id })
    await ctx.dshManagerExecutor.pump()
    await vi.waitFor(async () => {
      const views = await dispatchesOf(ctx, tickets[0]!.id)
      expect(views).toHaveLength(2)
      expect(views[0]?.state).toBe('ended')
      expect(views[0]?.outcome).toBe('ready')
    }, { timeout: 15_000 })
    expect(existsSync(join(worktreeA, 'finding-1.md'))).toBe(true)
    expect(existsSync(join(worktreeA, 'finding-3.md'))).toBe(true)

    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(tempRoot, { recursive: true, force: true })
})
