/**
 * Boot-tier integration spec for Flow IR Playbook caching, non-git in-place execution,
 * Steward auto-advancement without intermediate gate LLMs, and onFail review rework:
 * 1) Playbook compiles once and hits SHA-256 cache on repeat; knowledge flow runs `in-place`
 *    inside a non-git folder and Steward auto-advances Step 1 -> Step 2 without manual `reviewPending`.
 * 2) Review step with `onFail` returns rework to the prior implementation step, preserves
 *    `acceptanceCriteria` / `scratchDir`, and reuses the review ticket.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

test('compiles Playbook once (hash cache hit), runs non-git in-place knowledge flow, and auto-advances on tick', async () => {
  const overlayPath = await writeOverlay(autoHome, 3102)
  const executorPrompts: string[] = []
  let targetFlowId = ''

  const adapter = new ScriptedAdapter((options) => {
    const last = options.messages.at(-1)
    if (last === undefined) return textResponse('done')
    const tail = JSON.stringify(options.messages.slice(-2))
    if (JSON.stringify(last).includes('Generate the session title')) return textResponse('Title')
    if (last.role !== 'user') return textResponse('done')
    if (tail.includes('Route ticket ')) {
      return toolCallsResponse([{ name: 'record_route', args: { flowId: targetFlowId, rationale: 'matched compiled flow' } }])
    }
    if (tail.includes('工单 ticket-')) {
      executorPrompts.push(tail)
      return toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: 'step done' } }])
    }
    if (tail.includes('Review the finished work on ticket')) {
      return toolCallsResponse([{ name: 'record_review', args: { verdict: 'pass', feedback: 'pass', dispatchId: 'unknown' } }])
    }
    return textResponse('done')
  })

  // Seed a workspace skill inside non-git autoCwd before booting.
  const skillDir = join(autoCwd, '.dsh', 'skills', 'knowledge-notes')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), [
    '---',
    'name: knowledge-notes',
    'description: Write structured knowledge articles cleanly',
    '---',
    '# Knowledge Notes Playbook',
    '',
    '1. Research and outline key theses via `how`.',
    '2. Draft the article body in markdown.',
    '3. Fact review against `verify`.',
    '',
  ].join('\n'), 'utf8')

  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: autoHome })
  try {
    await waitUntilService(ctx, 'dshManagerSteward')
    ctx.llm.registerAdapter(['mock'], adapter)

    // E2E-1: compile once, verify second call hits SHA-256 hash cache without re-parsing.
    const compiled = await ctx.dshManagerFlow.flowImportPlaybook({
      kind: 'skill',
      ref: 'knowledge-notes',
      cwd: autoCwd,
    })
    expect(compiled.cacheHit).toBe(false)
    expect(compiled.method).toBe('markdown')
    expect(compiled.flow.workspaceMode).toBe('in-place')
    expect(compiled.flow.steps).toHaveLength(3)
    expect(compiled.flow.steps[2]?.onFail).toBe(compiled.flow.steps[1]?.id)

    const cached = await ctx.dshManagerFlow.flowImportPlaybook({
      kind: 'skill',
      ref: 'knowledge-notes',
      cwd: autoCwd,
    })
    expect(cached.cacheHit).toBe(true)
    expect(cached.method).toBe('cache')
    expect(cached.flow.id).toBe(compiled.flow.id)
    targetFlowId = compiled.flow.id

    // Hand off a direct knowledge task in the non-git directory.
    const createTool = ctx.tools.get('dsh_manager_create_ticket')
    expect(createTool).toBeDefined()
    const created = await createTool!.execute({
      title: 'Draft RAG Architecture Essay',
      description: 'Write essay in non-git notes directory',
      acceptanceCriteria: 'Clean outline, draft, and verified claims.',
      mode: 'direct',
    }, {} as never) as { ticketId: string; routed: boolean }
    expect(created.routed).toBe(true)

    const root = ctx.dshManagerBoard.ticketRecord(created.ticketId)
    expect(root?.worktree).toEqual({ mode: 'in-place' })
    expect(root?.flow?.stageIndex).toBe(0)

    // Without calling `reviewPending()` manually, Steward automatically advances Step 0 -> Step 1 -> Step 2!
    const stage3 = await waitFor(async () =>
      (await ctx.dshManagerBoard.ticketList()).tickets.find(t => t.flow?.stageIndex === 2), 'auto-advanced stage 3 ticket')
    expect(stage3.flow?.stageIndex).toBe(2)

    const acceptance = await waitFor(async () =>
      (await ctx.dshManagerExecutor.attentionList({ ticketId: stage3.id })).attentions
        .find(a => a.status === 'pending' && a.kind === 'review'), 'auto-minted final acceptance')
    expect(acceptance.question).toContain('acceptance requested')
    expect(executorPrompts).toHaveLength(3)
    expect(executorPrompts[0]).toContain('how')
    expect(executorPrompts[2]).toContain('verify')
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
      if (tail.includes('Route ticket ')) {
        return toolCallsResponse([{ name: 'record_route', args: { flowId: 'bug-flow', rationale: 'matched bug flow' } }])
      }
      if (tail.includes('工单 ticket-')) {
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
        'version: 3',
        'flows:',
        '  - id: bug-flow',
        '    name: Bug Flow',
        '    when: bug fix',
        '    workspaceMode: in-place',
        '    enabled: true',
        '    steps:',
        '      - id: fixer',
        '        name: Bug Fixer',
        '        skills:',
        '          - tdd',
        '        goal: reproduce and fix bug and run tests',
        '      - id: reviewer',
        '        name: Read-Only Reviewer',
        '        skills:',
        '          - code-review',
        '        readOnly: true',
        '        onFail: fixer',
        '        goal: read-only review against review-report.md',
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
