/**
 * Boot-tier spec for the dispatch prompt budget (ADR 0011):
 * - a dispatched prompt stays inside 8000 chars and carries no inlined repo docs,
 *   only a `Repo rules` pointer;
 * - the worktree lands in the sub-repo the ticket names, not in the workspace root;
 * - artifacts point at a real scratch directory (no doubled workspace segments);
 * - an over-budget ticket fails loudly with an attention instead of a truncated prompt.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const execFileAsync = promisify(execFile)
const home = await mkdtemp(join(tmpdir(), 'dsh-budget-boot-'))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-budget-ws-'))
const subRepo = join(workspace, 'repos', 'sample-plugin')
const DOC_BODY_MARKER = 'SAMPLE-PLUGIN-RULES-BODY'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
  return res.stdout.trim()
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

function dispatchPromptText(options: GenerateOptions): string | undefined {
  const dispatched = options.messages
    .filter(message => message.role === 'user')
    .map(message => message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n'))
    .filter(text => text.includes('executor dispatched for ticket'))
  return dispatched.at(-1)
}

class CapturingAdapter extends LlmAdapter {
  readonly seenPrompts: string[] = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    if (last === undefined) {
      for (const chunk of textResponse('done')) yield chunk
      return
    }
    if (JSON.stringify(last).includes('Generate the session title')) {
      for (const chunk of textResponse('Title')) yield chunk
      return
    }
    const dispatched = dispatchPromptText(options)
    if (dispatched !== undefined) this.seenPrompts.push(dispatched)
    if (last.role === 'user') {
      for (const chunk of toolCallsResponse([{ name: 'submit_report', args: { kind: 'ready', message: 'prompt inspected' } }])) yield chunk
      return
    }
    for (const chunk of textResponse('done')) yield chunk
  }
}

async function writeOverlay(): Promise<string> {
  const overlayPath = join(home, 'budget.patch.yml')
  await writeFile(overlayPath, [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 3111',
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
    '          tickMs: 250',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(workspace)}`,
    '',
  ].join('\n'))
  return overlayPath
}

async function waitUntilService(ctx: Context, name: string, timeoutMs = 30_000): Promise<void> {
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + timeoutMs
  while (reflect.get(name, true) === undefined) {
    if (Date.now() > deadline) throw new Error(`service ${name} timeout`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

async function seedWorkspace(): Promise<void> {
  // A workspace container whose only tracked content is a sub-repo: exactly the shape
  // that used to make the executor land its worktree on the aggregate root.
  await writeFile(join(workspace, 'AGENTS.md'), '# Workspace rules\nAggregate container; sub-repos keep their own git.\n', 'utf8')
  await mkdir(join(workspace, 'repos'), { recursive: true })
  await mkdir(join(workspace, 'scratch', 'tasks'), { recursive: true })
  await mkdir(subRepo, { recursive: true })
  await git(subRepo, 'init', '-b', 'main')
  await writeFile(join(subRepo, 'AGENTS.md'), `# Sample plugin rules\n${DOC_BODY_MARKER}\n`, 'utf8')
  await symlink('AGENTS.md', join(subRepo, 'CLAUDE.md'))
  await writeFile(join(subRepo, 'README.md'), '# sample\n', 'utf8')
  await git(subRepo, 'add', '-A')
  await git(subRepo, '-c', 'user.email=boot@test', '-c', 'user.name=boot', 'commit', '-m', 'seed sub repo')
}

afterAll(async () => {
  for (const dir of [home, workspace]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('dispatch prompt stays inside the budget, points at repo rules, and lands the worktree in the named sub-repo', async () => {
  await seedWorkspace()
  const overlayPath = await writeOverlay()
  const adapter = new CapturingAdapter()
  const ctx = await bootTestProfile({ binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home })
  try {
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)
    const project = await ctx.workspaceRegistry.create(workspace, 'Budget Test')
    const ticket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Harden the sample plugin adapter',
      scope: 'Work only inside repos/sample-plugin: harden its adapter and keep the harness untouched.',
      acceptanceCriteria: '1. pnpm test passes\n2. one real run logs to scratch/tasks/sample-plugin/test-report.log',
      projectId: project.id,
      scratchDir: 'scratch/tasks/sample-plugin',
    }, Date.now())

    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket.id })
    await vi.waitFor(() => {
      expect(adapter.seenPrompts.length).toBeGreaterThan(0)
    }, { timeout: 30_000 })

    const prompt = adapter.seenPrompts[0] ?? ''
    expect(prompt.length).toBeLessThanOrEqual(8_000)
    // Repo rules are a pointer, never the body.
    expect(prompt).toMatch(/Repo rules: read .*sample-plugin.*AGENTS\.md/)
    expect(prompt.split('Repo rules: read ').length - 1).toBe(1)
    expect(prompt).not.toContain(DOC_BODY_MARKER)
    // No whole-catalog skill dump.
    expect(prompt).not.toContain('Other available skills')
    // The worktree follows the repo the ticket named, not the workspace container.
    expect(prompt).toMatch(/Worktree plan: repo=[^\n]*\/repos\/sample-plugin,/)
    // Artifacts resolve to a real scratch directory without doubled segments.
    const scratchLine = prompt.split('\n').find(line => line.startsWith('Task scratch directory: '))
    expect(scratchLine).toBeDefined()
    expect(scratchLine).not.toContain('/home-repos/home-repos')
    expect(scratchLine).toMatch(/\/scratch\/tasks\/sample-plugin /)
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)

test('an over-budget mandate fails the dispatch and raises an attention instead of truncating', async () => {
  const overlayPath = await writeOverlay()
  const adapter = new CapturingAdapter()
  const ctx = await bootTestProfile({ binName: 'dsh-manager-test-b', profile: 'web', overlayPaths: [overlayPath], home })
  try {
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)
    const project = await ctx.workspaceRegistry.create(workspace, 'Budget Test')
    const ticket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Oversized ticket',
      scope: `Work inside repos/sample-plugin. ${'detail '.repeat(1_600)}`,
      acceptanceCriteria: '1. pnpm test passes',
      projectId: project.id,
      scratchDir: 'scratch/tasks/oversized',
    }, Date.now())

    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket.id })

    await vi.waitFor(async () => {
      const views = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket.id })).attentions
      const pending = views.find(view => view.status === 'pending')
      expect(pending?.kind).toBe('question')
      expect(pending?.question ?? '').toContain('8000-char budget')
    }, { timeout: 30_000 })

    const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: ticket.id })
    expect(detail.dispatches.some(dispatch => dispatch.outcome === 'failed')).toBe(true)
    // The oversized prompt was never handed to the model.
    expect(adapter.seenPrompts.some(text => text.includes('Oversized ticket'))).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
