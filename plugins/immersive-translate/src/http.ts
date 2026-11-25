/**
 * HTTP surface: one `prefix` route on the Host web server answering the Web
 * Client's JSON requests. Mutating requests are checked against the Host trust
 * rules, because a translation request spends model quota on the user's behalf.
 *
 * @module dsh-immersive-translate/http
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { asTranslateError, TranslateError } from './errors.js'
import { translateBatch, type EngineLimits } from './engine.js'
import { resolveSelection } from './models.js'
import { PrefsStore, type Logger } from './prefs.js'
import { appendBatchPointer, batchKey, isValidTranslation, type BatchArchive, type ItemArchive, type TranslateBatchRecord } from './records.js'
import { promptRecipeId } from './shared/prompt.js'
import type { AuditStore } from './audit.js'
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
  /** Sentence-level item archive. */
  readonly itemArchive: ItemArchive
  /** Audit store recording request cache hits, latencies, and model calls. */
  readonly auditStore: AuditStore
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

  if (second === 'audit') {
    if (segments.length === 2 && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
      sendJson(response, 200, deps.auditStore.list(Number.isNaN(limit) ? 50 : limit, Number.isNaN(offset) ? 0 : offset))
      return
    }
    if ((segments.length === 2 && method === 'DELETE') || (segments.length === 3 && segments[2] === 'clear' && method === 'POST')) {
      deps.auditStore.clear()
      sendJson(response, 200, { cleared: true })
      return
    }
  }

  if (second === 'cache') {
    if (segments.length === 2 && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const targetLanguage = url.searchParams.get('targetLanguage') ?? undefined
      const search = url.searchParams.get('search') ?? undefined
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
      const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
      const list = deps.itemArchive.list({
        targetLanguage,
        search,
        limit: Number.isNaN(limit) ? 50 : limit,
        offset: Number.isNaN(offset) ? 0 : offset,
      })
      const stats = deps.itemArchive.stats()
      sendJson(response, 200, { items: list.items, total: list.total, stats })
      return
    }
    if (segments.length === 3 && segments[2] === 'delete' && method === 'POST') {
      const body = await readJsonBody(request)
      const key = typeof body.key === 'string' ? body.key : ''
      const deleted = key !== '' ? deps.itemArchive.delete(key) : false
      sendJson(response, 200, { deleted })
      return
    }
    if (segments.length === 3 && segments[2] === 'clear' && method === 'POST') {
      const body = await readJsonBody(request)
      const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage : undefined
      const clearedCount = deps.itemArchive.clear(targetLanguage)
      sendJson(response, 200, { clearedCount })
      return
    }
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
  const recipe = promptRecipeId(prefs.customPrompt)
  const key = batchKey({
    recipe,
    targetLanguage,
    provider: resolution.selection.provider,
    model: resolution.selection.model,
    items,
  })

  // 1. Check exact whole-batch replay
  const replay = deps.archive.read(key)
  if (replay !== undefined && replay.cacheable === true) {
    // Only accept replay if all translatable items in the batch are valid translations
    const replayValid = items.every((item) => {
      const match = replay.results.find(r => r.id === item.id)
      return match !== undefined && isValidTranslation(targetLanguage, item.text, match.text)
    })
    if (replayValid) {
      deps.logger.info?.(`[immersive-translate] batch ${items.length} items (100% batch-cache hit) in 0ms`)
      deps.auditStore.addRecord({
        id: randomUUID(),
        timestamp: Date.now(),
        targetLanguage,
        provider: resolution.selection.provider,
        model: resolution.selection.model,
        totalItems: items.length,
        cachedItems: items.length,
        modelItems: 0,
        status: 'full_cache',
        durationMs: 0,
        aiDurationMs: 0,
        attempts: 0,
        reasoned: replay.reasoned,
        items: items.map(item => ({
          id: item.id,
          source: item.text,
          translation: replay.results.find(r => r.id === item.id)?.text ?? '',
          fromCache: true,
        })),
      })
      if (sessionId !== undefined) {
        await deps.recordPointer(sessionId, {
          targetLanguage,
          provider: resolution.selection.provider,
          model: resolution.selection.model,
          recipe,
          storeKey: key,
          itemCount: items.length,
          reasoned: replay.reasoned,
          attempts: 0,
          durationMs: 0,
          cached: true,
        })
      }
      sendJson(response, 200, {
        results: replay.results,
        selection: resolution.selection,
        source: resolution.source,
        reasoned: replay.reasoned,
      })
      return
    }
  }

  // 2. Check sentence-level item archive
  const cachedMap = new Map<string, string>()
  const uncachedItems: TranslateItem[] = []
  for (const item of items) {
    const cachedText = deps.itemArchive.get(targetLanguage, item.text)
    if (cachedText !== undefined && isValidTranslation(targetLanguage, item.text, cachedText)) {
      cachedMap.set(item.id, cachedText)
    } else {
      uncachedItems.push(item)
    }
  }

  // If every item was found in itemArchive, return immediately without calling LLM
  if (uncachedItems.length === 0) {
    const results: TranslateItem[] = items.map(item => ({
      id: item.id,
      text: cachedMap.get(item.id) ?? item.text,
    }))
    deps.logger.info?.(`[immersive-translate] batch ${items.length} items (100% item-cache hit) in 0ms`)
    deps.auditStore.addRecord({
      id: randomUUID(),
      timestamp: Date.now(),
      targetLanguage,
      provider: resolution.selection.provider,
      model: resolution.selection.model,
      totalItems: items.length,
      cachedItems: items.length,
      modelItems: 0,
      status: 'full_cache',
      durationMs: 0,
      aiDurationMs: 0,
      attempts: 0,
      reasoned: false,
      items: items.map(item => ({
        id: item.id,
        source: item.text,
        translation: cachedMap.get(item.id) ?? item.text,
        fromCache: true,
      })),
    })
    deps.archive.write(key, {
      targetLanguage,
      provider: resolution.selection.provider,
      model: resolution.selection.model,
      items,
      results,
      reasoned: false,
      attempts: 0,
      durationMs: 0,
      cacheable: true,
    })
    if (sessionId !== undefined) {
      await deps.recordPointer(sessionId, {
        targetLanguage,
        provider: resolution.selection.provider,
        model: resolution.selection.model,
        recipe,
        storeKey: key,
        itemCount: items.length,
        reasoned: false,
        attempts: 0,
        durationMs: 0,
        cached: true,
      })
    }
    sendJson(response, 200, {
      results,
      selection: resolution.selection,
      source: resolution.source,
      reasoned: false,
    })
    return
  }

  // 3. Only a cache miss needs the LLM engine
  const engine = deps.llm()
  if (engine === undefined) {
    throw new TranslateError(503, 'ENGINE_UNAVAILABLE', 'the Host LLM service is not mounted')
  }
  const abort = new AbortController()
  request.on('close', () => { abort.abort() })
  const batchStarted = performance.now()
  let answer: Awaited<ReturnType<typeof translateBatch>>
  try {
    answer = await translateBatch(
      engine.runtime,
      resolution.selection,
      targetLanguage,
      uncachedItems,
      deps.limits,
      abort.signal,
      prefs.customPrompt,
    )
  } catch (err) {
    const errorMs = Math.round(performance.now() - batchStarted)
    deps.auditStore.addRecord({
      id: randomUUID(),
      timestamp: Date.now(),
      targetLanguage,
      provider: resolution.selection.provider,
      model: resolution.selection.model,
      totalItems: items.length,
      cachedItems: cachedMap.size,
      modelItems: uncachedItems.length,
      status: 'error',
      durationMs: errorMs,
      aiDurationMs: errorMs,
      attempts: 1,
      reasoned: false,
      error: err instanceof Error ? err.message : String(err),
      items: items.map(item => ({
        id: item.id,
        source: item.text,
        translation: cachedMap.get(item.id) ?? '',
        fromCache: cachedMap.has(item.id),
      })),
    })
    throw err
  }
  const totalBatchMs = Math.round(performance.now() - batchStarted)

  // Save newly translated items into itemArchive (only if valid translation)
  const newEntries: { text: string; translation: string }[] = []
  const answerMap = new Map(answer.items.map(r => [r.id, r.text]))
  for (const uncached of uncachedItems) {
    const trans = answerMap.get(uncached.id)
    if (trans !== undefined && isValidTranslation(targetLanguage, uncached.text, trans)) {
      newEntries.push({ text: uncached.text, translation: trans })
    }
  }
  deps.itemArchive.setMany(targetLanguage, newEntries)

  // Combine cached results and new results in request order
  const results: TranslateItem[] = items.map(item => {
    if (cachedMap.has(item.id)) {
      return { id: item.id, text: cachedMap.get(item.id)! }
    }
    return { id: item.id, text: answerMap.get(item.id) ?? item.text }
  })

  deps.logger.info?.(
    `[immersive-translate] batch ${items.length} items (${cachedMap.size} cached, ${uncachedItems.length} sent to ${resolution.selection.model}) in ${totalBatchMs}ms (AI: ${answer.durationMs}ms, attempts: ${answer.attempts})`
  )

  deps.auditStore.addRecord({
    id: randomUUID(),
    timestamp: Date.now(),
    targetLanguage,
    provider: resolution.selection.provider,
    model: resolution.selection.model,
    totalItems: items.length,
    cachedItems: cachedMap.size,
    modelItems: uncachedItems.length,
    status: cachedMap.size > 0 ? 'partial_cache' : 'model_only',
    durationMs: totalBatchMs,
    aiDurationMs: answer.durationMs,
    attempts: answer.attempts,
    reasoned: answer.reasoned,
    items: items.map(item => ({
      id: item.id,
      source: item.text,
      translation: cachedMap.get(item.id) ?? answerMap.get(item.id) ?? item.text,
      fromCache: cachedMap.has(item.id),
    })),
  })

  // Only mark the entire batch cacheable if all items were successfully translated
  const allResultsValid = items.every((item) => {
    const res = results.find(r => r.id === item.id)?.text
    return res !== undefined && isValidTranslation(targetLanguage, item.text, res)
  })
  const isBatchCacheable = answer.cacheable && allResultsValid

  const archived = deps.archive.write(key, {
    targetLanguage,
    provider: resolution.selection.provider,
    model: resolution.selection.model,
    items,
    results,
    reasoned: answer.reasoned,
    attempts: answer.attempts,
    durationMs: totalBatchMs,
    cacheable: isBatchCacheable,
  })
  if (sessionId !== undefined && archived) {
    await deps.recordPointer(sessionId, {
      targetLanguage,
      provider: resolution.selection.provider,
      model: resolution.selection.model,
      recipe,
      storeKey: key,
      itemCount: items.length,
      reasoned: answer.reasoned,
      attempts: answer.attempts,
      durationMs: totalBatchMs,
      cached: false,
    })
  }
  sendJson(response, 200, {
    results,
    selection: resolution.selection,
    source: resolution.source,
    reasoned: answer.reasoned,
  })
}

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
  if (typeof body.submitKey === 'string') patch.submitKey = body.submitKey
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
