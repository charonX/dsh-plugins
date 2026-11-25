/**
 * Boot-tier integration spec for dynamic in-flight FlowRuns (Slice 2 / E2E-5 & E2E-6):
 * 1) Expanding a pipeline mid-flight (2 stages -> 3 stages) and updating a downstream
 *    crew member's role prompt lets the in-flight ticket advance into stage 3 without
 *    being truncated by the initial `stageCount: 2` snapshot, and injects the updated
 *    member duty prompt.
 * 2) Shortening a pipeline mid-flight (3 stages -> 2 stages) while stage 2 is running
 *    causes completion of stage 2 to proceed directly to flow acceptance without
 *    minting stage 3.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const expandHome = await mkdtemp(join(tmpdir(), 'dsh-flow-expand-'))
const shrinkHome = await mkdtemp(join(tmpdir(), 'dsh-flow-shrink-'))
const expandCwd = await mkdtemp(join(tmpdir(), 'dsh-flow-expand-cwd-'))
const shrinkCwd = await mkdtemp(join(tmpdir(), 'dsh-flow-shrink-cwd-'))

async function writeOverlay(home: string, port: number, cwd: string): Promise<string> {
  const overlayPath = join(home, 'flow-hot.patch.yml')
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
    '          maxConcurrent: 1',
    '          tickMs: 3600000',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(cwd)}`,
    '',
  ].join('\n'))
  return overlayPath
}

const server: Server = createServer((request: IncomingMessage, response) => {
  if (request.url?.includes('/rest/api/2/myself')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'jira-user' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    issues: [
      { key: 'FLOW-1', fields: { summary: 'Hot reload flow test', updated: '2026-01-01T00:00:00.000+0000' } },
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

function toolCallsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap((call, index) => {
      const callId = ToolCallId(`call-${index + 1}`)
      const argumentsJson = JSON.stringify(argsOf(call.args))
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

function argsOf(v: unknown): unknown { return v }

function evalIdOf(options: GenerateOptions): string {
  const matches = [...JSON.stringify(options.messages).matchAll(/eval (eval-[0-9a-f-]+)/g)]
  const evalId = matches.at(-1)?.[1]
  if (evalId === undefined) throw new Error('missing evalId')
  return evalId
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly handler: (options: GenerateOptions) => StreamChunk[]) { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.handler(options)) yield chunk
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

async function waitFor<T>(poll: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} never happened`)
    await new Promise(resolve => { setTimeout(resolve, 150) })
  }
}

async function waitForReview<T>(ctx: Context, poll: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    await ctx.dshManagerSteward.reviewPending()
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} never happened`)
    await new Promise(resolve => { setTimeout(resolve, 150) })
  }
}

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  for (const dir of [expandHome, shrinkHome, expandCwd, shrinkCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('expanding a pipeline mid-flight walks into the newly added stage and uses updated crew role', async () => {
  const overlayPath = await writeOverlay(expandHome, 3098, expandCwd)
  const executorPrompts: string[] = []
  let ruleId = ''
  const adapter = new ScriptedAdapter((options) => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Title')
    if (last.role !== 'user') return textResponse('done')
    if (tail.includes('Evaluate the pending changes')) {
      return toolCallsResponse([{
        name: 'record_decision',
        args: { action: 'accept', strength: 'explicit', title: 'Flow expand', scope: 'expand scope', rationale: 'ok', evalId: evalIdOf(options) },
      }])
    }
    if (tail.includes('Route the accepted ticket')) {
      return toolCallsResponse([{ name: 'record_route', args: { ruleId, rationale: 'matched' } }])
    }
    if (tail.includes('executor dispatched for ticket')) {
      executorPrompts.push(tail)
      return toolCallsResponse([
        { name: 'submit_report', args: { kind: 'ready', message: 'stage finished' } },
      ])
    }
    if (tail.includes('review')) {
      return toolCallsResponse([{ name: 'record_review', args: { verdict: 'pass', feedback: 'looks good', dispatchId: 'unknown' } }])
    }
    return textResponse('done')
  })

  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: expandHome })
  try {
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)
    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: worker-1',
      '    name: Worker One',
      '    role: initial stage 1 duty',
      '  - id: worker-2',
      '    name: Worker Two',
      '    role: old worker 2 duty',
      '  - id: worker-3',
      '    name: Worker Three',
      '    role: brand new stage 3 duty',
      'pipelines:',
      '  - id: dynamic-pipe',
      '    name: Dynamic Pipe v1',
      '    stages:',
      '      - memberId: worker-1',
      '        instruction: do stage 1',
      '      - memberId: worker-2',
      '        instruction: do stage 2',
      'routes:',
      '  - id: r-dyn',
      '    condition: any flow test',
      '    pipelineId: dynamic-pipe',
      '',
    ].join('\n'), 'utf8')
    await ctx.dshManagerTeamConfig.reloadFromDisk()
    ruleId = 'r-dyn'

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })
    await ctx.dshManagerSteward.runPending()

    const root = await waitFor(async () => (await ctx.dshManagerBoard.ticketList()).tickets[0], 'root ticket')
    expect(root.flow).toMatchObject({ pipelineId: 'dynamic-pipe', stageIndex: 0, stageCount: 2 })

    // Wait for stage 1 dispatch to complete before hot-updating the pipeline to 3 stages.
    await waitFor(async () => {
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: root.id })).dispatches
      return dispatches[0]?.state === 'ended' ? true : undefined
    }, 'stage 1 completion')

    // Hot-update YAML while flow is between stage 1 review and stage 2/3!
    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: worker-1',
      '    name: Worker One',
      '    role: initial stage 1 duty',
      '  - id: worker-2',
      '    name: Worker Two',
      '    role: updated hot-reloaded duty for stage 2',
      '  - id: worker-3',
      '    name: Worker Three',
      '    role: brand new stage 3 duty',
      'pipelines:',
      '  - id: dynamic-pipe',
      '    name: Dynamic Pipe v2',
      '    stages:',
      '      - memberId: worker-1',
      '        instruction: do stage 1',
      '      - memberId: worker-2',
      '        instruction: do updated stage 2',
      '      - memberId: worker-3',
      '        instruction: do newly added stage 3',
      'routes:',
      '  - id: r-dyn',
      '    condition: any flow test',
      '    pipelineId: dynamic-pipe',
      '',
    ].join('\n'), 'utf8')
    await ctx.dshManagerTeamConfig.reloadFromDisk()

    // Drive review of stage 1 -> stage 2 -> stage 3 -> acceptance.
    const stage2 = await waitForReview(ctx, async () =>
      (await ctx.dshManagerBoard.ticketList()).tickets.find(t => t.flow?.stageIndex === 1), 'stage 2 ticket')
    expect(stage2.flow).toMatchObject({ pipelineName: 'Dynamic Pipe v2', stageIndex: 1, stageCount: 3 })

    await waitFor(async () => {
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: stage2.id })).dispatches
      return dispatches[0]?.state === 'ended' ? true : undefined
    }, 'stage 2 completion')

    const stage3 = await waitForReview(ctx, async () =>
      (await ctx.dshManagerBoard.ticketList()).tickets.find(t => t.flow?.stageIndex === 2), 'stage 3 ticket')
    expect(stage3.flow).toMatchObject({ pipelineName: 'Dynamic Pipe v2', stageIndex: 2, stageCount: 3 })

    await waitFor(async () => {
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: stage3.id })).dispatches
      return dispatches[0]?.state === 'ended' ? true : undefined
    }, 'stage 3 completion')

    const acceptance = await waitForReview(ctx, async () =>
      (await ctx.dshManagerExecutor.attentionList({ ticketId: stage3.id })).attentions
        .find(a => a.status === 'pending' && a.kind === 'review'), 'final acceptance after stage 3')
    expect(acceptance.question).toContain('acceptance requested')

    // Verify stage 2 got the hot-reloaded crew role & stage 3 got the new stage instruction.
    expect(executorPrompts[1]).toContain('updated hot-reloaded duty for stage 2')
    expect(executorPrompts[2]).toContain('do newly added stage 3')

    const mirror = await readFile(join(expandCwd, '.dsh-manager', 'flows', `${root.id}.md`), 'utf8')
    expect(mirror).toContain('# 流程进度：Dynamic Pipe v2')
    expect(mirror).toContain('环节：3/3')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)

test('shortening a pipeline mid-flight stops cleanly at the new end and asks acceptance', async () => {
  const overlayPath = await writeOverlay(shrinkHome, 3099, shrinkCwd)
  let ruleId = ''
  const adapter = new ScriptedAdapter((options) => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Title')
    if (last.role !== 'user') return textResponse('done')
    if (tail.includes('Evaluate the pending changes')) {
      return toolCallsResponse([{
        name: 'record_decision',
        args: { action: 'accept', strength: 'explicit', title: 'Flow shrink', scope: 'shrink scope', rationale: 'ok', evalId: evalIdOf(options) },
      }])
    }
    if (tail.includes('Route the accepted ticket')) {
      return toolCallsResponse([{ name: 'record_route', args: { ruleId, rationale: 'matched' } }])
    }
    if (tail.includes('executor dispatched for ticket')) {
      return toolCallsResponse([
        { name: 'submit_report', args: { kind: 'ready', message: 'stage finished' } },
      ])
    }
    if (tail.includes('review')) {
      return toolCallsResponse([{ name: 'record_review', args: { verdict: 'pass', feedback: 'looks good', dispatchId: 'unknown' } }])
    }
    return textResponse('done')
  })

  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: shrinkHome })
  try {
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)
    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: w1',
      '    name: W1',
      '    role: worker 1',
      'pipelines:',
      '  - id: shrink-pipe',
      '    name: Shrink Pipe',
      '    stages:',
      '      - memberId: w1',
      '        instruction: step 1',
      '      - memberId: w1',
      '        instruction: step 2',
      '      - memberId: w1',
      '        instruction: step 3',
      'routes:',
      '  - id: r-shrink',
      '    condition: any flow test',
      '    pipelineId: shrink-pipe',
      '',
    ].join('\n'), 'utf8')
    await ctx.dshManagerTeamConfig.reloadFromDisk()
    ruleId = 'r-shrink'

    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    await ctx.dshManagerSources.sourcePoll({ id: source.id })
    await ctx.dshManagerSteward.runPending()

    const root = await waitFor(async () => (await ctx.dshManagerBoard.ticketList()).tickets[0], 'root ticket')
    await waitFor(async () => {
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: root.id })).dispatches
      return dispatches[0]?.state === 'ended' ? true : undefined
    }, 'stage 1 completion')

    const stage2 = await waitForReview(ctx, async () =>
      (await ctx.dshManagerBoard.ticketList()).tickets.find(t => t.flow?.stageIndex === 1), 'stage 2 ticket')
    await waitFor(async () => {
      const dispatches = (await ctx.dshManagerExecutor.dispatchList({ ticketId: stage2.id })).dispatches
      return dispatches[0]?.state === 'ended' ? true : undefined
    }, 'stage 2 completion')

    // Shorten pipeline from 3 stages to 2 stages before stage 2 review finishes!
    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: w1',
      '    name: W1',
      '    role: worker 1',
      'pipelines:',
      '  - id: shrink-pipe',
      '    name: Shrink Pipe',
      '    stages:',
      '      - memberId: w1',
      '        instruction: step 1',
      '      - memberId: w1',
      '        instruction: step 2',
      'routes:',
      '  - id: r-shrink',
      '    condition: any flow test',
      '    pipelineId: shrink-pipe',
      '',
    ].join('\n'), 'utf8')
    await ctx.dshManagerTeamConfig.reloadFromDisk()

    const acceptance = await waitForReview(ctx, async () =>
      (await ctx.dshManagerExecutor.attentionList({ ticketId: stage2.id })).attentions
        .find(a => a.status === 'pending' && a.kind === 'review'), 'acceptance at shortened end')
    expect(acceptance.question).toContain('acceptance requested')
    const allTickets = (await ctx.dshManagerBoard.ticketList()).tickets
    expect(allTickets.some(t => t.flow?.stageIndex === 2)).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)
