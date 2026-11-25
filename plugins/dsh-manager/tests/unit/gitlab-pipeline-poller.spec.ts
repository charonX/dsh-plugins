/** GitLab pipeline poller spec: failures only, per-project threads, reruns. */
import { describe, expect, test } from 'vitest'
import { pollGitLabPipelines } from '../../src/sources/gitlab-pipeline-poller.ts'
import type { IncomingTrigger } from '../../src/triggers/trigger-core.ts'

const PIPELINES: Record<string, unknown[]> = {
  'group/alpha': [
    { id: 101, ref: 'main', status: 'failed', updated_at: '2026-01-05T00:00:00.000Z', web_url: 'https://gl.example.com/group/alpha/-/pipelines/101' },
    { id: 100, ref: 'main', status: 'failed', updated_at: '2026-01-04T00:00:00.000Z', web_url: 'https://gl.example.com/group/alpha/-/pipelines/100' },
  ],
  'group/beta': [],
}

/** A fake GitLab: per-project failed pipelines; other statuses never appear. */
function fakeGitLab(options: { pipelines?: Record<string, unknown[]>; status?: number } = {}): typeof fetch {
  const pipelines = options.pipelines ?? PIPELINES
  return async (input: Parameters<typeof fetch>[0]) => {
    const parsed = new URL(String(input instanceof Request ? input.url : input))
    const match = parsed.pathname.match(/^\/api\/v4\/projects\/(.+)\/pipelines$/)
    if (match === null) return new Response('not found', { status: 404 })
    const project = decodeURIComponent(match[1]!)
    if (parsed.searchParams.get('status') !== 'failed') {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (options.status !== undefined) {
      return new Response('boom', { status: options.status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(pipelines[project] ?? []), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

async function poll(
  fetchImpl: typeof fetch,
  projects: readonly string[] = ['group/alpha', 'group/beta'],
): Promise<readonly IncomingTrigger[]> {
  const result = await pollGitLabPipelines('https://gl.example.com', { kind: 'pat', pat: 'gl-pat' }, projects, fetchImpl)
  if (!result.ok) throw new Error(`poll failed: ${result.reason}: ${result.detail}`)
  return result.issues
}

describe('pollGitLabPipelines', () => {
  test('only failed pipelines become triggers, keyed to their project thread', async () => {
    const issues = await poll(fakeGitLab())
    expect(issues).toHaveLength(2)
    for (const issue of issues) {
      expect(issue).toMatchObject({
        connector: 'gitlab',
        externalKey: 'group/alpha',
        url: expect.stringContaining('/-/pipelines/'),
      })
      expect(issue.fingerprint).toMatch(/^pipeline-\d+$/)
      expect(issue.payload).toMatchObject({ kind: 'pipeline', project: 'group/alpha', ref: 'main' })
    }
    expect(issues[0]!.url).toBe('https://gl.example.com/group/alpha/-/pipelines/101')
    expect(issues[0]!.occurredAt).toBe(Date.parse('2026-01-05T00:00:00.000Z'))
  })

  test('a re-run (a new pipeline id) maps onto the same project thread with a fresh fingerprint', async () => {
    const before = await poll(fakeGitLab())
    const after = await poll(fakeGitLab({
      pipelines: { 'group/alpha': [{ id: 105, ref: 'main', status: 'failed', updated_at: '2026-01-06T00:00:00.000Z' }] },
    }))
    // Same external key → the ingest joins the rerun into the same Thread.
    expect(after[0]!.externalKey).toBe(before[0]!.externalKey)
    expect(after[0]!.fingerprint).toBe('pipeline-105')
    expect(after[0]!.fingerprint).not.toBe(before[0]!.fingerprint)
  })

  test('a watched project without failures contributes nothing', async () => {
    const issues = await poll(fakeGitLab({ pipelines: {} }), ['group/quiet'])
    expect(issues).toEqual([])
  })

  test('a rejecting instance maps onto the structured failure', async () => {
    const result = await pollGitLabPipelines('https://gl.example.com', { kind: 'pat', pat: 'bad' }, ['group/alpha'], fakeGitLab({ status: 401 }))
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
  })

  test('a basic-auth connection never polls', async () => {
    const result = await pollGitLabPipelines('https://gl.example.com', { kind: 'basic', username: 'u', password: 'p' }, ['group/alpha'])
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
  })

  test('a rate-limited instance reports Retry-After', async () => {
    const rateLimited: typeof fetch = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } })
    const result = await pollGitLabPipelines('https://gl.example.com', { kind: 'pat', pat: 'gl-pat' }, ['group/alpha'], rateLimited)
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited', retryAfterMs: 3000 })
  })
})
