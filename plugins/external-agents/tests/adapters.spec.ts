import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  AgyAdapter,
  CodexAdapter,
  buildAcpPromptBlocks,
  buildClaudeRunArgs,
  buildClaudeStreamUserMessage,
  buildCodexRunArgs,
  buildPiRunArgs,
  extractAcpAvailableCommands,
  extractAcpUsageEvent,
  extractReasoningFromSessionResponse,
  normalizeModelList,
  parseClaudeInitResponse,
  parseClaudeLine,
  parseCodexLine,
  parsePiCommandsResponse,
  parsePiLine,
  parsePiListModelsOutput,
  parsePiListModelsWithContext,
} from '../src/adapters/index.ts'
import { resolveClaudeAllowedMcpTools, type ClaudeParseState } from '../src/adapters/claude.ts'
import type { PiParseState } from '../src/adapters/pi.ts'
import type { CodexParseState } from '../src/adapters/codex.ts'

describe('external agent stream parsers and probes', () => {
  it('parses claude stream-json deltas, tool use, tool result, and terminal result', () => {
    const state: ClaudeParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parseClaudeLine(JSON.stringify({ type: 'system', session_id: 'cl-1' }), state)).toEqual([
      { type: 'session', externalSessionId: 'cl-1' },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan...' } },
    }), state)).toEqual([{ type: 'thinking_delta', delta: 'plan...' }])
    expect(parseClaudeLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }],
      },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'tc-1', name: 'Bash', arguments: '{"command":"ls"}' },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'ok', is_error: false }],
      },
    }), state)).toEqual([
      { type: 'tool_result', callId: 'tc-1', content: 'ok', isError: false },
    ])
    expect(parseClaudeLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done!' } },
    }), state)).toEqual([{ type: 'text_delta', delta: 'Done!' }])
    expect(state.lastText).toBe('Done!')
  })

  it('parses pi --list-models and --mode json events', () => {
    const models = parsePiListModelsOutput([
      'provider  model                          context  max-out  thinking  images',
      'magpie    deepseek/deepseek-flash        1.0M     393.2K   yes       yes',
      'workbuddy deepseek-v4.1-flash            1M       128K     yes       yes',
    ].join('\n'))
    expect(models).toEqual([
      { id: 'magpie/deepseek/deepseek-flash', name: 'magpie/deepseek/deepseek-flash' },
      { id: 'workbuddy/deepseek-v4.1-flash', name: 'workbuddy/deepseek-v4.1-flash' },
    ])

    const state: PiParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parsePiLine(JSON.stringify({ type: 'session', id: 'pi-42' }), state)).toEqual([
      { type: 'session', externalSessionId: 'pi-42' },
    ])
    expect(parsePiLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }), state)).toEqual([{ type: 'text_delta', delta: 'hello' }])
    expect(parsePiLine(JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 'p1',
      toolName: 'read',
      args: { path: 'README.md' },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'p1', name: 'read', arguments: '{"path":"README.md"}' },
    ])
    expect(parsePiLine(JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'p1',
      result: 'file body',
      isError: false,
    }), state)).toEqual([
      { type: 'tool_result', callId: 'p1', content: 'file body', isError: false },
    ])
  })

  it('parses codex --json records and reports missing CLI gracefully', async () => {
    const state: CodexParseState = { lastText: '' }
    expect(parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'cdx-9' }), state)).toEqual([
      { type: 'session', externalSessionId: 'cdx-9' },
    ])
    expect(parseCodexLine(JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test' },
    }), state)).toEqual([
      { type: 'tool_start', callId: 'cmd-1', name: 'command_execution', arguments: '{"command":"pnpm test"}' },
    ])
    expect(parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'cmd-1', type: 'command_execution', aggregated_output: 'pass', exit_code: 0 },
    }), state)).toEqual([
      { type: 'tool_result', callId: 'cmd-1', content: 'pass', isError: false },
    ])

    const fakeSubprocess = {
      resolveExecutable: async () => {
        throw new Error('ENOENT: codex not found')
      },
    } as unknown as SubprocessRuntime
    const codex = new CodexAdapter()
    const probed = await codex.probe(fakeSubprocess)
    expect(probed.available).toBe(false)
    expect(probed.reason).toContain('ENOENT')
    expect(probed.models.some(m => m.id === 'default')).toBe(true)
    expect(probed.reasoning?.efforts.map(effort => effort.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(probed.commands).toEqual([])
  })

  it('extracts ACP thought levels and forwards reasoning effort to each CLI', () => {
    expect(extractReasoningFromSessionResponse({
      configOptions: [
        { id: 'model', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
        {
          id: 'thought_level',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High', description: 'Deepest reasoning' },
          ],
        },
      ],
    })).toEqual({
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High', description: 'Deepest reasoning' },
      ],
    })
    expect(extractReasoningFromSessionResponse({ configOptions: [] })).toBeUndefined()
    expect(extractReasoningFromSessionResponse({})).toBeUndefined()

    expect(buildClaudeRunArgs({ model: 'sonnet', reasoningEffort: 'high' }, 'acceptEdits')).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--model', 'sonnet',
      '--effort', 'high',
    ])
    expect(buildPiRunArgs({ model: 'magpie/deepseek/deepseek-flash', reasoningEffort: 'xhigh' })).toEqual([
      '--mode', 'json', '--print',
      '--model', 'magpie/deepseek/deepseek-flash',
      '--thinking', 'xhigh',
    ])
    expect(buildCodexRunArgs({ reasoningEffort: 'medium' }, 'workspace-write')).toEqual([
      'exec', '--json',
      '-c', 'model_reasoning_effort=medium',
      '--sandbox', 'workspace-write',
      '-',
    ])
    expect(buildCodexRunArgs({ externalSessionId: 'thread-1' }, 'read-only')).toEqual([
      'exec', 'resume', 'thread-1', '--json',
      '--sandbox', 'read-only',
      '-',
    ])
  })

  it('extracts slash commands from Antigravity ACP, Claude initialize, and Pi RPC responses', () => {
    expect(extractAcpAvailableCommands({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: '/plan', description: 'Plan carefully before coding' },
        { name: 'boost', description: 'Invoke boost orchestrator', input: { hint: '<task>' } },
      ],
    })).toEqual([
      { name: 'plan', description: 'Plan carefully before coding', source: 'acp' },
      { name: 'boost', description: 'Invoke boost orchestrator', argumentHint: '<task>', source: 'acp' },
    ])

    expect(parseClaudeInitResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        response: {
          commands: [
            { name: 'code-review', description: 'Review diff', argumentHint: '[--fix]', builtin: true },
            { name: 'code-review', description: 'duplicate ignored', builtin: true },
          ],
          models: [
            { value: 'default', displayName: 'Default (recommended)' },
            { value: 'sonnet', displayName: 'Claude Sonnet 4.6' },
          ],
        },
      },
    })).toEqual({
      commands: [
        { name: 'code-review', description: 'Review diff', argumentHint: '[--fix]', source: 'builtin' },
      ],
      models: [
        { id: 'default', name: 'Default (recommended)' },
        { id: 'sonnet', name: 'Claude Sonnet 4.6' },
      ],
    })

    expect(parsePiCommandsResponse({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: {
        commands: [
          { name: 'mcp', description: 'Manage MCP servers', source: 'extension' },
          { name: 'skill:code-review', description: 'Review changes', source: 'skill' },
        ],
      },
    })).toEqual([
      { name: 'mcp', description: 'Manage MCP servers', source: 'extension' },
      { name: 'skill:code-review', description: 'Review changes', source: 'skill' },
    ])
  })

  it('disambiguates duplicate model display names while keeping unique ids', () => {
    const models = normalizeModelList([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'group/group[1m]' },
      { id: 'sonnet', name: 'group/group[1m]' },
      { id: 'haiku', name: 'group/group[1m]' },
      { id: 'group/group[1m]', name: 'group/group[1m]' },
    ])
    expect(models).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'group/group[1m] (opus)' },
      { id: 'sonnet', name: 'group/group[1m] (sonnet)' },
      { id: 'haiku', name: 'group/group[1m] (haiku)' },
      { id: 'group/group[1m]', name: 'group/group[1m]' },
    ])
  })

  it('parses claude subagent task lifecycle, isolates child text, and parses usage + contextWindow', () => {
    const state: ClaudeParseState = { sawStreamDeltas: false, lastText: '' }

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      description: 'Explore codebase',
      subagent_type: 'Explore',
      is_backgrounded: false,
    }), state)).toEqual([
      {
        type: 'task_started',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        description: 'Explore codebase',
        subagentType: 'Explore',
        isBackgrounded: false,
      },
    ])

    // Child assistant frames with parent_tool_use_id must not pollute main lastText,
    // and child tool_use surfaces as task_progress.
    expect(parseClaudeLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'tu-agent-1',
      message: {
        content: [
          { type: 'text', text: 'internal child prose' },
          { type: 'tool_use', id: 'child-tu-1', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    }), state)).toEqual([
      {
        type: 'task_progress',
        taskId: 'tu-agent-1',
        toolUseId: 'tu-agent-1',
        lastToolName: 'Grep',
      },
    ])
    expect(state.lastText).toBe('')

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      description: 'Explore codebase',
      last_tool_name: 'Read',
      summary: 'Reading adapter files',
      usage: { total_tokens: 1500, tool_uses: 3, duration_ms: 4200 },
    }), state)).toEqual([
      {
        type: 'task_progress',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        description: 'Explore codebase',
        lastToolName: 'Read',
        summary: 'Reading adapter files',
        totalTokens: 1500,
        toolUses: 3,
        durationMs: 4200,
      },
    ])

    expect(parseClaudeLine(JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tu-agent-1',
      status: 'completed',
      summary: 'Found 3 files',
      usage: { total_tokens: 2100, tool_uses: 4, duration_ms: 5100 },
    }), state)).toEqual([
      {
        type: 'task_completed',
        taskId: 'task-1',
        toolUseId: 'tu-agent-1',
        status: 'completed',
        summary: 'Found 3 files',
        totalTokens: 2100,
        toolUses: 4,
        durationMs: 5100,
      },
    ])

    expect(parseClaudeLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Final summary',
      usage: {
        input_tokens: 420,
        output_tokens: 180,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 420,
          outputTokens: 180,
          cacheReadInputTokens: 1200,
          cacheCreationInputTokens: 300,
          contextWindow: 200_000,
        },
      },
    }), state)).toEqual([
      {
        type: 'usage',
        inputTokens: 420,
        outputTokens: 180,
        cacheReadTokens: 1200,
        cacheWriteTokens: 300,
        contextWindow: 200_000,
        isTurnTotal: true,
      },
    ])

    expect(buildClaudeRunArgs({ model: 'sonnet' }, 'acceptEdits', true)).toContain('--input-format')
    const streamMsg = JSON.parse(buildClaudeStreamUserMessage('Inspect this UI', [{
      mediaType: 'image/png',
      base64: 'AQID',
    }])) as { type: string; message: { content: Array<{ type: string }> } }
    expect(streamMsg.type).toBe('user')
    expect(streamMsg.message.content.map(c => c.type)).toEqual(['text', 'image'])
  })

  it('parses ACP usage updates, Codex turn.completed usage, Pi context windows, and image inputs', () => {
    expect(extractAcpUsageEvent({ sessionUpdate: 'usage_update', used: 12_500, size: 1_000_000 })).toEqual({
      type: 'usage',
      inputTokens: 12_500,
      outputTokens: 0,
      contextUsedTokens: 12_500,
      contextWindow: 1_000_000,
    })

    expect(buildAcpPromptBlocks('See screenshot', [{
      mediaType: 'image/jpeg',
      base64: 'AAAA',
      hostPath: '/tmp/shot.jpg',
    }], true)).toEqual([
      { type: 'text', text: 'See screenshot' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg', uri: 'file:///tmp/shot.jpg' },
    ])

    const codexState: CodexParseState = { lastText: '' }
    expect(parseCodexLine(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 150 },
    }), codexState)).toEqual([
      {
        type: 'usage',
        inputTokens: 600,
        cacheReadTokens: 400,
        outputTokens: 150,
        isTurnTotal: true,
      },
    ])
    expect(buildCodexRunArgs({}, 'workspace-write', ['/tmp/a.png'])).toContain('--image')

    const piModels = parsePiListModelsWithContext([
      'provider  model                    context  max-out  thinking  images',
      'magpie    deepseek/deepseek-flash  1.0M     393.2K   yes       yes',
      'workbuddy hy3                      192K     128K     yes       yes',
    ].join('\n'))
    expect(piModels.modelContextWindows).toEqual({
      'magpie/deepseek/deepseek-flash': 1_000_000,
      'workbuddy/hy3': 192_000,
    })

    const piState: PiParseState = { sawStreamDeltas: false, lastText: '' }
    expect(parsePiLine(JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input: 310, output: 90, cacheRead: 500, cacheWrite: 0 },
      },
    }), piState)).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'usage', inputTokens: 310, outputTokens: 90, cacheReadTokens: 500, cacheWriteTokens: 0 },
    ])
  })

  it('ignores historical ACP session/update notifications replayed during session/load', async () => {
    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })

    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } },
            })}\n`)
          } else if (msg.method === 'session/load') {
            // Per ACP spec, session/load replays prior turns via session/update before returning.
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Previous turn answer' } },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'tool_call', toolCallId: 'old-call-1', title: 'Old read_file', kind: 'read' },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-sess-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh turn answer' } },
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })

    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })

    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter()
    const observed: Array<{ type: string; delta?: string; callId?: string }> = []
    const outcome = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Latest question',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-sess-1',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: (event) => {
        observed.push(event as { type: string; delta?: string; callId?: string })
      },
    })

    expect(outcome.finalText).toBe('Fresh turn answer')
    expect(observed.filter(e => e.type === 'tool_start')).toEqual([])
    expect(observed.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('Fresh turn answer')
  })

  it('keeps pooled agy ACP subprocesses alive for background run_command tasks, drains reactive wakeup, and auto-destroys on idle', async () => {
    const spawns: Array<{ terminated: boolean; stdinEnded: boolean; prompts: string[]; sessionCount: number }> = []
    let notifyControl!: { emitUpdate: (sid: string, update: Record<string, unknown>) => void }

    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => {
        const clientToAgent = new PassThrough()
        const agentToClient = new PassThrough()
        let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
        const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
          doneResolve = r
        })
        const tracker = { terminated: false, stdinEnded: false, prompts: [] as string[], sessionCount: 0 }
        spawns.push(tracker)
        const currentSid = `acp-pooled-${spawns.length}`

        notifyControl = {
          emitUpdate: (sid, update) => {
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: sid, update },
            })}\n`)
          },
        }

        let buf = ''
        clientToAgent.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          let nl = buf.indexOf('\n')
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (line !== '') {
              const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: { prompt?: Array<{ text?: string }> } }
              if (msg.method === 'initialize') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
              } else if (msg.method === 'session/new') {
                tracker.sessionCount += 1
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: currentSid } })}\n`)
              } else if (msg.method === 'session/set_mode') {
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
              } else if (msg.method === 'session/prompt') {
                const promptText = msg.params?.prompt?.[0]?.text ?? ''
                tracker.prompts.push(promptText)
                if (tracker.prompts.length === 1) {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                      sessionId: currentSid,
                      update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: 'bg-call-1',
                        name: 'run_command',
                        args: { CommandLine: 'pnpm test', WaitMsBeforeAsync: 500 },
                        status: 'in_progress',
                        kind: 'execute',
                        title: 'pnpm test',
                        rawInput: { CommandLine: 'pnpm test', WaitMsBeforeAsync: 500 },
                      },
                    },
                  })}\n`)
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { sessionId: currentSid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED_BG' } } },
                  })}\n`)
                } else {
                  agentToClient.write(`${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: { sessionId: currentSid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOLLOWUP_OK' } } },
                  })}\n`)
                }
                agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })}\n`)
              }
            }
            nl = buf.indexOf('\n')
          }
        })

        clientToAgent.once('finish', () => {
          tracker.stdinEnded = true
          agentToClient.end()
          doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
        })

        return {
          stdin: clientToAgent,
          stdout: agentToClient,
          done,
          terminate: async () => {
            tracker.terminated = true
            agentToClient.end()
            doneResolve({ exitCode: 0, signal: 'SIGTERM', stdout: '', stderr: '' })
          },
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter([], {
      idleTtlMs: 80,
      postBgIdleTtlMs: 60,
      wakeupGraceMs: 80,
      wakeupQuiescenceMs: 40,
    })

    const asyncSeen: string[] = []
    const unsub = adapter.subscribeBackground('dsh-sess-1', (evt) => {
      asyncSeen.push(evt.type)
    })

    const turn1Events: Array<{ type: string; toolName?: string }> = []
    const out1 = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Run tests',
      cwd: '/tmp',
      dshSessionId: 'dsh-sess-1',
      model: 'default',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: (e) => {
        turn1Events.push(e as { type: string; toolName?: string })
      },
    })

    expect(out1.finalText).toBe('STARTED_BG')
    expect(out1.pendingToolCallIds).toEqual(['bg-call-1'])
    expect(turn1Events.find(e => e.type === 'tool_start')?.toolName).toBe('run_command')
    // Pooled subprocess MUST stay alive because bg-call-1 is still in_progress.
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.stdinEnded).toBe(false)

    // Warm follow-up reuses the exact same pooled subprocess without respawning.
    const outFollow = await adapter.runTurn(fakeSubprocess, {
      prompt: 'Quick status?',
      cwd: '/tmp',
      dshSessionId: 'dsh-sess-1',
      model: 'default',
      permissionPolicy: 'allow',
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(outFollow.finalText).toBe('FOLLOWUP_OK')
    expect(outFollow.pendingToolCallIds).toEqual(['bg-call-1'])
    expect(spawns).toHaveLength(1)

    // Background command finishes post-PromptResponse, followed by reactive wakeup prose.
    notifyControl.emitUpdate('acp-pooled-1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bg-call-1',
      name: 'run_command',
      status: 'completed',
      kind: 'execute',
      title: 'pnpm test',
      rawOutput: { output: '24 passed', exit_code: 0 },
    })
    notifyControl.emitUpdate('acp-pooled-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All tests passed (24 passed).' },
    })

    await new Promise(r => setTimeout(r, 20))
    expect(asyncSeen).toContain('tool_result')
    expect(asyncSeen).toContain('wakeup_ready')

    const wakeupEvents: Array<{ type: string; content?: string; delta?: string }> = []
    const outWakeup = await adapter.drainWakeupTurn('dsh-sess-1', new AbortController().signal, (e) => {
      wakeupEvents.push(e as { type: string; content?: string; delta?: string })
    })
    expect(outWakeup.finalText).toBe('All tests passed (24 passed).')
    expect(outWakeup.pendingToolCallIds).toBeUndefined()
    expect(wakeupEvents.some(e => e.type === 'tool_result' && e.content?.includes('24 passed'))).toBe(true)

    // Once background work and reactive wakeup settle, postBgIdleTtlMs auto-closes the ACP child.
    await new Promise(r => setTimeout(r, 120))
    expect(spawns[0]!.stdinEnded || spawns[0]!.terminated).toBe(true)
    unsub()
    await adapter.dispose()
  })

  it('forwards bridged MCP server config to ACP, Claude, Pi, and Codex and approves dsh-manager MCP permissions', async () => {
    const serverCfg = {
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer tok-1', 'X-Dsh-Session-Id': 's-1' },
      tools: [{
        name: 'dsh_manager_create_ticket',
        description: 'Create ticket',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      }],
    } as const

    expect(buildClaudeRunArgs({ model: 'sonnet' }, 'acceptEdits', false, '/tmp/mcp.json', ['mcp__dsh-manager__*'])).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--mcp-config', '/tmp/mcp.json',
      '--allowedTools', 'mcp__dsh-manager__*',
      '--model', 'sonnet',
    ])
    expect(buildPiRunArgs({ model: 'default' }, false, ['/tmp/ext.mjs'])).toEqual([
      '--mode', 'json', '--print', '-e', '/tmp/ext.mjs',
    ])
    expect(buildCodexRunArgs({}, 'workspace-write', [], [serverCfg])).toEqual([
      'exec', '--json',
      '-c', 'mcp_servers.dsh_manager.url="http://127.0.0.1:41234/mcp"',
      '-c', 'mcp_servers.dsh_manager.http_headers={ "Authorization" = "Bearer tok-1", "X-Dsh-Session-Id" = "s-1" }',
      '--sandbox', 'workspace-write',
      '-',
    ])

    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })
    let receivedMcpServers: unknown
    let permissionOutcome: unknown
    let promptReqId: number | string | undefined

    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
          } else if (msg.method === 'session/load') {
            receivedMcpServers = msg.params?.mcpServers
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            promptReqId = msg.id
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 901,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-mcp-1',
                toolCall: {
                  toolCallId: 'tc-mgr-1',
                  kind: 'other',
                  title: 'mcp_dsh-manager_dsh_manager_create_ticket',
                },
                options: [
                  { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
                  { optionId: 'deny-1', kind: 'reject_once', name: 'Deny' },
                ],
              },
            })}\n`)
          } else if (msg.id === 901) {
            permissionOutcome = (msg.result as { outcome?: unknown })?.outcome
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })

    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    const adapter = new AgyAdapter()
    await adapter.runTurn(fakeSubprocess, {
      prompt: 'Create a manager ticket',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-mcp-1',
      permissionMode: 'accept-edits',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(receivedMcpServers).toEqual([{
      type: 'http',
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: [
        { name: 'Authorization', value: 'Bearer tok-1' },
        { name: 'X-Dsh-Session-Id', value: 's-1' },
      ],
    }])
    expect(permissionOutcome).toEqual({ outcome: 'selected', optionId: 'allow-1' })

    // Claude plan mode restricts MCP to read-only manager tools including team_config_get.
    expect(resolveClaudeAllowedMcpTools('plan', 'allow', [serverCfg])).toEqual([
      'mcp__dsh-manager__dsh_manager_board_summary',
      'mcp__dsh-manager__dsh_manager_team_config_get',
    ])
    expect(resolveClaudeAllowedMcpTools('acceptEdits', 'allow', [serverCfg])).toEqual([
      'mcp__dsh-manager__*',
    ])
    expect(resolveClaudeAllowedMcpTools('plan', 'reject', [serverCfg])).toBeUndefined()
  })

  it('allows read-only team_config_get and denies mutating manager tools in Agy plan mode', async () => {
    const serverCfg = {
      name: 'dsh-manager',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer tok-1' },
      tools: [],
    } as const
    const clientToAgent = new PassThrough()
    const agentToClient = new PassThrough()
    let doneResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }) => void
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => {
      doneResolve = r
    })
    const outcomes: Record<string, unknown> = {}
    let promptReqId: number | string | undefined
    let buf = ''
    clientToAgent.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line !== '') {
          const msg = JSON.parse(line) as { id?: number | string; method?: string; result?: unknown }
          if (msg.method === 'initialize') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)
          } else if (msg.method === 'session/load' || msg.method === 'session/set_mode') {
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
          } else if (msg.method === 'session/prompt') {
            promptReqId = msg.id
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 910,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-plan-1',
                toolCall: { toolCallId: 'tc-read', kind: 'other', title: 'mcp_dsh-manager_dsh_manager_team_config_get' },
                options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
              },
            })}\n`)
            agentToClient.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 911,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp-plan-1',
                toolCall: { toolCallId: 'tc-write', kind: 'other', title: 'mcp_dsh-manager_dsh_manager_team_member_upsert' },
                options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
              },
            })}\n`)
          } else if (msg.id === 910) {
            outcomes.read = (msg.result as { outcome?: unknown })?.outcome
          } else if (msg.id === 911) {
            outcomes.write = (msg.result as { outcome?: unknown })?.outcome
            agentToClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } })}\n`)
          }
        }
        nl = buf.indexOf('\n')
      }
    })
    clientToAgent.once('finish', () => {
      agentToClient.end()
      doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
    })
    const fakeHandle = {
      stdin: clientToAgent,
      stdout: agentToClient,
      done,
      terminate: async () => {
        agentToClient.end()
        doneResolve({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      },
    } as unknown as SubprocessHandle
    const fakeSubprocess = {
      resolveExecutable: async () => '/usr/local/bin/agy',
      spawn: () => fakeHandle,
    } as unknown as SubprocessRuntime

    await new AgyAdapter().runTurn(fakeSubprocess, {
      prompt: 'Inspect team config in plan mode',
      cwd: '/tmp',
      model: 'default',
      externalSessionId: 'acp-plan-1',
      permissionMode: 'plan',
      permissionPolicy: 'allow',
      mcpServers: [serverCfg],
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(outcomes.read).toEqual({ outcome: 'selected', optionId: 'allow-1' })
    expect(outcomes.write).toEqual({ outcome: 'cancelled' })
  })

  it('parses Claude Code rate_limit_event into rate_limit turn events', () => {
    const state = { sawStreamDeltas: false, lastText: '' }
    const events = parseClaudeLine(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.82,
        resetsAt: 1_800_000_000,
        unifiedWindows: {
          seven_day: { utilization: 0.45, resetsAt: 1_800_500_000 },
        },
      },
    }), state)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('rate_limit')
    if (events[0]?.type === 'rate_limit') {
      expect(events[0].snapshot.status).toBe('ok')
      expect(events[0].snapshot.source).toBe('passive_stream')
      const buckets = events[0].snapshot.groups?.[0]?.buckets ?? []
      expect(buckets.find(b => b.id === 'claude-5h')).toMatchObject({
        remainingPercent: 18,
        usedPercent: 82,
        status: 'warning',
      })
      expect(buckets.find(b => b.id === 'claude-weekly')).toMatchObject({
        remainingPercent: 55,
        usedPercent: 45,
      })
    }
  })
})
