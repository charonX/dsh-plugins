/**
 * The GitLab pipeline poller: one REST v4 sweep of the watched projects'
 * failed pipelines. Only failures produce triggers — a green pipeline is
 * noise for the board. The pipeline id is the change fingerprint, so a
 * repeated poll never duplicates a trigger and a re-run (a new pipeline id)
 * produces a fresh one; every pipeline of a project joins that project's
 * Thread.
 */
import type { ConnectionAuth } from '../connections/wire-types.ts'
import type { IncomingTrigger } from '../triggers/trigger-core.ts'
import type { PollResult } from './jira-poller.ts'

export type { PollResult } from './jira-poller.ts'

/** The pipeline fields the poller maps. */
interface GitLabPipeline {
  readonly id?: unknown
  readonly iid?: unknown
  readonly ref?: unknown
  readonly status?: unknown
  readonly updated_at?: unknown
  readonly web_url?: unknown
}

/**
 * Poll one GitLab instance for the failed pipelines of the watched projects.
 * @param baseUrl - instance base URL, e.g. `https://gitlab.example.com`.
 * @param auth - the connection's credential face; GitLab authenticates with a PAT.
 * @param projects - the watched project paths, e.g. `group/alpha`.
 * @param fetchImpl - injectable fetch for tests; defaults to the global.
 * @returns the mapped incoming changes (failed pipelines only), or a structured failure.
 */
export async function pollGitLabPipelines(
  baseUrl: string,
  auth: ConnectionAuth,
  projects: readonly string[],
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

  try {
    const changes: IncomingTrigger[] = []
    for (const project of projects) {
      const encoded = encodeURIComponent(project).replace(/%2F/gi, '/')
      const list = await getJson(`/api/v4/projects/${encoded}/pipelines?status=failed&per_page=20`)
      if (list.status !== 200) return mapFailure(list.status, list.retryAfterMs)
      for (const pipeline of (Array.isArray(list.body) ? list.body : []) as readonly GitLabPipeline[]) {
        const id = typeof pipeline.id === 'number' ? pipeline.id : undefined
        if (id === undefined) continue
        const ref = typeof pipeline.ref === 'string' ? pipeline.ref : undefined
        const updated = typeof pipeline.updated_at === 'string' ? pipeline.updated_at : undefined
        const occurredAt = updated === undefined ? undefined : Date.parse(updated)
        const url = typeof pipeline.web_url === 'string' && pipeline.web_url !== ''
          ? pipeline.web_url
          : new URL(`/${project}/-/pipelines/${id}`, baseUrl).toString()
        changes.push({
          sourceId: '',
          connectionId: '',
          connector: 'gitlab',
          externalKey: project,
          fingerprint: `pipeline-${id}`,
          title: `Pipeline failed: ${project}${ref === undefined ? '' : ` (${ref})`} #${id}`,
          payload: {
            kind: 'pipeline',
            project,
            pipelineId: id,
            ...(ref === undefined ? {} : { ref }),
          },
          url,
          ...(occurredAt !== undefined && Number.isFinite(occurredAt) ? { occurredAt } : {}),
        })
      }
    }
    return { ok: true, issues: changes }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ok: false, reason: 'unreachable', detail }
  }
}

/** One HTTP status mapped onto the structured failure. */
function mapFailure(status: number, retryAfterMs?: number): PollResult {
  if (status === 401) return { ok: false, reason: 'invalid-credentials', detail: 'the instance rejected the credential (HTTP 401)' }
  if (status === 403) return { ok: false, reason: 'insufficient-permission', detail: 'the credential is valid but lacks permission (HTTP 403)' }
  if (status === 429) return { ok: false, reason: 'rate-limited', detail: 'the instance asked to slow down (HTTP 429)', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  return { ok: false, reason: 'unreachable', detail: `unexpected HTTP status ${status}` }
}
