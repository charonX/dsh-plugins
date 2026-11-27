/**
 * Ephemeral loopback Streamable-HTTP MCP server exposing allowed DSH host
 * plugin tools (such as `dsh_manager_*` companion tools) to third-party CLIs.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolsService } from '@deepseek-ai/dsh-tools'
import type { ExternalMcpServerConfig, ExternalMcpToolSpec } from './adapters/base.ts'

const DEFAULT_TOOL_PREFIXES = ['dsh_manager_'] as const
const DEFAULT_ALLOWED_TOOL_NAMES = new Set<string>([
  // Dsh Manager executor session tools (scoped to executor Agent)
  'submit_report',
  'ask_user',
  'post_mr_comment',
  'set_jira_status',
  'check_branch_rebase',
  'local_merge_branch',
  'push_branch',
  'create_mr_or_pr',
  'register_worktree',
  // Dsh Manager steward session tools (scoped to steward Agent)
  'record_triage_batch',
  'record_decision',
  'record_route',
  'suggest_end',
  'keep_open',
  'propose_policy',
  'record_followup',
  'record_review',
])
const MAX_BODY_BYTES = 1_048_576
const MCP_SERVER_NAME = 'dsh-manager'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}

function constantTimeEquals(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('MCP request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, statusCode: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(statusCode)
    res.end()
    return
  }
  const json = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

function extractResultText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

export class HostToolsMcpBridge {
  private readonly token = randomBytes(24).toString('hex')
  private readonly toolPrefixes: readonly string[]
  private readonly allowedToolNames: ReadonlySet<string>
  private server: Server | undefined
  private startPromise: Promise<string> | undefined
  private url: string | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    toolPrefixes: readonly string[] = DEFAULT_TOOL_PREFIXES,
    allowedToolNames: ReadonlySet<string> = DEFAULT_ALLOWED_TOOL_NAMES,
  ) {
    this.toolPrefixes = toolPrefixes
    this.allowedToolNames = allowedToolNames
  }

  private isAllowedToolName(name: string): boolean {
    return this.allowedToolNames.has(name) || this.toolPrefixes.some(prefix => name.startsWith(prefix))
  }

  private toolsSvc(): ToolsService | undefined {
    return this.ctx.get('tools') as ToolsService | undefined
  }

  private resolveAgent(sessionId: string | undefined): Agent | undefined {
    if (sessionId === undefined || sessionId === '') return undefined
    const agents = this.ctx.get('agents') as AgentRegistry | undefined
    return agents?.get(brandString<SessionId>(sessionId))
  }

  listToolSpecs(dshSessionId?: string): readonly ExternalMcpToolSpec[] {
    const tools = this.toolsSvc()
    if (tools === undefined) return []
    const agent = this.resolveAgent(dshSessionId)
    return tools.definitions(agent)
      .filter(def => this.isAllowedToolName(def.name))
      .map(def => ({
        name: def.name,
        description: def.description,
        inputSchema: def.parameters,
      }))
  }

  async resolveServerForSession(dshSessionId?: string): Promise<ExternalMcpServerConfig | undefined> {
    if (this.disposed) return undefined
    const tools = this.listToolSpecs(dshSessionId)
    if (tools.length === 0) return undefined
    const url = await this.ensureStarted()
    return {
      name: MCP_SERVER_NAME,
      url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(dshSessionId !== undefined && dshSessionId !== '' ? { 'X-Dsh-Session-Id': dshSessionId } : {}),
      },
      tools,
    }
  }

  async ensureStarted(): Promise<string> {
    if (this.disposed) {
      throw new Error('HostToolsMcpBridge has been disposed')
    }
    if (this.url !== undefined) return this.url
    if (this.startPromise !== undefined) return this.startPromise

    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleHttpRequest(req, res).catch((error) => {
          if (!res.headersSent) {
            writeJson(res, 500, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            })
          } else {
            res.end()
          }
        })
      })
      server.once('error', (error) => {
        this.startPromise = undefined
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          reject(new Error('Failed to bind loopback MCP bridge address'))
          return
        }
        this.server = server
        this.url = `http://127.0.0.1:${address.port}/mcp`
        resolve(this.url)
      })
    })

    return this.startPromise
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (reqUrl.pathname !== '/mcp') {
      writeJson(res, 404, { error: 'Not Found' })
      return
    }

    const auth = readHeader(req, 'authorization') ?? ''
    if (!constantTimeEquals(`Bearer ${this.token}`, auth)) {
      writeJson(res, 401, { error: 'Unauthorized' })
      return
    }

    if (req.method === 'GET') {
      writeJson(res, 405, { error: 'Method Not Allowed' })
      return
    }
    if (req.method === 'DELETE') {
      writeJson(res, 204)
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' })
      return
    }

    let payload: unknown
    try {
      payload = await readJsonBody(req)
    } catch {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (!isPlainRecord(payload) || typeof payload.method !== 'string') {
      writeJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
      return
    }

    const rpcId = payload.id as string | number | null | undefined
    const method = payload.method
    const params = isPlainRecord(payload.params) ? payload.params : {}
    const sessionId = readHeader(req, 'x-dsh-session-id')

    if (rpcId === undefined) {
      writeJson(res, 202)
      return
    }

    if (method === 'initialize') {
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-host-tools', version: '0.1.0' },
        },
      })
      return
    }

    if (method === 'ping') {
      writeJson(res, 200, { jsonrpc: '2.0', id: rpcId, result: {} })
      return
    }

    if (method === 'tools/list') {
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: { tools: this.listToolSpecs(sessionId) },
      })
      return
    }

    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : ''
      const argsObj = isPlainRecord(params.arguments) ? params.arguments : {}
      const result = await this.executeToolCall(toolName, argsObj, sessionId, req)
      writeJson(res, 200, { jsonrpc: '2.0', id: rpcId, result })
      return
    }

    writeJson(res, 200, {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32601, message: `Method not found: ${method}` },
    })
  }

  private async executeToolCall(
    toolName: string,
    argsObj: Record<string, unknown>,
    sessionId: string | undefined,
    req: IncomingMessage,
  ): Promise<{ readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>; readonly isError?: boolean }> {
    const tools = this.toolsSvc()
    if (tools === undefined || !this.isAllowedToolName(toolName)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool "${toolName}" is not exposed on DSH host MCP bridge.` }],
      }
    }
    const agent = this.resolveAgent(sessionId)
    if (tools.executable(toolName, agent) === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool "${toolName}" is unavailable in current DSH host scope.` }],
      }
    }

    const ac = new AbortController()
    const onClose = (): void => { ac.abort(new Error('MCP HTTP request closed')) }
    req.once('close', onClose)
    try {
      const batch = await tools.execute({
        calls: [{
          type: 'tool-call',
          id: brandString<ToolCallId>(randomUUID()),
          name: toolName,
          arguments: JSON.stringify(argsObj),
        }],
        signal: ac.signal,
        ...(agent === undefined ? {} : { agent }),
      })
      const entry = batch.results[0]?.result
      if (entry === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Tool "${toolName}" produced no result.` }],
        }
      }
      if (entry.isError) {
        const msg = extractResultText(entry.content as readonly { readonly type: string; readonly text?: string }[])
          || entry.error.message
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        }
      }
      const rendered = extractResultText(entry.content as readonly { readonly type: string; readonly text?: string }[])
      const serializedValue = entry.value !== undefined && typeof entry.value === 'object' && entry.value !== null
        ? JSON.stringify(entry.value)
        : rendered
      return {
        content: [{ type: 'text', text: serializedValue || rendered || 'ok' }],
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }
    } finally {
      req.removeListener('close', onClose)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const server = this.server
    this.server = undefined
    this.url = undefined
    this.startPromise = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
