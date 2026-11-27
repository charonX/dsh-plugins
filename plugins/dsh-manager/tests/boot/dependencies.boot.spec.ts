/**
 * Boot-tier integration spec for deterministic dependency gating (`dependsOn`):
 * 1) Direct dispatch of a ticket with unresolved prerequisites fails with `dshManager/ticket-blocked`.
 * 2) When the prerequisite reaches `ended` via `finishTicket`, the Executor pump automatically dispatches the waiting ticket.
 * 3) Clearing `dependsOn` via `setTicketDependencies` immediately unblocks and dispatches the ticket.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const depHome = await mkdtemp(join(tmpdir(), 'dsh-dep-boot-'))
const depCwd = await mkdtemp(join(tmpdir(), 'dsh-dep-cwd-'))

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'dependencies.patch.yml')
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
    '          maxConcurrent: 2',
    '          tickMs: 250',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(depCwd)}`,
    '',
  ].join('\n'))
  return overlayPath
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

function toolCallsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap((call, index) => {
      const callId = ToolCallId(`call-${index + 1}`)
      const argumentsJson = JSON.stringify(call.args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' } as StreamChunk,
        { type: 'tool-call-delta', index, id: callId, name: call.name, argumentsDelta: argumentsJson } as StreamChunk,
        { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: call.name, arguments: argumentsJson } } as StreamChunk,
      ]
    }),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ReadyAdapter extends LlmAdapter {
  readonly dispatchedPrompts: string[] = []
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    if (last === undefined) {
      for (const c of textResponse('done')) yield c
      return
    }
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) {
      for (const c of textResponse('Title')) yield c
      return
    }
    if (last.role === 'user' && tail.includes('Ticket ticket-')) {
      this.dispatchedPrompts.push(tail)
      for (const c of toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: 'finished stage cleanly' } }])) yield c
      return
    }
    for (const c of textResponse('done')) yield c
  }
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} timeout`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

afterAll(async () => {
  for (const dir of [depHome, depCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('blocks dependent tickets until prerequisite ends or dependency is manually removed', async () => {
  const overlayPath = await writeOverlay(depHome, 3108)
  const adapter = new ReadyAdapter()
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: depHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerBoard')
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)

    const now = Date.now()
    const { flow } = await ctx.dshManagerFlow.flowAdd({
      name: 'Dev Flow',
      when: 'Implement approved work',
      workspaceMode: 'in-place',
      steps: [{ id: 'impl', name: 'Implementer', skills: [], goal: 'Implement and report ready.' }],
    })
    const ticketA = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Cleanup legacy settings',
      scope: 'board settings cleanup',
    }, now)
    const ticketB = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Desktop notify settings',
      scope: 'settings notifications',
      dependsOn: [ticketA.id],
    }, now + 1)
    const ticketC = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Notification sound picker',
      scope: 'sound picker',
      dependsOn: [ticketB.id],
    }, now + 2)
    await ctx.dshManagerBoard.annotateFlow(ticketB.id, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 0,
      stageCount: 1,
    })
    await ctx.dshManagerBoard.annotateFlow(ticketC.id, {
      pipelineId: flow.id,
      pipelineName: flow.name,
      stageIndex: 0,
      stageCount: 1,
    })

    // Direct dispatch of blocked ticketB is rejected cleanly.
    await expect(ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketB.id })).rejects.toThrow(/waiting on unresolved dependencies/i)

    // Board projection reflects waitingOn for B and C.
    const viewB = ctx.dshManagerBoard.ticketView(ticketB.id)
    expect(viewB?.waitingOn?.map(dep => dep.id)).toEqual([ticketA.id])

    // Dispatch ticketA; B must stay queued/todo until A finishes.
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticketA.id })
    await vi.waitFor(async () => {
      const detailA = await ctx.dshManagerExecutor.ticketDetail({ ticketId: ticketA.id })
      expect(detailA.dispatches[0]?.outcome).toBe('ready')
    }, { timeout: 20_000 })
    expect(ctx.dshManagerBoard.ticketView(ticketB.id)?.state).toBe('todo')

    // Ending ticketA wakes Executor.pump() and automatically dispatches ticketB!
    await ctx.dshManagerBoard.finishTicket(ticketA.id, Date.now())
    await vi.waitFor(async () => {
      const detailB = await ctx.dshManagerExecutor.ticketDetail({ ticketId: ticketB.id })
      expect(detailB.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // ticketC is still waiting on B (which is running, not ended).
    expect(ctx.dshManagerBoard.ticketView(ticketC.id)?.state).toBe('todo')
    expect(ctx.dshManagerBoard.ticketView(ticketC.id)?.waitingOn?.map(dep => dep.id)).toEqual([ticketB.id])

    // Manually clearing C's prerequisites immediately unblocks & dispatches C.
    const unblocked = await ctx.dshManagerBoard.setTicketDependencies({ ticketId: ticketC.id, dependsOn: [] })
    expect(unblocked.ticket.dependsOn).toBeUndefined()
    expect(unblocked.ticket.waitingOn).toBeUndefined()
    await vi.waitFor(async () => {
      const detailC = await ctx.dshManagerExecutor.ticketDetail({ ticketId: ticketC.id })
      expect(detailC.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })

    // Flow-less (single-step fallback) tickets with dependsOn must also wake
    // when their prerequisite ends or dependencies are cleared.
    const directRoot = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Flowless root task',
      scope: 'root step',
    }, now + 10)
    const directChild = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Flowless child task',
      scope: 'dependent single-step fallback',
      dependsOn: [directRoot.id],
    }, now + 11)
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: directRoot.id })
    await vi.waitFor(async () => {
      const detailRoot = await ctx.dshManagerExecutor.ticketDetail({ ticketId: directRoot.id })
      expect(detailRoot.dispatches[0]?.outcome).toBe('ready')
    }, { timeout: 20_000 })
    await ctx.dshManagerBoard.finishTicket(directRoot.id, Date.now())
    await vi.waitFor(async () => {
      const detailChild = await ctx.dshManagerExecutor.ticketDetail({ ticketId: directChild.id })
      expect(detailChild.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
