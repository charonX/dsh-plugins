/**
 * The Jira poller: one REST search of the watched JQL, mapped onto
 * delivery-agnostic incoming changes. Rate limiting is surfaced as a
 * structured outcome so the scheduler can honor `Retry-After`.
 */
import type { ConnectionAuth } from '../connections/wire-types.ts'
import type { IncomingTrigger } from '../triggers/trigger-core.ts'

/** The outcome of one poll. */
export type PollResult =
  | { readonly ok: true; readonly issues: readonly IncomingTrigger[] }
  | {
    readonly ok: false
    readonly reason: 'unreachable' | 'invalid-credentials' | 'rate-limited' | 'insufficient-permission'
    readonly detail: string
    /** Millis the caller should wait before retrying (from `Retry-After`). */
    readonly retryAfterMs?: number
  }

/** The fields one search hit contributes to a trigger. */
interface JiraIssue {
  readonly key: string
  readonly fields: {
    readonly summary?: unknown
    readonly updated?: unknown
    readonly status?: { readonly name?: unknown }
    readonly resolution?: { readonly name?: unknown } | null
  }
}

/**
 * Poll one Jira instance for the issues matching the JQL.
 * @param baseUrl - instance base URL.
 * @param auth - the connection's credential face.
 * @param jql - the watch query.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 * @returns the mapped incoming changes, or a structured failure.
 */
export async function pollJiraIssues(
  baseUrl: string,
  auth: ConnectionAuth,
  jql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  const authorization = auth.kind === 'pat' ? `Bearer ${auth.pat}` : `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  const search = new URL('/rest/api/2/search', baseUrl)
  search.searchParams.set('jql', jql)
  search.searchParams.set('maxResults', '50')
  search.searchParams.set('fields', 'summary,updated')
  let response: Response
  try {
    response = await fetchImpl(search.toString(), {
      headers: { authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    return {
      ok: false,
      reason: 'rate-limited',
      detail: 'the instance asked to slow down (HTTP 429)',
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    }
  }
  if (response.status === 401) {
    return { ok: false, reason: 'invalid-credentials', detail: 'the instance rejected the credential (HTTP 401)' }
  }
  if (response.status === 403) {
    return { ok: false, reason: 'insufficient-permission', detail: 'the credential is valid but lacks permission (HTTP 403)' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'unreachable', detail: `unexpected HTTP status ${response.status}` }
  }
  const body = (await response.json()) as { readonly issues?: readonly JiraIssue[] }
  const issues = (body.issues ?? []).map((issue): IncomingTrigger => {
    const updated = typeof issue.fields.updated === 'string' ? issue.fields.updated : undefined
    const occurredAt = updated === undefined ? undefined : Date.parse(updated)
    // The mapped payload carries the resolution facts the suggest-end
    // decision reads; the raw search hit's shape stays the server's.
    const status = typeof issue.fields.status?.name === 'string' ? issue.fields.status.name : undefined
    const resolution = typeof issue.fields.resolution?.name === 'string' ? issue.fields.resolution.name : undefined
    return {
      sourceId: '',
      connectionId: '',
      connector: 'jira',
      externalKey: issue.key,
      fingerprint: updated ?? `key:${issue.key}`,
      title: typeof issue.fields.summary === 'string' ? issue.fields.summary : issue.key,
      payload: {
        kind: 'jira',
        key: issue.key,
        ...(status === undefined ? {} : { status }),
        ...(resolution === undefined ? {} : { resolution }),
      },
      url: new URL(`/browse/${issue.key}`, baseUrl).toString(),
      ...(occurredAt !== undefined && Number.isFinite(occurredAt) ? { occurredAt } : {}),
    }
  })
  return { ok: true, issues }
}
