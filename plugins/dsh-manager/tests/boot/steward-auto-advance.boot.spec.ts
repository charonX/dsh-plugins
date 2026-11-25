/**
 * Boot-tier integration spec for Steward auto-skip & automatic review advancement:
 * 1) A direct aligned ticket (with `acceptanceCriteria`) routed onto a pipeline
 *    whose stage 0 is skippable auto-skips stage 0 and dispatches stage 1 directly.
 * 2) With normal Steward tickMs (< 60s), once stage 1 completes with `ready`,
 *    Steward automatically reviews and advances to stage 2 without manual `reviewPending()` calls.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const autoHome = await mkdtemp(join(tmpdir(), 'dsh-steward-auto-'))
const autoCwd = await mkdtemp(join(tmpdir(), 'dsh-steward-auto-cwd-'))

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'steward-auto.patch.yml')
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
    '          tickMs: 400',
    '        executor:',
    '          provider: mock',
    '          model: executor-test',
    '          maxConcurrent: 1',
    '          tickMs: 200',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(autoCwd)}`,
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

afterAll(async () => {
  for (const dir of [autoHome, autoCwd]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('aligned direct ticket auto-skips skippable stage 0 and Steward auto-advances stages on tick without manual reviewPending', async () => {
  const overlayPath = await writeOverlay(autoHome, 3102)
  const skipPrompts: string[] = []
  const executorPrompts: string[] = []

  const adapter = new ScriptedAdapter((options) => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Title')
    if (last.role !== 'user') return textResponse('done')
    if (tail.includes('Route the accepted ticket')) {
      return toolCallsResponse([{ name: 'record_route', args: { ruleId: 'r-auto', rationale: 'matched dev pipeline' } }])
    }
    if (tail.includes('Decide whether pipeline stage')) {
      skipPrompts.push(tail)
      // Skip stage 1 (align) since acceptance criteria are already agreed; run stage 2 (dev) & stage 3 (review).
      const shouldSkip = tail.includes('stage 1')
      return toolCallsResponse([{
        name: 'decide_skip',
        args: { skip: shouldSkip, rationale: shouldSkip ? 'already aligned with acceptance criteria' : 'implementation needed' },
      }])
    }
    if (tail.includes('executor dispatched for ticket')) {
      executorPrompts.push(tail)
      return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: 'stage done' } }])
    }
    if (tail.includes('review')) {
      return toolCallsResponse([{ name: 'record_review', args: { verdict: 'pass', feedback: 'pass', dispatchId: 'unknown' } }])
    }
    return textResponse('done')
  })

  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: autoHome })
  try {
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)
    const yamlPath = ctx.dshManagerTeamConfig.status().filePath

    await writeFile(yamlPath, [
      'version: 1',
      'crew:',
      '  - id: aligner',
      '    name: Requirement Aligner',
      '    role: clarify ambiguous requirements',
      '  - id: dev',
      '    name: TDD Developer',
      '    role: implement code with vertical slices',
      '  - id: reviewer',
      '    name: Code Reviewer',
      '    role: review code quality',
      'pipelines:',
      '  - id: dev-flow',
      '    name: Dev Flow',
      '    stages:',
      '      - memberId: aligner',
      '        instruction: clarify requirements',
      '        skippable: true',
      '        skipLogic: skip when acceptance criteria are already aligned',
      '      - memberId: dev',
      '        instruction: implement feature',
      '        skippable: false',
      '      - memberId: reviewer',
      '        instruction: review implementation',
      '        skippable: false',
      'routes:',
      '  - id: r-auto',
      '    condition: feature work',
      '    pipelineId: dev-flow',
      '',
    ].join('\n'), 'utf8')
    await ctx.dshManagerTeamConfig.reloadFromDisk()

    // Hand off an aligned direct ticket via the global tool.
    const createTool = ctx.tools.get('dsh_manager_create_ticket')
    expect(createTool).toBeDefined()
    const created = await createTool!.execute({
      title: 'Aligned Task',
      description: 'Implement feature X',
      acceptanceCriteria: '1) All tests pass; 2) Clean UI.',
      mode: 'direct',
    }, {} as never) as { ticketId: string; routed: boolean }
    expect(created.routed).toBe(true)

    // Stage 0 (Requirement Aligner) was skipped automatically; root ticket starts on stageIndex 1 (TDD Developer).
    const root = ctx.dshManagerBoard.ticketRecord(created.ticketId)
    expect(root?.flow?.stageIndex).toBe(1)
    expect(root?.flow?.skipped).toEqual([{ stageIndex: 0, reason: 'already aligned with acceptance criteria' }])
    expect(skipPrompts[0]).toContain('1) All tests pass')

    // Without calling `reviewPending()` manually, Steward automatically reviews stage 1 and advances to stage 2!
    const stage3 = await waitFor(async () =>
      (await ctx.dshManagerBoard.ticketList()).tickets.find(t => t.flow?.stageIndex === 2), 'auto-advanced stage 3 ticket')
    expect(stage3.flow?.stageIndex).toBe(2)

    const acceptance = await waitFor(async () =>
      (await ctx.dshManagerExecutor.attentionList({ ticketId: stage3.id })).attentions
        .find(a => a.status === 'pending' && a.kind === 'review'), 'auto-minted final acceptance')
    expect(acceptance.question).toContain('acceptance requested')
    expect(executorPrompts).toHaveLength(2)
    expect(executorPrompts[0]).toContain('TDD Developer')
    expect(executorPrompts[1]).toContain('Code Reviewer')
  } finally {
    await ctx.fiber.dispose()
  }
}, 300_000)

test('review stage rework returns to the prior implementation stage, preserves projectId/scratchDir, and reuses the review ticket', async () => {
  const reviewHome = await mkdtemp(join(tmpdir(), 'dsh-review-return-'))
  try {
    const overlayPath = await writeOverlay(reviewHome, 3103)
    const implPrompts: string[] = []
    const reviewPrompts: string[] = []
    let implAttempt = 0
    let reviewAttempt = 0

    const adapter = new ScriptedAdapter((options) => {
      const last = options.messages.at(-1)
      if (last === undefined) return textResponse('done')
      const tail = JSON.stringify(options.messages.slice(-2))
      if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Title')
      if (last.role !== 'user') return textResponse('done')
      if (tail.includes('Route the accepted ticket')) {
        return toolCallsResponse([{ name: 'record_route', args: { ruleId: 'r-bug', rationale: 'matched bug pipeline' } }])
      }
      if (tail.includes('executor dispatched for ticket')) {
        if (tail.includes('Bug Fixer')) {
          implAttempt += 1
          implPrompts.push(tail)
          return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: `impl attempt ${implAttempt} done` } }])
        }
        if (tail.includes('Read-Only Reviewer')) {
          reviewAttempt += 1
          reviewPrompts.push(tail)
          const report = reviewAttempt === 1
            ? '审查未通过：\n- F-01: tests/foo.spec.ts:12 缺少回归断言\n- 测试失败输出：expected 200 got 500\n- 事实文件：scratch/tasks/t1/review-report.md'
            : '审查通过：F-01 已解决，全量测试与门禁全部通过（all checks passed）。'
          return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: report } }])
        }
      }
      if (tail.includes('Review the finished work')) {
        const isRejection = tail.includes('审查未通过') && !tail.includes('审查通过')
        return toolCallsResponse([{
          name: 'record_review',
          args: {
            verdict: isRejection ? 'rework' : 'pass',
            feedback: isRejection
              ? 'F-01 missing regression assertion; expected 200 got 500 (see review-report.md)'
              : 'all checks passed',
            dispatchId: 'unknown',
          },
        }])
      }
      return textResponse('done')
    })

    const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: reviewHome })
    try {
      await waitUntilService(ctx, 'dshManagerSteward')
      ctx.llm.registerAdapter(['mock'], adapter)
      const yamlPath = ctx.dshManagerTeamConfig.status().filePath

      await writeFile(yamlPath, [
        'version: 1',
        'crew:',
        '  - id: fixer',
        '    name: Bug Fixer',
        '    role: reproduce and fix bugs with E2E regression tests',
        '  - id: reviewer',
        '    name: Read-Only Reviewer',
        '    role: review read-only against review-report.md',
        'pipelines:',
        '  - id: bug-flow',
        '    name: Bug Flow',
        '    stages:',
        '      - memberId: fixer',
        '        instruction: fix bug and run tests',
        '        skippable: false',
        '      - memberId: reviewer',
        '        instruction: read-only review',
        '        skippable: false',
        '        mode: review',
        'routes:',
        '  - id: r-bug',
        '    condition: bug fix',
        '    pipelineId: bug-flow',
        '',
      ].join('\n'), 'utf8')
      await ctx.dshManagerTeamConfig.reloadFromDisk()

      const createTool = ctx.tools.get('dsh_manager_create_ticket')
      const created = await createTool!.execute({
        title: 'Fix login crash',
        description: 'Reproduce and fix login crash',
        acceptanceCriteria: 'Login returns 200 in E2E',
        scratchDir: join(reviewHome, 'scratch', 'tasks', 'login-crash'),
        mode: 'direct',
      }, {} as never) as { ticketId: string; routed: boolean }
      expect(created.routed).toBe(true)

      const acceptance = await waitFor(async () => {
        const all = (await ctx.dshManagerBoard.ticketList()).tickets
        const revTicket = all.find(t => t.flow?.stageIndex === 1)
        if (revTicket === undefined) return undefined
        return (await ctx.dshManagerExecutor.attentionList({ ticketId: revTicket.id })).attentions
          .find(a => a.status === 'pending' && a.kind === 'review')
      }, 'acceptance after review return round-trip')

      expect(acceptance.question).toContain('acceptance requested')
      expect(implPrompts).toHaveLength(2)
      expect(implPrompts[1]).toContain('F-01 missing regression assertion')
      expect(implPrompts[1]).toContain('expected 200 got 500')
      expect(reviewPrompts).toHaveLength(2)

      // Exactly 2 stage tickets exist (no duplicate review stage ticket minted on re-advance),
      // and the follow-up ticket inherited acceptanceCriteria and scratchDir.
      const tickets = (await ctx.dshManagerBoard.ticketList()).tickets
      expect(tickets.filter(t => t.flow !== undefined)).toHaveLength(2)
      const revRecord = ctx.dshManagerBoard.ticketRecord(tickets.find(t => t.flow?.stageIndex === 1)!.id)
      expect(revRecord?.acceptanceCriteria).toBe('Login returns 200 in E2E')
      expect(revRecord?.scratchDir).toBe(join(reviewHome, 'scratch', 'tasks', 'login-crash'))
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(reviewHome, { recursive: true, force: true })
  }
}, 300_000)
