/**
 * Browser client of the immersive-translate HTTP API.
 *
 * @module dsh-immersive-translate/client/api
 */

import type {
  ApiErrorBody,
  AuditListResponse,
  CacheListResponse,
  EngineState,
  TranslatePrefs,
  TranslateRequestBody,
  TranslateResponseBody,
} from '../shared/api.ts'
import { ROUTE_PREFIX } from '../shared/api.ts'

/** Failure reported by the Host, carrying the machine-readable code. */
export class ApiFailure extends Error {
  /**
   * @param status - HTTP status.
   * @param code - machine-readable failure code.
   * @param message - operator-facing message.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/**
 * Resolve a route against the page the UI is served from.
 * @param path - route without the plugin prefix.
 * @returns the document-relative pathname.
 */
export function apiPath(path: string): string {
  const relative = `${ROUTE_PREFIX.replace(/^\/+/u, '')}${path}`
  if (typeof document === 'undefined') return `/${relative}`
  return new URL(relative, document.baseURI).pathname
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const text = await response.text()
  const body: unknown = text === '' ? undefined : safeJson(text)
  if (!response.ok) {
    const failure = body as ApiErrorBody | undefined
    throw new ApiFailure(
      response.status,
      failure?.error?.code ?? 'REQUEST_FAILED',
      failure?.error?.message ?? `Request failed with status ${String(response.status)}`,
    )
  }
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Read preferences, the provider catalog, and the effective selection.
 * @param signal - caller cancellation.
 * @returns the engine state.
 */
export function readState(signal?: AbortSignal): Promise<EngineState> {
  return request<EngineState>('/api/state', { signal })
}

/**
 * Persist one preference patch.
 * @param patch - fields to replace.
 * @returns the accepted preferences.
 */
export async function savePrefs(patch: Partial<TranslatePrefs>): Promise<TranslatePrefs> {
  const answer = await request<{ prefs: TranslatePrefs }>('/api/prefs', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
  return answer.prefs
}

/**
 * Translate one batch.
 * @param body - text units, destination language, and optional Session id.
 * @param signal - caller cancellation.
 * @returns translated units with the route that produced them.
 */
export function translate(body: TranslateRequestBody, signal?: AbortSignal): Promise<TranslateResponseBody> {
  return request<TranslateResponseBody>('/api/translate', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Read request audit records and aggregated metrics.
 */
export function readAudit(options?: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<AuditListResponse> {
  const params = new URLSearchParams()
  if (options?.limit !== undefined) params.set('limit', String(options.limit))
  if (options?.offset !== undefined) params.set('offset', String(options.offset))
  const qs = params.toString()
  return request<AuditListResponse>(`/api/audit${qs !== '' ? `?${qs}` : ''}`, { signal })
}

/**
 * Clear all recorded audit records.
 */
export async function clearAudit(signal?: AbortSignal): Promise<void> {
  await request<{ cleared: boolean }>('/api/audit', { method: 'DELETE', signal })
}

/**
 * Read cached item translations and statistics.
 */
export function readCache(filter?: {
  targetLanguage?: string
  search?: string
  limit?: number
  offset?: number
}, signal?: AbortSignal): Promise<CacheListResponse> {
  const params = new URLSearchParams()
  if (filter?.targetLanguage) params.set('targetLanguage', filter.targetLanguage)
  if (filter?.search) params.set('search', filter.search)
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  if (filter?.offset !== undefined) params.set('offset', String(filter.offset))
  const qs = params.toString()
  return request<CacheListResponse>(`/api/cache${qs !== '' ? `?${qs}` : ''}`, { signal })
}

/**
 * Delete a single cached translation by key.
 */
export async function deleteCacheItem(key: string, signal?: AbortSignal): Promise<boolean> {
  const answer = await request<{ deleted: boolean }>('/api/cache/delete', {
    method: 'POST',
    body: JSON.stringify({ key }),
    signal,
  })
  return answer.deleted
}

/**
 * Clear all cache entries, optionally constrained to one target language.
 */
export async function clearCache(targetLanguage?: string, signal?: AbortSignal): Promise<number> {
  const answer = await request<{ clearedCount: number }>('/api/cache/clear', {
    method: 'POST',
    body: JSON.stringify({ targetLanguage }),
    signal,
  })
  return answer.clearedCount
}
