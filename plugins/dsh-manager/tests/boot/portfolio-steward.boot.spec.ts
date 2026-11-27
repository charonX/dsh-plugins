/**
 * Boot-tier integration spec for Slice 2 Steward portfolio awareness:
 * 1) Eval sees in-flight/ended portfolio tickets and can mark `ignore` + `supersededBy` on duplicates.
 * 2) Route sees active overlapping tickets and records `dependsOn`, blocking dispatch until prerequisite ends.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const portfolioHome = await mkdtemp(join(tmpdir(), 'dsh-portfolio-boot-'))
const portfolioCwd = await mkdtemp(join(tmpdir(), 'dsh-portfolio-cwd-'))

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'portfolio.patch.yml')
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
    `          cwd: ${JSON.stringify(portfolioCwd)}`,
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

function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const found = matches.at(-1)?.[1]
  if (found === undefined) throw new Error('missing eval id in prompt')
  return found
}

class PortfolioAdapter extends LlmAdapter {
  readonly seenEvalPrompts: string[] = []
  readonly seenRoutePrompts: string[] = []
  existingTicketId = ''
  routeRuleId = ''

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
    if (last.role !== 'user') {
      for (const c of textResponse('done')) yield c
      return
    }
    if (/eval (eval-[0-9a-f-]+)/.test(tail)) {
      this.seenEvalPrompts.push(tail)
      for (const c of toolCallsResponse([{
        name: 'record_decision',
        args: {
          evalId: evalIdOf(options),
          action: 'ignore',
          strength: 'explicit',
          supersededBy: this.existingTicketId,
          rationale: `Already fixed by ${this.existingTicketId}`,
        },
      }])) yield c
      return
    }
    if (tail.includes('Route ticket ')) {
      this.seenRoutePrompts.push(tail)
      for (const c of toolCallsResponse([{
        name: 'record_route',
        args: {
          flowId: this.routeRuleId,
          dependsOn: [this.existingTicketId],
          worktree: {
            mode: 'worktree',
            baseBranch: 'main',
            branch: 'feat-dsh-manager-notifications',
            mergeTarget: 'test',
          },
          rationale: `Overlaps SettingsPage.tsx with ${this.existingTicketId}`,
        },
      }])) yield c
      return
    }
    if (tail.includes('工单 ticket-')) {
      for (const c of toolCallsResponse([{
        name: 'submit_report',
        args: { kind: 'ready', message: 'implemented after dependency settled' },
      }])) yield c
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
  for (const dir of [portfolioHome, portfolioCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('Steward Eval records supersededBy for duplicates and Route sets dependsOn from portfolio context', async () => {
  const overlayPath = await writeOverlay(portfolioHome, 3109)
  const adapter = new PortfolioAdapter()
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: portfolioHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerSteward')
    await waitUntilService(ctx, 'dshManagerBoard')
    ctx.llm.registerAdapter(['mock'], adapter)

    // Seed an active ticket.
    const existing = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Cleanup legacy panels',
      scope: 'Remove SettingsPage legacy section',
    }, Date.now())
    adapter.existingTicketId = existing.id

    // Seed Flow IR rule for direct ticket routing.
    const { flow } = await ctx.dshManagerFlow.flowAdd({
      name: 'Direct Dev',
      when: 'All confirmed feature tasks',
      workspaceMode: 'worktree',
      steps: [{ id: 'dev', name: 'Dev', skills: [], goal: 'Implement and verify.' }],
    })
    adapter.routeRuleId = flow.id

    // 1) Duplicate bug report arrives via inbox -> Steward Eval sees existing ticket and records ignore + supersededBy.
    await ctx.dshManagerSources.manualInput({
      title: 'Legacy panel toggle throws error',
      description: 'Duplicate bug inside legacy module',
    })
    await ctx.dshManagerSteward.runPending()

    expect(adapter.seenEvalPrompts).toHaveLength(1)
    expect(adapter.seenEvalPrompts[0]).toContain(existing.id)
    expect(adapter.seenEvalPrompts[0]).toContain('Cleanup legacy panels')

    const evals = (await ctx.dshManagerSteward.evalList({})).evals
    expect(evals).toHaveLength(1)
    expect(evals[0]?.status).toBe('rejected')
    expect(evals[0]?.decision?.action).toBe('ignore')
    expect(evals[0]?.decision?.supersededBy).toBe(existing.id)
    expect((await ctx.dshManagerBoard.ticketList()).tickets).toHaveLength(1)

    // 2) Overlapping direct ticket -> Steward Route sees existing ticket and picks dependsOn: [existing.id].
    const nextTicket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Desktop notification card',
      scope: 'Edit SettingsPage notifications card',
    }, Date.now() + 1)
    await ctx.dshManagerSteward.routeDirectTicket(nextTicket.id)

    expect(adapter.seenRoutePrompts).toHaveLength(1)
    expect(adapter.seenRoutePrompts[0]).toContain(existing.id)

    const blockedView = ctx.dshManagerBoard.ticketView(nextTicket.id)
    expect(blockedView?.dependsOn).toEqual([existing.id])
    expect(blockedView?.waitingOn?.map(dep => dep.id)).toEqual([existing.id])
    expect(blockedView?.state).toBe('todo')
    expect(blockedView?.worktree).toEqual({
      mode: 'worktree',
      baseBranch: 'main',
      branch: 'feat-dsh-manager-notifications',
      mergeTarget: 'test',
    })

    // Finishing the prerequisite wakes Executor.pump() and runs nextTicket automatically.
    await ctx.dshManagerBoard.finishTicket(existing.id, Date.now())
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: nextTicket.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
