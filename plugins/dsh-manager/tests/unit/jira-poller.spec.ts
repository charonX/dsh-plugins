/** The Jira poller's search mapping and rate-limit handling. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, describe, expect, test } from 'vitest'
import { pollJiraIssues } from '../../src/sources/jira-poller.ts'

const servers: Server[] = []
let lastRequest: IncomingMessage | undefined
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
})

const ISSUES = {
  issues: [
    { key: 'PROJ-1', fields: { summary: 'Fix the login flow', updated: '2026-01-01T00:00:00.000+0000' } },
    { key: 'PROJ-2', fields: { summary: 'Ship the report', updated: '2026-01-02T03:04:05.000+0000' } },
  ],
}

/** One fake Jira answering the search endpoint with the scripted response. */
async function fakeJiraSearch(status: number, body: unknown, headers: Record<string, string> = {}): Promise<string> {
  const server = createServer((request: IncomingMessage, response) => {
    lastRequest = request
    response.writeHead(status, { 'content-type': 'application/json', ...headers })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${address.port}`
}

describe('pollJiraIssues', () => {
  test('a search response maps onto delivery-agnostic incoming changes', async () => {
    const baseUrl = await fakeJiraSearch(200, ISSUES)
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'pat-value' }, 'assignee = currentUser()')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues).toHaveLength(2)
    const first = result.issues[0]
    expect(first).toMatchObject({
      connector: 'jira',
      externalKey: 'PROJ-1',
      fingerprint: '2026-01-01T00:00:00.000+0000',
      title: 'Fix the login flow',
      url: `${baseUrl}/browse/PROJ-1`,
    })
    expect(first?.payload).toEqual({ kind: 'jira', key: 'PROJ-1' })
    expect(first?.occurredAt).toBe(Date.parse('2026-01-01T00:00:00.000+0000'))
    expect(lastRequest?.url).toContain('/rest/api/2/search')
    expect(lastRequest?.url).toContain('jql=')
    expect(lastRequest?.headers.authorization).toBe('Bearer pat-value')
  })

  test('a resolved or closed issue maps its status and resolution into the payload', async () => {
    const baseUrl = await fakeJiraSearch(200, {
      issues: [
        { key: 'PROJ-9', fields: { summary: 'Fix the login flow', updated: '2026-01-08T00:00:00.000+0000', status: { name: 'Resolved' }, resolution: { name: 'Done' } } },
        { key: 'PROJ-10', fields: { summary: 'Ship the report', updated: '2026-01-09T00:00:00.000+0000', status: { name: 'Closed' } } },
      ],
    })
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'pat-value' }, 'jql')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.issues[0]!.payload).toEqual({ kind: 'jira', key: 'PROJ-9', status: 'Resolved', resolution: 'Done' })
    expect(result.issues[1]!.payload).toEqual({ kind: 'jira', key: 'PROJ-10', status: 'Closed' })
  })

  test('a 429 with Retry-After surfaces the wait', async () => {
    const baseUrl = await fakeJiraSearch(429, {}, { 'retry-after': '7' })
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'pat-value' }, 'jql')
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited', retryAfterMs: 7000 })
    expect(JSON.stringify(result)).not.toContain('pat-value')
  })

  test('a 429 without Retry-After still surfaces the rate limit', async () => {
    const baseUrl = await fakeJiraSearch(429, {})
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'pat-value' }, 'jql')
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited' })
    expect(result.ok === false && result.retryAfterMs).toBeUndefined()
  })

  test('a 401 maps to invalid-credentials', async () => {
    const baseUrl = await fakeJiraSearch(401, {})
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'stale-pat' }, 'jql')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
  })

  test('a 403 maps to insufficient-permission', async () => {
    const baseUrl = await fakeJiraSearch(403, {})
    const result = await pollJiraIssues(baseUrl, { kind: 'pat', pat: 'limited-pat' }, 'jql')
    expect(result).toMatchObject({ ok: false, reason: 'insufficient-permission' })
  })

  test('a closed port maps to unreachable', async () => {
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    const result = await pollJiraIssues(`http://127.0.0.1:${port}`, { kind: 'pat', pat: 'pat-value' }, 'jql')
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  test('a Basic credential face sends the base64 header', async () => {
    const baseUrl = await fakeJiraSearch(200, ISSUES)
    await pollJiraIssues(baseUrl, { kind: 'basic', username: 'alice', password: 'secret-pass' }, 'jql')
    expect(lastRequest?.headers.authorization).toBe(`Basic ${Buffer.from('alice:secret-pass').toString('base64')}`)
  })
})
