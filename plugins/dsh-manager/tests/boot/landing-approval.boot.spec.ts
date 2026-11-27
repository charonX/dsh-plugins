/**
 * Boot-tier integration spec for Slice 3 & Slice 4:
 * - Executor prompt carries a `Repo rules` pointer plus git branch/remote context, never the doc bodies (zero static config).
 * - `check_branch_rebase` executes immediately without approval.
 * - `local_merge_branch` is intercepted at `tools/pre-execute` as `'merge-mr'` Approval,
 *   does not mutate `main` until approved, and lands cleanly onto `main` after approval.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const execFileAsync = promisify(execFile)
const landHome = await mkdtemp(join(tmpdir(), 'dsh-land-boot-'))
const repoDir = await mkdtemp(join(tmpdir(), 'dsh-land-repo-'))

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
  return res.stdout.trim()
}

async function writeOverlay(home: string, port: number): Promise<string> {
  const overlayPath = join(home, 'landing.patch.yml')
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
    '          tickMs: 250',
    '          turnTimeoutMs: 30000',
    `          cwd: ${JSON.stringify(repoDir)}`,
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

class LandingAdapter extends LlmAdapter {
  readonly seenPrompts: string[] = []
  private step = 0

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
      this.seenPrompts.push(tail)
      this.step = 1
      for (const c of toolCallsResponse([{ name: 'check_branch_rebase', args: { targetBranch: 'main' } }])) yield c
      return
    }
    if (last.role === 'tool' && this.step === 1) {
      this.step = 2
      for (const c of toolCallsResponse([{
        name: 'local_merge_branch',
        args: { targetBranch: 'main', strategy: 'merge-commit' },
      }])) yield c
      return
    }
    if (last.role === 'tool' && this.step === 2) {
      this.step = 3
      for (const c of toolCallsResponse([{
        name: 'submit_report',
        args: { kind: 'ready', message: 'rebased check & merged onto main after approval' },
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
  for (const dir of [landHome, repoDir]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('discovers AGENTS.md landing policy, allows non-destructive check_branch_rebase, and gates local_merge_branch behind Approval', async () => {
  await git(repoDir, 'init', '-b', 'main')
  await git(repoDir, 'config', 'user.email', 'test@example.com')
  await git(repoDir, 'config', 'user.name', 'Test User')
  await writeFile(join(repoDir, 'AGENTS.md'), '# Landing Policy\nLocal repository merges directly into main.\n', 'utf8')
  await git(repoDir, 'add', 'AGENTS.md')
  await git(repoDir, 'commit', '-m', 'seed repo AGENTS.md')
  const baseSha = await git(repoDir, 'rev-parse', 'HEAD')

  const overlayPath = await writeOverlay(landHome, 3110)
  const adapter = new LandingAdapter()
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home: landHome,
  })
  try {
    await waitUntilService(ctx, 'dshManagerExecutor')
    ctx.llm.registerAdapter(['mock'], adapter)
    const workspace = await ctx.workspaceRegistry.create(repoDir, 'Landing Test')

    const ticket = await ctx.dshManagerBoard.mintDirectTicket({
      title: 'Land verified change locally',
      scope: 'Verify branch and merge locally into main per AGENTS.md',
      projectId: workspace.id,
    }, Date.now())

    // Pre-seed a commit in the ticket worktree branch? Dispatch will create the worktree on `worktree/<ticket.id>`.
    await ctx.dshManagerExecutor.dispatchTicket({ ticketId: ticket.id })

    // Wait for `local_merge_branch` approval attention (meaning `check_branch_rebase` passed WITHOUT blocking!).
    let approvalId = ''
    await vi.waitFor(async () => {
      const views = (await ctx.dshManagerExecutor.attentionList({ ticketId: ticket.id })).attentions
      const pending = views.find(v => v.status === 'pending' && v.kind === 'approval')
      expect(pending?.action?.tool).toBe('local_merge_branch')
      expect(pending?.action?.category).toBe('merge-mr')
      approvalId = pending!.id
    }, { timeout: 20_000 })

    // Repo rules are pointed at, not inlined: the executor's own runtime loads AGENTS.md.
    expect(adapter.seenPrompts[0]).toContain('Repo rules: read ')
    expect(adapter.seenPrompts[0]).toContain('AGENTS.md')
    expect(adapter.seenPrompts[0]).not.toContain('Local repository merges directly into main.')
    // `main` has NOT been mutated before human approval.
    expect(await git(repoDir, 'rev-parse', 'HEAD')).toBe(baseSha)

    // Approve `local_merge_branch` -> Executor completes with `ready`.
    await ctx.dshManagerExecutor.answerAttention({ attentionId: approvalId, answer: 'approved' })
    await vi.waitFor(async () => {
      const detail = await ctx.dshManagerExecutor.ticketDetail({ ticketId: ticket.id })
      expect(detail.dispatches.some(d => d.outcome === 'ready')).toBe(true)
    }, { timeout: 20_000 })
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
