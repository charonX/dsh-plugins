/**
 * The GitLab MR poller: one REST v4 sweep of the merge requests assigned to
 * the credential's user, requesting their review, or created by them, plus
 * the newest notes of each MR. Every note authored by the credential's own
 * user is dropped — a change Dsh Manager itself produced (for example a
 * comment it posted on the user's behalf) must not re-enter the pipeline.
 */
import type { ConnectionAuth } from '../connections/wire-types.ts'
import type { IncomingTrigger } from '../triggers/trigger-core.ts'
import type { PollResult } from './jira-poller.ts'

export type { PollResult } from './jira-poller.ts'

/** The user identity one `/user` probe returns. */
interface GitLabUser {
  readonly id?: unknown
  readonly username?: unknown
}

/** The MR fields the poller maps. */
interface GitLabMr {
  readonly iid?: unknown
  readonly project_id?: unknown
  readonly title?: unknown
  readonly state?: unknown
  readonly updated_at?: unknown
  readonly web_url?: unknown
  readonly references?: { readonly full?: unknown }
}

/** The note fields the poller maps. */
interface GitLabNote {
  readonly id?: unknown
  readonly body?: unknown
  readonly created_at?: unknown
  readonly author?: { readonly username?: unknown }
}

/** The watch defaults: my open MRs from every angle, changes and comments. */
const SCOPES = ['assigned_to_me', 'review_requested', 'created_by_me'] as const

/** The ended MR states whose triggers say the work is over (spec story 66). */
const ENDED_STATES = ['merged', 'closed'] as const

/**
 * Poll one GitLab instance for MRs and their new comments.
 * @param baseUrl - instance base URL, e.g. `https://gitlab.example.com`.
 * @param auth - the connection's credential face; GitLab authenticates with a PAT.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 * @returns the mapped incoming changes (MRs and comments), or a structured failure.
 */
export async function pollGitLabMrs(
  baseUrl: string,
  auth: ConnectionAuth,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  if (auth.kind !== 'pat') {
    return { ok: false, reason: 'invalid-credentials', detail: 'GitLab connections authenticate with a personal access token' }
  }
  const headers = { 'private-token': auth.pat, accept: 'application/json' }
  const getJson = async (path: string): Promise<{ status: number; retryAfterMs?: number; body?: unknown }> => {
    const response = await fetchImpl(new URL(path, baseUrl).toString(), {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      return {
        status: 429,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      }
    }
    if (!response.ok) return { status: response.status }
    return { status: response.status, body: await response.json() }
  }

  let me: GitLabUser
  try {
    const probe = await getJson('/api/v4/user')
    if (probe.status === 401 || probe.status === 403 || probe.body === undefined) {
      return mapFailure(probe.status, probe.retryAfterMs)
    }
    me = (probe.body ?? {}) as GitLabUser
    const changes: IncomingTrigger[] = []
    const seen = new Set<string>()
    for (const scope of SCOPES) {
      const list = await getJson(`/api/v4/merge_requests?scope=${scope}&state=opened&per_page=50`)
      if (list.status !== 200) return mapFailure(list.status, list.retryAfterMs)
      for (const mr of (Array.isArray(list.body) ? list.body : []) as readonly GitLabMr[]) {
        const iid = typeof mr.iid === 'number' ? mr.iid : undefined
        const projectId = typeof mr.project_id === 'number' ? mr.project_id : undefined
        if (iid === undefined || projectId === undefined) continue
        const key = `${projectId}!${iid}`
        if (seen.has(key)) continue
        seen.add(key)
        changes.push(mrTrigger(baseUrl, mr, projectId, iid))
        changes.push(...await noteTriggers(baseUrl, mr, projectId, iid, me, getJson))
      }
    }
    // Ended MRs (merged, closed) produce the evidence a "suggest end" rides
    // on. Their notes are not swept — the thread is closing, and the
    // updated_at fingerprint only lands once per state change.
    for (const state of ENDED_STATES) {
      for (const scope of SCOPES) {
        const list = await getJson(`/api/v4/merge_requests?scope=${scope}&state=${state}&per_page=50`)
        if (list.status !== 200) return mapFailure(list.status, list.retryAfterMs)
        for (const mr of (Array.isArray(list.body) ? list.body : []) as readonly GitLabMr[]) {
          const iid = typeof mr.iid === 'number' ? mr.iid : undefined
          const projectId = typeof mr.project_id === 'number' ? mr.project_id : undefined
          if (iid === undefined || projectId === undefined) continue
          const key = `${projectId}!${iid}`
          if (seen.has(key)) continue
          seen.add(key)
          changes.push(mrTrigger(baseUrl, mr, projectId, iid))
        }
      }
    }
    return { ok: true, issues: changes }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
}

/** Map one MR onto an incoming change; the MR's own update is one fingerprint. */
function mrTrigger(baseUrl: string, mr: GitLabMr, projectId: number, iid: number): IncomingTrigger {
  const externalKey = typeof mr.references?.full === 'string' && mr.references.full !== ''
    ? mr.references.full
    : `${projectId}!${iid}`
  const updated = typeof mr.updated_at === 'string' ? mr.updated_at : undefined
  const occurredAt = updated === undefined ? undefined : Date.parse(updated)
  const url = typeof mr.web_url === 'string' && mr.web_url !== '' ? mr.web_url : new URL(`/projects/${projectId}/merge_requests/${iid}`, baseUrl).toString()
  return {
    sourceId: '',
    connectionId: '',
    connector: 'gitlab',
    externalKey,
    fingerprint: updated ?? `mr:${projectId}!${iid}`,
    title: typeof mr.title === 'string' ? mr.title : externalKey,
    payload: { kind: 'mr', projectId, iid, ...(typeof mr.state === 'string' ? { state: mr.state } : {}) },
    url,
    ...(occurredAt !== undefined && Number.isFinite(occurredAt) ? { occurredAt } : {}),
  }
}

/** Map every non-self note of one MR onto incoming comment changes. */
async function noteTriggers(
  baseUrl: string,
  mr: GitLabMr,
  projectId: number,
  iid: number,
  me: GitLabUser,
  getJson: (path: string) => Promise<{ status: number; retryAfterMs?: number; body?: unknown }>,
): Promise<readonly IncomingTrigger[]> {
  const list = await getJson(`/api/v4/projects/${projectId}/merge_requests/${iid}/notes?sort=desc&order_by=created_at&per_page=20`)
  if (list.status !== 200) return []
  const externalKey = typeof mr.references?.full === 'string' && mr.references.full !== ''
    ? mr.references.full
    : `${projectId}!${iid}`
  const mrUrl = typeof mr.web_url === 'string' && mr.web_url !== '' ? mr.web_url : new URL(`/projects/${projectId}/merge_requests/${iid}`, baseUrl).toString()
  const triggers: IncomingTrigger[] = []
  for (const note of (Array.isArray(list.body) ? list.body : []) as readonly GitLabNote[]) {
    const noteId = typeof note.id === 'number' ? note.id : undefined
    if (noteId === undefined) continue
    const author = typeof note.author?.username === 'string' ? note.author.username : undefined
    // The credential's own user produced this change (a comment Dsh Manager
    // posted on their behalf); it must never re-enter the pipeline.
    if (author === me.username) continue
    const createdAt = typeof note.created_at === 'string' ? note.created_at : undefined
    const occurredAt = createdAt === undefined ? undefined : Date.parse(createdAt)
    triggers.push({
      sourceId: '',
      connectionId: '',
      connector: 'gitlab',
      externalKey,
      fingerprint: `note-${noteId}`,
      title: typeof mr.title === 'string' ? mr.title : externalKey,
      payload: { kind: 'comment', projectId, iid, noteId, ...(author === undefined ? {} : { author }), ...(typeof note.body === 'string' ? { body: note.body } : {}) },
      url: `${mrUrl}#note_${noteId}`,
      ...(occurredAt !== undefined && Number.isFinite(occurredAt) ? { occurredAt } : {}),
    })
  }
  return triggers
}

/** One HTTP status mapped onto the structured failure. */
function mapFailure(status: number, retryAfterMs?: number): PollResult {
  if (status === 401) return { ok: false, reason: 'invalid-credentials', detail: 'the instance rejected the credential (HTTP 401)' }
  if (status === 403) return { ok: false, reason: 'insufficient-permission', detail: 'the credential is valid but lacks permission (HTTP 403)' }
  if (status === 429) return { ok: false, reason: 'rate-limited', detail: 'the instance asked to slow down (HTTP 429)', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  return { ok: false, reason: 'unreachable', detail: `unexpected HTTP status ${status}` }
}
