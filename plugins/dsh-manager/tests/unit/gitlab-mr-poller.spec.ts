/** GitLab MR poller spec: scope merge, comment mapping, self-produced drop. */
import { describe, expect, test } from 'vitest'
import { pollGitLabMrs } from '../../src/sources/gitlab-mr-poller.ts'
import type { IncomingTrigger } from '../../src/triggers/trigger-core.ts'

const MR_1 = {
  iid: 12,
  project_id: 7,
  title: 'Fix the login flow',
  state: 'opened',
  updated_at: '2026-01-01T00:00:00.000Z',
  web_url: 'https://gl.example.com/group/alpha/-/merge_requests/12',
  references: { full: 'group/alpha!12' },
}
const MR_2 = {
  iid: 30,
  project_id: 9,
  title: 'Ship the report',
  state: 'opened',
  updated_at: '2026-01-02T00:00:00.000Z',
  web_url: 'https://gl.example.com/group/beta/-/merge_requests/30',
  references: { full: 'group/beta!30' },
}
const NOTES_EMPTY = {
  12: [] as unknown[],
  30: [
    { id: 3, body: 'looks good, one nit', created_at: '2026-01-03T00:00:00.000Z', author: { username: 'reviewer-1' } },
    { id: 4, body: 'self note', created_at: '2026-01-03T01:00:00.000Z', author: { username: 'me' } },
  ],
}

const MR_MERGED = {
  iid: 12,
  project_id: 7,
  title: 'Fix the login flow',
  state: 'merged',
  updated_at: '2026-01-05T00:00:00.000Z',
  web_url: 'https://gl.example.com/group/alpha/-/merge_requests/12',
  references: { full: 'group/alpha!12' },
}
const MR_CLOSED = {
  iid: 44,
  project_id: 9,
  title: 'Ship the report',
  state: 'closed',
  updated_at: '2026-01-06T00:00:00.000Z',
  web_url: 'https://gl.example.com/group/beta/-/merge_requests/44',
  references: { full: 'group/beta!44' },
}

/** A fake GitLab: three scopes with overlapping MRs, per-state sweeps, per-MR notes. */
function fakeGitLab(options: {
  assigned: readonly unknown[]
  review: readonly unknown[]
  created: readonly unknown[]
  merged?: readonly unknown[]
  closed?: readonly unknown[]
  notes: Record<number, readonly unknown[]>
  status?: number
} = { assigned: [MR_1], review: [MR_2], created: [MR_1], notes: NOTES_EMPTY }): typeof fetch {
  return async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input)
    const parsed = new URL(url)
    const json = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: options.status ?? 200, headers: { 'content-type': 'application/json' },
    })
    if (parsed.pathname === '/api/v4/user') return json({ id: 1, username: 'me' })
    if (parsed.pathname === '/api/v4/merge_requests') {
      const state = parsed.searchParams.get('state')
      if (state === 'merged') return json(options.merged ?? [])
      if (state === 'closed') return json(options.closed ?? [])
      const scope = parsed.searchParams.get('scope')
      const list = scope === 'assigned_to_me' ? options.assigned : scope === 'review_requested' ? options.review : options.created
      return json(list)
    }
    const notes = parsed.pathname.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)\/notes$/)
    if (notes !== null) {
      const body = options.notes[Number(notes[2])] ?? []
      return json(body)
    }
    return new Response('not found', { status: 404 })
  }
}

async function poll(fetchImpl: typeof fetch): Promise<readonly IncomingTrigger[]> {
  const result = await pollGitLabMrs('https://gl.example.com', { kind: 'pat', pat: 'gl-pat' }, fetchImpl)
  if (!result.ok) throw new Error(`poll failed: ${result.reason}: ${result.detail}`)
  return result.issues
}

describe('pollGitLabMrs', () => {
  test('merges the three scopes into unique MR triggers', async () => {
    const issues = await poll(fakeGitLab())
    const mrs = issues.filter(issue => (issue.payload as { kind: string }).kind === 'mr')
    expect(mrs.map(issue => issue.externalKey).sort()).toEqual(['group/alpha!12', 'group/beta!30'])
    const first = mrs[0]!
    expect(first.connector).toBe('gitlab')
    expect(first.fingerprint).toBe('2026-01-01T00:00:00.000Z')
    expect(first.url).toBe('https://gl.example.com/group/alpha/-/merge_requests/12')
    expect(first.occurredAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
  })

  test('maps the newest non-self notes as comment triggers on the MR thread', async () => {
    const issues = await poll(fakeGitLab())
    const comments = issues.filter(issue => (issue.payload as { kind: string }).kind === 'comment')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      externalKey: 'group/beta!30',
      fingerprint: 'note-3',
      url: 'https://gl.example.com/group/beta/-/merge_requests/30#note_3',
    })
    expect(comments[0]!.payload).toMatchObject({ author: 'reviewer-1', body: 'looks good, one nit' })
    expect(comments[0]!.occurredAt).toBe(Date.parse('2026-01-03T00:00:00.000Z'))
  })

  test('a comment the credential itself authored is dropped', async () => {
    // The only note is the user's own — a change Dsh Manager produced.
    const issues = await poll(fakeGitLab({
      assigned: [MR_1], review: [], created: [],
      notes: { 12: [{ id: 9, body: 'my own comment', created_at: '2026-01-04T00:00:00.000Z', author: { username: 'me' } }] },
    }))
    expect(issues).toHaveLength(1)
    expect(issues[0]!.fingerprint).toBe('2026-01-01T00:00:00.000Z')
  })

  test('an MR without the full reference falls back to the project-iid key', async () => {
    const bare = { ...MR_1, references: undefined, web_url: undefined }
    const issues = await poll(fakeGitLab({ assigned: [bare], review: [], created: [], notes: { 12: [] } }))
    const mr = issues.find(issue => (issue.payload as { kind: string }).kind === 'mr')!
    expect(mr.externalKey).toBe('7!12')
    expect(mr.url).toBe('https://gl.example.com/projects/7/merge_requests/12')
  })

  test('a merged or closed MR produces an ended-state trigger on its thread, without sweeping notes', async () => {
    const issues = await poll(fakeGitLab({
      assigned: [], review: [], created: [],
      merged: [MR_MERGED], closed: [MR_CLOSED],
      notes: { 12: [{ id: 7, body: 'late comment', created_at: '2026-01-07T00:00:00.000Z', author: { username: 'reviewer-1' } }] },
    }))
    const ended = issues.filter(issue => (issue.payload as { kind: string }).kind === 'mr'
      && (issue.payload as { state: string }).state !== 'opened')
    expect(ended).toHaveLength(2)
    expect(ended[0]).toMatchObject({
      connector: 'gitlab',
      externalKey: 'group/alpha!12',
      fingerprint: '2026-01-05T00:00:00.000Z',
      url: 'https://gl.example.com/group/alpha/-/merge_requests/12',
    })
    expect(ended[0]!.payload).toMatchObject({ kind: 'mr', state: 'merged', projectId: 7, iid: 12 })
    expect(ended[1]!.payload).toMatchObject({ kind: 'mr', state: 'closed' })
    // A merged MR's notes are not swept: the thread is closing.
    expect(issues.filter(issue => (issue.payload as { kind: string }).kind === 'comment')).toHaveLength(0)
  })

  test('a rejecting instance maps onto the structured failure', async () => {
    const result = await pollGitLabMrs('https://gl.example.com', { kind: 'pat', pat: 'bad' }, fakeGitLab({ status: 401, assigned: [], review: [], created: [], notes: {} }))
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
  })

  test('a basic-auth connection never polls', async () => {
    const result = await pollGitLabMrs('https://gl.example.com', { kind: 'basic', username: 'u', password: 'p' }, fakeGitLab())
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
  })

  test('a rate-limited instance reports Retry-After', async () => {
    const rateLimited: typeof fetch = async () => new Response('slow down', {
      status: 429, headers: { 'retry-after': '7' },
    })
    const result = await pollGitLabMrs('https://gl.example.com', { kind: 'pat', pat: 'gl-pat' }, rateLimited)
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited', retryAfterMs: 7000 })
  })
})
