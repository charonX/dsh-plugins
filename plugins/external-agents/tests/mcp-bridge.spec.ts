import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistryPlugin from '@deepseek-ai/dsh-agent'
import AgentLoopPlugin from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmPlugin from '@deepseek-ai/dsh-llm'
import SessionPlugin, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import SubprocessLocalPlugin from '@deepseek-ai/dsh-subprocess-local'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutorPlugin from '@deepseek-ai/dsh-tool-executor-native'
import ToolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { HostToolsMcpBridge } from '../src/mcp-bridge.ts'

describe('HostToolsMcpBridge', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn()
    }
  })

  it('exposes only dsh_manager_* tools, enforces bearer auth, and forwards executing Agent context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-mcp-bridge-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionPlugin)
    await ctx.plugin(SessionPlugin)
    await ctx.plugin(LlmPlugin)
    await ctx.plugin(ToolsPlugin)
    await ctx.plugin(NativeToolExecutorPlugin)
    await ctx.plugin(SystemPromptPlugin)
    await ctx.plugin(SubprocessLocalPlugin)
    await ctx.plugin(AgentRegistryPlugin)
    await ctx.plugin(AgentLoopPlugin, { agents: [] })

    const bridge = new HostToolsMcpBridge(ctx)
    cleanups.push(() => bridge.dispose())

    // Before dsh_manager_* tools exist, resolver returns undefined.
    expect(await bridge.resolveServerForSession('sess-mcp-1')).toBeUndefined()

    const callsSeen: Array<{ title: string; agentId?: string; cwd?: string }> = []
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'dsh_manager_create_ticket',
      description: 'Create ticket in Dsh Manager',
      parameters: {
        title: { type: 'string', required: true, description: 'Ticket title' },
        description: { type: 'string', required: true, description: 'Ticket description' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            submitted: { type: 'boolean' },
            ticketId: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `created ${String(value.ticketId)}` }],
      },
      async execute(args, exec) {
        const sessionCwd = (exec?.agent as { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined)?.session?.header?.cwd
        callsSeen.push({
          title: String(args.title ?? ''),
          ...(exec?.agent?.id === undefined ? {} : { agentId: exec.agent.id }),
          ...(sessionCwd === undefined ? {} : { cwd: sessionCwd }),
        })
        return { submitted: true, ticketId: 'tk-mcp-101' }
      },
    })))

    // Non-manager global tools must NOT leak across the bridge.
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'internal_secret_tool',
      description: 'Not bridged',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'secret' }] },
      async execute() { return { ok: true } },
    })))

    const reportsSeen: Array<{ kind: string; message: string }> = []
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('sess-mcp-1'),
      meta: { cwd: dir },
      agentOptions: { provider: 'ext-agy', model: 'default' },
      setup: (agentCtx) => {
        agentCtx.tools.register(defineTool({
          name: 'submit_report',
          description: 'Report ticket progress to Steward',
          parameters: {
            kind: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
          output: { schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' } } }, render: () => [{ type: 'text', text: 'recorded' }] },
          async execute(args) {
            reportsSeen.push({ kind: String(args.kind), message: String(args.message) })
            return { recorded: true }
          },
        }))
        agentCtx.tools.register(defineTool({
          name: 'ask_user',
          description: 'Ask user a question',
          parameters: {
            question: { type: 'string', required: true },
            details: { type: 'string', required: true },
          },
          output: { schema: { type: 'object', additionalProperties: false, properties: { attentionId: { type: 'string' } } }, render: () => [{ type: 'text', text: 'asked' }] },
          async execute() { return { attentionId: 'att-1' } },
        }))
      },
    })
    cleanups.push(() => handle.dispose())

    const serverCfg = await bridge.resolveServerForSession('sess-mcp-1')
    expect(serverCfg).toBeDefined()
    expect(serverCfg?.name).toBe('dsh-manager')
    expect(serverCfg?.tools?.map(t => t.name)).toEqual(
      expect.arrayContaining(['dsh_manager_create_ticket', 'submit_report', 'ask_user']),
    )
    expect(serverCfg?.tools?.map(t => t.name)).not.toContain('internal_secret_tool')

    // Unauthenticated call is rejected with 401.
    const unauthRes = await fetch(serverCfg!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(unauthRes.status).toBe(401)

    // tools/list returns allowed manager/executor tools and excludes internal_secret_tool.
    const listRes = await fetch(serverCfg!.url, {
      method: 'POST',
      headers: { ...serverCfg!.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json() as { result: { tools: Array<{ name: string }> } }
    expect(listJson.result.tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['dsh_manager_create_ticket', 'submit_report', 'ask_user']),
    )
    expect(listJson.result.tools.map(t => t.name)).not.toContain('internal_secret_tool')

    // tools/call executes dsh_manager_create_ticket with owning Agent + cwd intact.
    const callRes = await fetch(serverCfg!.url, {
      method: 'POST',
      headers: { ...serverCfg!.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'dsh_manager_create_ticket',
          arguments: { title: 'Refactor board IA', description: 'Follow align-card.md' },
        },
      }),
    })
    const callJson = await callRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(callJson.result.isError).toBeUndefined()
    expect(callJson.result.content[0]?.text).toContain('tk-mcp-101')
    expect(callsSeen).toEqual([{ title: 'Refactor board IA', agentId: 'sess-mcp-1', cwd: dir }])

    // tools/call executes session-scoped submit_report on the owning Agent.
    const reportRes = await fetch(serverCfg!.url, {
      method: 'POST',
      headers: { ...serverCfg!.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'submit_report',
          arguments: { kind: 'ready', message: 'merged into test' },
        },
      }),
    })
    const reportJson = await reportRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(reportJson.result.isError).toBeUndefined()
    expect(reportJson.result.content[0]?.text).toContain('recorded')
    expect(reportsSeen).toEqual([{ kind: 'ready', message: 'merged into test' }])

    // Non-bridged tool names are denied.
    const denyRes = await fetch(serverCfg!.url, {
      method: 'POST',
      headers: { ...serverCfg!.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'internal_secret_tool', arguments: {} },
      }),
    })
    const denyJson = await denyRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(denyJson.result.isError).toBe(true)
    expect(denyJson.result.content[0]?.text).toContain('not exposed')
  })
})
