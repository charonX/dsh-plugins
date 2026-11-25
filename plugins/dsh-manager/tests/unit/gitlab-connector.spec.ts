/** The GitLab Connector's connectivity mapping and glab invocation contract. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, describe, expect, test } from 'vitest'
import { createGitLabConnector, glabEnvironment, testGitLabConnection } from '../../src/connections/gitlab-connector.ts'

const servers: Server[] = []
const requests: { url: string | undefined; headers: Record<string, string | string[] | undefined> }[] = []
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
})

/** One fake GitLab answering `/api/v4/user` with the scripted status. */
async function fakeGitLab(status: number): Promise<string> {
  const server = createServer((request: IncomingMessage, response) => {
    requests.push({ url: request.url, headers: request.headers })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ username: 'gitlab-user' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${address.port}`
}

describe('testGitLabConnection', () => {
  test('a 200 user answers success', async () => {
    const baseUrl = await fakeGitLab(200)
    const result = await testGitLabConnection(baseUrl, 'pat-value')
    expect(result).toEqual({ ok: true })
    expect(requests.at(-1)?.url).toBe('/api/v4/user')
    expect(requests.at(-1)?.headers['private-token']).toBe('pat-value')
  })

  test('a 401 maps to invalid-credentials without echoing the PAT', async () => {
    const baseUrl = await fakeGitLab(401)
    const result = await testGitLabConnection(baseUrl, 'stale-pat')
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
    expect(JSON.stringify(result)).not.toContain('stale-pat')
  })

  test('a 403 maps to insufficient-permission without echoing the PAT', async () => {
    const baseUrl = await fakeGitLab(403)
    const result = await testGitLabConnection(baseUrl, 'limited-pat')
    expect(result).toMatchObject({ ok: false, reason: 'insufficient-permission' })
    expect(JSON.stringify(result)).not.toContain('limited-pat')
  })

  test('a closed port maps to unreachable', async () => {
    const server = createServer()
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    const result = await testGitLabConnection(`http://127.0.0.1:${port}`, 'pat-value')
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  test('an unexpected status maps to unreachable', async () => {
    const baseUrl = await fakeGitLab(500)
    const result = await testGitLabConnection(baseUrl, 'pat-value')
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', detail: expect.stringContaining('500') })
  })
})

describe('glabEnvironment', () => {
  test('binds the connection host and token over the ambient env', () => {
    const env = glabEnvironment('https://gitlab.example.com/some/path', 'secret-pat')
    expect(env['GITLAB_HOST']).toBe('gitlab.example.com')
    expect(env['GITLAB_TOKEN']).toBe('secret-pat')
    // Ambient variables survive so glab can still reach its own configuration.
    expect(env['PATH']).toBe(process.env['PATH'])
  })
})

describe('createGitLabConnector', () => {
  test('a missing glab short-circuits with the platform install command', async () => {
    const connector = createGitLabConnector(() => ({ installed: false }), 'linux')
    const result = await connector.test('server-dc', 'https://gitlab.example.com', { kind: 'pat', pat: 'pat-value' })
    expect(result).toMatchObject({
      ok: false,
      reason: 'dependency-missing',
      installCommand: 'brew install glab  # or see https://gitlab.com/gitlab-org/cli#installation for your distro',
    })
    expect(JSON.stringify(result)).not.toContain('pat-value')
  })

  test('an installed glab falls through to the connectivity test', async () => {
    const baseUrl = await fakeGitLab(200)
    const connector = createGitLabConnector(() => ({ installed: true }))
    expect(await connector.test('server-dc', baseUrl, { kind: 'pat', pat: 'pat-value' })).toEqual({ ok: true })
  })

  test('a Basic credential face is rejected with an actionable detail', async () => {
    const connector = createGitLabConnector(() => ({ installed: true }))
    const result = await connector.test('server-dc', 'https://gitlab.example.com', {
      kind: 'basic', username: 'alice', password: 'secret-pass',
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials' })
    expect(JSON.stringify(result)).not.toContain('secret-pass')
  })

  test('a cloud deployment reports a deliberate not-supported', async () => {
    const connector = createGitLabConnector(() => ({ installed: true }))
    const result = await connector.test('cloud', 'https://gitlab.com', { kind: 'pat', pat: 'pat-value' })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', detail: expect.stringContaining('not supported yet') })
  })

  test('hasDependency exposes the detection face without a connectivity probe', () => {
    const connector = createGitLabConnector(() => ({ installed: false }))
    expect(connector.hasDependency()).toEqual({ installed: false })
  })
})
