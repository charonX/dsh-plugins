/** The Jira Connector's connectivity mapping against a scripted fake Jira. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { jiraConnector, testJiraConnection, type ConnectivityResult } from '../../src/connections/jira-connector.ts'

const servers: Server[] = []
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
})

/** One fake Jira answering `myself` with the scripted status. */
async function fakeJira(status: number, body: unknown = {}): Promise<string> {
  const server = createServer((_request, response) => {
    lastRequest = _request
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${address.port}`
}

let lastRequest: IncomingMessage | undefined

/** The Authorization header the most recent request carried. */
function lastAuthHeader(): string | undefined {
  return lastRequest?.headers.authorization
}

describe('testJiraConnection', () => {
  afterEach(() => {
    // No failure detail may ever carry the token.
    for (const server of servers) void server
  })

  test('a 200 myself answers success', async () => {
    const baseUrl = await fakeJira(200, { name: 'jira-user' })
    const result = await testJiraConnection(baseUrl, { kind: 'pat', pat: 'pat-value' })
    expect(result).toEqual({ ok: true })
  })

  test('a 401 maps to invalid-credentials', async () => {
    const baseUrl = await fakeJira(401)
    const result: ConnectivityResult = await testJiraConnection(baseUrl, { kind: 'pat', pat: 'stale-pat' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
    expect(JSON.stringify(result)).not.toContain('stale-pat')
  })

  test('a 403 maps to insufficient-permission', async () => {
    const baseUrl = await fakeJira(403)
    const result: ConnectivityResult = await testJiraConnection(baseUrl, { kind: 'pat', pat: 'limited-pat' })
    expect(result).toMatchObject({ ok: false, reason: 'insufficient-permission' })
    expect(JSON.stringify(result)).not.toContain('limited-pat')
  })

  test('a closed port maps to unreachable', async () => {
    // Take a port and immediately free it: nothing listens there.
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    const result: ConnectivityResult = await testJiraConnection(`http://127.0.0.1:${port}`, { kind: 'pat', pat: 'pat-value' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  test('an unexpected status maps to unreachable with the status in detail', async () => {
    const baseUrl = await fakeJira(502)
    const result: ConnectivityResult = await testJiraConnection(baseUrl, { kind: 'pat', pat: 'pat-value' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(result.ok === false && result.detail).toContain('502')
  })

  test('a Cloud deployment reports a deliberate not-supported for a PAT', async () => {
    const result = await jiraConnector.test('cloud', 'https://example.atlassian.net', { kind: 'pat', pat: 'pat-value' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(result.ok === false && result.detail).toContain('email + API token')
  })
})

describe('jiraConnector auth methods', () => {
  test('Server/DC with a PAT sends a Bearer header', async () => {
    const baseUrl = await fakeJira(200, { name: 'jira-user' })
    const result = await jiraConnector.test('server-dc', baseUrl, { kind: 'pat', pat: 'pat-value' })
    expect(result).toEqual({ ok: true })
    expect(lastAuthHeader()).toBe('Bearer pat-value')
  })

  test('Server/DC with Basic sends the base64 user:password header', async () => {
    const baseUrl = await fakeJira(200, { name: 'jira-user' })
    const result = await jiraConnector.test('server-dc', baseUrl, {
      kind: 'basic', username: 'alice', password: 'wonderland',
    })
    expect(result).toEqual({ ok: true })
    expect(lastAuthHeader()).toBe(`Basic ${Buffer.from('alice:wonderland').toString('base64')}`)
  })

  test('Jira Cloud authenticates with email + API token (Basic)', async () => {
    const baseUrl = await fakeJira(200, { name: 'cloud-user' })
    const result = await jiraConnector.test('cloud', baseUrl, {
      kind: 'basic', username: 'alice@example.com', password: 'api-token-value',
    })
    expect(result).toEqual({ ok: true })
    expect(lastAuthHeader()).toBe(`Basic ${Buffer.from('alice@example.com:api-token-value').toString('base64')}`)
  })

  test('a failed Basic attempt maps to invalid-credentials without echoing the secret', async () => {
    const baseUrl = await fakeJira(401)
    const result = await jiraConnector.test('server-dc', baseUrl, {
      kind: 'basic', username: 'alice', password: 'wrong-secret',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
    expect(JSON.stringify(result)).not.toContain('wrong-secret')
  })
})
