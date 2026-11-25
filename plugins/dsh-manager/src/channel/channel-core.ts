/**
 * The Channel's write side (spec stories 38–44): the external writes an
 * approved action replays — a GitLab MR comment, a Jira status transition.
 * Pure HTTP functions over the connection's credential face; fetch is
 * injectable so tests record against fake servers.
 */
import type { ConnectionAuth } from '../connections/wire-types.ts'

/** The settled fact of one write attempt. */
export type WriteResult =
  | { readonly ok: true; readonly id?: string }
  | { readonly ok: false; readonly reason: 'invalid-credentials' | 'unreachable' | 'rejected'; readonly detail: string }

/** The arguments of one approved MR comment. */
export interface GitLabCommentPayload {
  readonly projectId: number
  readonly iid: number
  readonly body: string
}

/** The arguments of one approved Jira status transition. */
export interface JiraTransitionPayload {
  readonly issueKey: string
  readonly transitionId: string
}

/**
 * Post one MR comment through GitLab REST v4.
 * @param baseUrl - instance base URL, e.g. `https://gitlab.example.com`.
 * @param auth - the connection's credential face; GitLab authenticates with a PAT.
 * @param payload - the approved comment, replayed verbatim.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 */
export async function postGitLabComment(
  baseUrl: string,
  auth: ConnectionAuth,
  payload: GitLabCommentPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteResult> {
  if (auth.kind !== 'pat') {
    return { ok: false, reason: 'invalid-credentials', detail: 'GitLab connections authenticate with a personal access token' }
  }
  try {
    const response = await fetchImpl(new URL(`/api/v4/projects/${payload.projectId}/merge_requests/${payload.iid}/notes`, baseUrl).toString(), {
      method: 'POST',
      headers: { 'private-token': auth.pat, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ body: payload.body }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid-credentials', detail: `the instance rejected the credential (HTTP ${response.status})` }
    }
    if (!response.ok) {
      return { ok: false, reason: 'unreachable', detail: `the write failed with HTTP ${response.status}` }
    }
    const body = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined
    return { ok: true, ...(typeof body?.id === 'number' ? { id: String(body.id) } : {}) }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
}

/**
 * Apply one status transition through Jira REST v2.
 * @param baseUrl - instance base URL, e.g. `https://jira.example.com`.
 * @param auth - the connection's credential face; Jira authenticates with basic auth.
 * @param payload - the approved transition, replayed verbatim.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 */
export async function setJiraStatus(
  baseUrl: string,
  auth: ConnectionAuth,
  payload: JiraTransitionPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<WriteResult> {
  if (auth.kind !== 'basic') {
    return { ok: false, reason: 'invalid-credentials', detail: 'Jira connections authenticate with username and password' }
  }
  try {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
    const response = await fetchImpl(new URL(`/rest/api/2/issue/${encodeURIComponent(payload.issueKey)}/transitions`, baseUrl).toString(), {
      method: 'POST',
      headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ transition: { id: payload.transitionId } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid-credentials', detail: `the instance rejected the credential (HTTP ${response.status})` }
    }
    if (!response.ok) {
      return { ok: false, reason: 'unreachable', detail: `the write failed with HTTP ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
}
