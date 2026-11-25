/** Unit tests for the Multica-style external CLI backend (`claude-code`, `codex`, `agy`). */
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  buildCliInvocation,
  buildExternalCliPrompt,
  extractLeadingSlashCommand,
  parseCliStreamLine,
  probeAgentKinds,
  runCliBackend,
  type CliStreamEvent,
} from '../../src/dispatch/cli-backend.ts'

function fakeSubprocess(
  chunks: readonly string[],
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: 0, signal: null },
  stderrText = '',
): { subprocess: SubprocessRuntime; spawns: SubprocessSpawnSpec[] } {
  const spawns: SubprocessSpawnSpec[] = []
  const subprocess = {
    resolveExecutable: vi.fn(async (command: string) => `/usr/local/bin/${command}`),
    spawn: vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
      spawns.push(spec)
      const stdout = Readable.from(chunks)
      return {
        stdin: undefined,
        stdout,
        stderr: undefined,
        control: undefined,
        collected: {
          stderr: { readFrom: () => ({ text: stderrText, nextOffset: stderrText.length, lossy: false }) },
        },
        done: Promise.resolve(outcome),
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      }
    }),
  } as unknown as SubprocessRuntime
  return { subprocess, spawns }
}

describe('cli-backend', () => {
  test('buildCliInvocation selects native headless flags, permission modes, and sticky resume flags', () => {
    const claude = buildCliInvocation({
      kind: 'claude-code',
      prompt: 'fix bug',
      mapped: true,
      model: 'claude-sonnet-4-6',
      resumeSessionId: 'sess-c1',
    })
    expect(claude).toEqual({
      command: 'claude',
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--model', 'claude-sonnet-4-6', '--resume', 'sess-c1'],
      stdinData: 'fix bug',
    })

    const claudeReadOnly = buildCliInvocation({ kind: 'claude-code', prompt: 'analyze', mapped: false })
    expect(claudeReadOnly.args).toContain('plan')

    const agy = buildCliInvocation({
      kind: 'agy',
      prompt: 'refactor',
      mapped: true,
      resumeSessionId: 'conv-1',
    })
    expect(agy).toEqual({
      command: 'agy',
      args: ['--output-format', 'stream-json', '--mode', 'accept-edits', '--conversation', 'conv-1', '--print=refactor'],
    })

    const codex = buildCliInvocation({
      kind: 'codex',
      prompt: 'test',
      mapped: false,
      resumeSessionId: 'thr-9',
    })
    expect(codex).toEqual({
      command: 'codex',
      args: ['exec', 'resume', 'thr-9', '--json', '--sandbox', 'read-only', '-'],
      stdinData: 'test',
    })

    const cursor = buildCliInvocation({
      kind: 'cursor',
      prompt: 'ship fix',
      mapped: true,
      model: 'claude-4-sonnet',
      resumeSessionId: 'cur-1',
    })
    expect(cursor).toEqual({
      command: 'cursor-agent',
      args: ['-p', '--output-format', 'stream-json', '--trust', '--force', '--model', 'claude-4-sonnet', '--resume', 'cur-1'],
      stdinData: 'ship fix',
    })
    expect(buildCliInvocation({ kind: 'cursor', prompt: 'ro', mapped: false }).args).not.toContain('--force')

    const pi = buildCliInvocation({
      kind: 'pi',
      prompt: 'inspect repo',
      mapped: false,
      model: 'anthropic/claude-sonnet-4-5:medium',
      resumeSessionId: 'pi-sess-1',
    })
    expect(pi).toEqual({
      command: 'pi',
      args: ['--mode', 'json', '--print', '--tools', 'read,grep,find,ls', '--model', 'anthropic/claude-sonnet-4-5:medium', '--session', 'pi-sess-1'],
      stdinData: 'inspect repo',
    })
    expect(buildCliInvocation({ kind: 'pi', prompt: 'edit', mapped: true }).args).not.toContain('--tools')
  })

  test('parseCliStreamLine normalizes claude/agy stream-json and codex jsonl lines', () => {
    expect(parseCliStreamLine('claude-code', '')).toEqual([])
    expect(parseCliStreamLine('claude-code', 'not json')).toEqual([])
    expect(parseCliStreamLine('agy', JSON.stringify({ event: 'init', conversation_id: 'conv-42' }))).toEqual([
      { type: 'init', externalSessionId: 'conv-42' },
    ])
    expect(parseCliStreamLine('agy', JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Working...' },
    }))).toEqual([
      { type: 'text_delta', delta: 'Working...' },
    ])
    expect(parseCliStreamLine('agy', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-42', status: 'SUCCESS', response: 'Done!' },
    }))).toEqual([
      { type: 'result', ok: true, output: 'Done!', externalSessionId: 'conv-42' },
    ])
    expect(parseCliStreamLine('claude-code', JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.ts' } },
          { type: 'text', text: 'Updated src/app.ts' },
        ],
      },
    }))).toEqual([
      {
        type: 'progress',
        message: 'tool: Edit: src/app.ts',
        activity: { category: 'file', toolName: 'Edit', target: 'src/app.ts' },
      },
      { type: 'text', text: 'Updated src/app.ts' },
    ])
    expect(parseCliStreamLine('claude-code', JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All tests pass',
      session_id: 's-1',
    }))).toEqual([
      { type: 'result', ok: true, output: 'All tests pass', externalSessionId: 's-1' },
    ])

    expect(parseCliStreamLine('codex', JSON.stringify({ type: 'thread.started', thread_id: 't-1' }))).toEqual([
      { type: 'init', externalSessionId: 't-1' },
    ])
    expect(parseCliStreamLine('codex', JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'pnpm test' },
    }))).toEqual([
      {
        type: 'progress',
        message: 'cmd: pnpm test',
        activity: { category: 'command', toolName: 'command_execution', target: 'pnpm test' },
      },
    ])
    expect(parseCliStreamLine('codex', JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Codex done' },
    }))).toEqual([
      { type: 'text', text: 'Codex done' },
    ])

    expect(parseCliStreamLine('pi', JSON.stringify({ type: 'session', version: 3, id: 'pi-1' }))).toEqual([
      { type: 'init', externalSessionId: 'pi-1' },
    ])
    expect(parseCliStreamLine('pi', JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'vitest run' },
    }))).toEqual([
      {
        type: 'progress',
        message: 'tool: bash: vitest run',
        activity: { category: 'command', toolName: 'bash', target: 'vitest run' },
      },
    ])
    expect(parseCliStreamLine('pi', JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Pi finished' }], stopReason: 'stop' },
    }))).toEqual([
      { type: 'text', text: 'Pi finished' },
    ])
    expect(parseCliStreamLine('pi', JSON.stringify({
      type: 'agent_settled',
      aborted: false,
    }))).toEqual([
      { type: 'result', ok: true, output: '' },
    ])
  })

  test('runCliBackend buffers split NDJSON chunks, streams events, and captures sticky session id', async () => {
    const line1 = JSON.stringify({ event: 'init', conversation_id: 'agy-sess-42' })
    const line2 = JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'run_command', state: 'ACTIVE', command: 'pnpm test' },
    })
    const line3 = JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'Tests ' },
    })
    const line4 = JSON.stringify({
      event: 'result',
      result: { conversation_id: 'agy-sess-42', status: 'SUCCESS', response: 'Tests green' },
    })
    const combined = `${line1}\n${line2}\n${line3}\n${line4}\n`
    const mid = Math.floor(combined.length / 2)

    const { subprocess, spawns } = fakeSubprocess([combined.slice(0, mid), combined.slice(mid)])
    const seen: CliStreamEvent[] = []
    let activityCalls = 0
    const outcome = await runCliBackend(subprocess, {
      kind: 'agy',
      cwd: '/tmp/worktree',
      prompt: 'Run tests',
      mapped: true,
      onActivity: () => { activityCalls += 1 },
      onEvent: (event) => { seen.push(event) },
    })

    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.argv).toEqual(['/usr/local/bin/agy', '--output-format', 'stream-json', '--mode', 'accept-edits', '--print=Run tests'])
    expect(spawns[0]!.cwd).toBe('/tmp/worktree')
    expect(spawns[0]!.stdio.stdin).toBe('ignore')
    expect(outcome).toEqual({
      ok: true,
      output: 'Tests green',
      externalSessionId: 'agy-sess-42',
      exitCode: 0,
      stderr: '',
    })
    expect(activityCalls).toBe(2)
    expect(seen.map(event => event.type)).toEqual(['init', 'progress', 'text_delta', 'result'])
  })

  test('runCliBackend reports failure when process exits non-zero without success result', async () => {
    const { subprocess } = fakeSubprocess([], { exitCode: 1, signal: null }, 'authentication required')
    const outcome = await runCliBackend(subprocess, {
      kind: 'claude-code',
      cwd: '/tmp/worktree',
      prompt: 'Run task',
      mapped: true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('authentication required')
    expect(outcome.exitCode).toBe(1)
  })

  test('probeAgentKinds reports builtin always available and detects installed vs missing CLIs with versions', async () => {
    const subprocess = {
      resolveExecutable: vi.fn(async (command: string) => {
        if (command === 'claude') return '/opt/homebrew/bin/claude'
        if (command.endsWith('/.local/bin/agy')) return command
        throw new Error(`not found: ${command}`)
      }),
      spawn: vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
        const versionText = spec.argv[0]?.includes('claude')
          ? '2.1.12 (Claude Code)\n'
          : '0.9.4-agy\n'
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          control: undefined,
          collected: {
            stdout: { readFrom: () => ({ text: versionText, nextOffset: versionText.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: vi.fn(),
          waitForExit: vi.fn(async () => true),
        }
      }),
    } as unknown as SubprocessRuntime

    const probed = await probeAgentKinds(subprocess)
    expect(probed).toHaveLength(6)
    expect(probed[0]).toEqual({ kind: 'builtin', command: '', available: true })
    expect(probed.find(entry => entry.kind === 'claude-code')).toEqual({
      kind: 'claude-code',
      command: 'claude',
      available: true,
      executablePath: '/opt/homebrew/bin/claude',
      version: '2.1.12 (Claude Code)',
    })
    expect(probed.find(entry => entry.kind === 'agy')?.available).toBe(true)
    expect(probed.find(entry => entry.kind === 'agy')?.version).toBe('0.9.4-agy')
    expect(probed.find(entry => entry.kind === 'codex')).toMatchObject({
      kind: 'codex',
      command: 'codex',
      available: false,
    })

    const withoutSubprocess = await probeAgentKinds(undefined)
    expect(withoutSubprocess.find(entry => entry.kind === 'builtin')?.available).toBe(true)
    expect(withoutSubprocess.find(entry => entry.kind === 'claude-code')?.available).toBe(false)
  })

  test('extractLeadingSlashCommand & buildExternalCliPrompt hoist /commands to byte 0 without matching file paths', () => {
    expect(extractLeadingSlashCommand('  /gsd:plan auth refactor\nKeep API compatible')).toEqual({
      commandLine: '/gsd:plan auth refactor',
      remainder: 'Keep API compatible',
    })
    expect(extractLeadingSlashCommand('/Users/zhanglei/project/file.ts')).toBeUndefined()
    expect(extractLeadingSlashCommand('Fix bug cleanly')).toBeUndefined()

    const prompt = buildExternalCliPrompt({
      candidates: ['  /review src/app.ts\nFocus on error paths', '/fallback', 'Title'],
      bodyLines: [
        'Ticket T-1: Audit.',
        'Mandate scope: Check error paths (strength strict).',
        undefined,
        'Work directly in the git worktree at /tmp/wt.',
      ],
    })
    expect(prompt.startsWith('/review src/app.ts\n\nContext:\nFocus on error paths\nTicket T-1: Audit.')).toBe(true)
    expect(prompt).toContain('Work directly in the git worktree at /tmp/wt.')

    const plain = buildExternalCliPrompt({
      candidates: ['/Users/dev/repo/main.ts', 'Normal instruction'],
      bodyLines: ['Ticket T-2: Plain.', 'Done.'],
    })
    expect(plain).toBe('Ticket T-2: Plain.\nDone.')
  })
})
