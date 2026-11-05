/**
 * HTTP surface: one `prefix` route on the Host web server answering the Web
 * Client's JSON requests. Mutating requests are checked against the Host trust
 * rules, because a translation request spends model quota on the user's behalf.
 *
 * @module dsh-immersive-translate/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { asTranslateError, TranslateError } from './errors.js'
import { translateBatch, type EngineLimits } from './engine.js'
import { resolveSelection } from './models.js'
import { PrefsStore, type Logger } from './prefs.js'
import { appendBatchPointer, batchKey, type BatchArchive, type TranslateBatchRecord } from './records.js'
import type {
  EngineState,
  ProviderGroupView,
  SelectionView,
  TranslateItem,
  TranslatePrefs,
  TranslateRequestBody,
} from './shared/api.js'

/** Largest accepted JSON body: a batch of text units plus bookkeeping. */
const MAX_BODY_BYTES = 512 * 1024

/** Services and callbacks the routes read. */
export interface HttpDeps {
  /** Absolute route prefix without a trailing slash. */
  readonly prefix: string
  /** Request ceilings shared with the engine. */
  readonly limits: EngineLimits
  /** Stored reader preferences. */
  readonly prefs: PrefsStore
  /** Batch payload archive. */
  readonly archive: BatchArchive
  /** Warning sink. */
  readonly logger: Logger
  /** Host trust list for non-loopback deployments. */
  readonly trustedHosts: () => readonly string[] | undefined
  /** Host LLM runtime, read dynamically because it is optional. */
  readonly llm: () => { runtime: LlmRuntime } | undefined
  /** Host default selection for sessions without one. */
  readonly defaultSelection: () => SelectionView | undefined
  /** Recorded selection of one bound Session. */
  readonly sessionSelection: (sessionId: string) => SelectionView | undefined
  /** Provider catalog for the settings selector. */
  readonly catalog: (signal: AbortSignal) => Promise<ProviderGroupView[]>
  /** Session-log hook for the batch pointer. */
  readonly recordPointer: (sessionId: string, record: TranslateBatchRecord) => Promise<boolean>
}

/**
 * Build the route handler registered on `ctx.webServer`.
 * @param deps - resolved Host dependencies.
 * @returns the request handler.
 */
export function createRequestHandler(
  deps: HttpDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const segments = matchSegments(url.pathname, deps.prefix)
      if (segments === undefined) throw new TranslateError(404, 'NOT_FOUND', 'unknown route')
      const method = request.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD' && !isTrustedRequest(request, deps.trustedHosts())) {
        throw new TranslateError(403, 'UNTRUSTED_REQUEST', 'this request did not come from the DSH page')
      }
      await dispatch(deps, request, response, method, segments)
    } catch (error) {
      const failure = asTranslateError(error)
      if (failure.status >= 500) deps.logger.warn(`immersive-translate: ${failure.code}: ${failure.message}`)
      sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } })
    }
  }
}

async function dispatch(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  segments: readonly string[],
): Promise<void> {
  const [first, second] = segments
  if (first !== 'api') throw new TranslateError(404, 'NOT_FOUND', 'unknown route')

  if (second === 'state' && segments.length === 2) {
    requireMethod(method, ['GET', 'HEAD'])
    const abort = new AbortController()
    request.on('close', () => { abort.abort() })
    let catalog: ProviderGroupView[] = []
    try {
      catalog = await deps.catalog(abort.signal)
    } catch {
      catalog = []
    }
    sendJson(response, 200, stateBody(deps, catalog) satisfies EngineState)
    return
  }

  if (second === 'prefs' && segments.length === 2) {
    requireMethod(method, ['POST'])
    const body = await readJsonBody(request)
    const accepted = deps.prefs.update(prefsPatch(body))
    sendJson(response, 200, { prefs: accepted satisfies TranslatePrefs })
    return
  }

  if (second === 'translate' && segments.length === 2) {
    requireMethod(method, ['POST'])
    const body = await readJsonBody(request)
    await translate(deps, request, response, body)
    return
  }

  throw new TranslateError(404, 'NOT_FOUND', 'unknown route')
}

function stateBody(deps: HttpDeps, catalog: readonly ProviderGroupView[]): EngineState {
  const prefs = deps.prefs.read()
  return {
    prefs,
    catalog,
    resolution: resolveSelection(
      prefs.followDefaultModel ? undefined : explicitRoute(prefs),
      undefined,
      deps.defaultSelection(),
    ),
    limits: {
      maxItemsPerBatch: deps.limits.maxItemsPerBatch,
      maxCharsPerItem: deps.limits.maxCharsPerItem,
    },
  }
}

function explicitRoute(prefs: TranslatePrefs): SelectionView | undefined {
  if (prefs.provider === undefined || prefs.model === undefined) return undefined
  return { provider: prefs.provider, model: prefs.model }
}

async function translate(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const items = readItems(body.items, deps.limits)
  const prefs = deps.prefs.read()
  const targetLanguage = typeof body.targetLanguage === 'string' && body.targetLanguage.trim() !== ''
    ? body.targetLanguage.trim()
    : prefs.targetLanguage
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const resolution = resolveSelection(
    prefs.followDefaultModel ? undefined : explicitRoute(prefs),
    sessionId === undefined ? undefined : deps.sessionSelection(sessionId),
    deps.defaultSelection(),
  )
  if (resolution.selection === null || resolution.source === null) {
    throw new TranslateError(409, 'NO_MODEL', 'no model is selected for translation')
  }
  const engine = deps.llm()
  if (engine === undefined) {
    throw new TranslateError(503, 'ENGINE_UNAVAILABLE', 'the Host LLM service is not mounted')
  }
  const abort = new AbortController()
  request.on('close', () => { abort.abort() })
  const answer = await translateBatch(
    engine.runtime,
    resolution.selection,
    targetLanguage,
    items,
    deps.limits,
    abort.signal,
  )
  const results = answer.items
  const key = batchKey(targetLanguage, resolution.selection.provider, resolution.selection.model, items)
  const archived = deps.archive.write(key, {
    targetLanguage,
    provider: resolution.selection.provider,
    model: resolution.selection.model,
    items,
    results,
  })
  if (sessionId !== undefined && archived) {
    await deps.recordPointer(sessionId, {
      targetLanguage,
      provider: resolution.selection.provider,
      model: resolution.selection.model,
      recipe: RECIPE,
      storeKey: key,
      itemCount: items.length,
    })
  }
  sendJson(response, 200, {
    results,
    selection: resolution.selection,
    source: resolution.source,
    reasoned: answer.reasoned,
  })
}

/** Semantic identity of the prompt and controls; bump on any prompt change. */
const RECIPE = 'immersive-translate/batch-v1'

function readItems(value: unknown, limits: EngineLimits): TranslateItem[] {
  if (!Array.isArray(value)) throw new TranslateError(400, 'BAD_REQUEST', 'items must be an array')
  if (value.length > limits.maxItemsPerBatch) {
    throw new TranslateError(413, 'BATCH_TOO_LARGE', `at most ${String(limits.maxItemsPerBatch)} items per request`)
  }
  return value.map((row) => {
    if (typeof row !== 'object' || row === null) throw new TranslateError(400, 'BAD_REQUEST', 'item must be an object')
    const record = row as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') {
      throw new TranslateError(400, 'BAD_REQUEST', 'item.id must be a non-empty string')
    }
    if (typeof record.text !== 'string') throw new TranslateError(400, 'BAD_REQUEST', 'item.text must be a string')
    if (record.text.length > limits.maxCharsPerItem) {
      throw new TranslateError(413, 'TEXT_TOO_LONG', `item "${record.id}" exceeds the per-item limit`)
    }
    return { id: record.id, text: record.text }
  })
}

function prefsPatch(body: Record<string, unknown>): Partial<TranslatePrefs> {
  const patch: Record<string, unknown> = {}
  if (typeof body.targetLanguage === 'string') patch.targetLanguage = body.targetLanguage
  if (typeof body.followDefaultModel === 'boolean') patch.followDefaultModel = body.followDefaultModel
  if (typeof body.provider === 'string') patch.provider = body.provider
  if (typeof body.model === 'string') patch.model = body.model
  return patch as Partial<TranslatePrefs>
}

function requireMethod(method: string, allowed: readonly string[]): void {
  if (!allowed.includes(method)) throw new TranslateError(405, 'METHOD_NOT_ALLOWED', `${method} is not allowed here`)
}

/**
 * Split a pathname into the segments below one prefix.
 * @param pathname - request path.
 * @param prefix - absolute prefix without a trailing slash.
 * @returns the remaining segments, or undefined when the prefix does not match.
 */
export function matchSegments(pathname: string, prefix: string): string[] | undefined {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return undefined
  return pathname.slice(prefix.length).split('/').filter(segment => segment !== '')
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new TranslateError(413, 'BODY_TOO_LARGE', 'request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TranslateError(400, 'BAD_REQUEST', 'body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof TranslateError) throw error
    throw new TranslateError(400, 'INVALID_JSON', 'body is not valid JSON')
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Apply the Host trust rules to one mutating request.
 * @param request - incoming request.
 * @param trustedHosts - extra authorities the deployment declared.
 * @returns whether the request may mutate plugin state.
 */
export function isTrustedRequest(request: IncomingMessage, trustedHosts: readonly string[] | undefined): boolean {
  const host = request.headers.host
  if (host !== undefined && !isLoopbackAuthority(host) && !isTrustedAuthority(host, trustedHosts ?? [])) {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // A missing Origin did not come from a page (the Desktop proxy strips it).
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function isLoopbackAuthority(authority: string): boolean {
  const name = authority.toLowerCase().replace(/:\d+$/u, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
}

function isTrustedAuthority(authority: string, trusted: readonly string[]): boolean {
  return trusted.some(entry => entry.toLowerCase() === authority.toLowerCase())
}
