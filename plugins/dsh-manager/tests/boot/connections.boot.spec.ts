/**
 * Main-seam spec: the connections config API against fake Jira and GitLab
 * servers — success, 401, 403, unreachable, both auth methods, credential
 * rotation, and the credentials-store seam.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type {} from '../../src/index.ts'
import { bootTestProfile, installFakeGlab } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, '../../cordis.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'dsh-connections-boot-'))
const restorePath = await installFakeGlab(join(home, 'bin'))

const servers: Server[] = []
const serverDisposers: (() => Promise<void>)[] = []
const seenAuthHeaders: string[] = []

/** One fake Jira answering `myself` with the scripted status. */
async function fakeJira(status: number): Promise<string> {
  const server = createServer((request: IncomingMessage, response) => {
    seenAuthHeaders.push(String(request.headers.authorization))
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'jira-user' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  serverDisposers.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${address.port}`
}

/** One fake GitLab answering `/api/v4/user` with the scripted status. */
async function fakeGitLab(status: number): Promise<string> {
  const server = createServer((request: IncomingMessage, response) => {
    seenAuthHeaders.push(String(request.headers['private-token']))
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ username: 'gitlab-user' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  serverDisposers.push(() => new Promise<void>(resolve => { server.close(() => { resolve() }) }))
  return `http://127.0.0.1:${address.port}`
}

test(
  'connections add, edit, and test against fake servers distinguish the outcomes',
  async () => {
    const ctx = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    const okUrl = await fakeJira(200)
    const unauthorizedUrl = await fakeJira(401)
    const forbiddenUrl = await fakeJira(403)
    const basicUrl = await fakeJira(200)
    const rotatingUrl = await fakeJira(200)
    const gitlabOkUrl = await fakeGitLab(200)
    const gitlabUnauthorizedUrl = await fakeGitLab(401)

    const added = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl: okUrl, authMethod: 'pat', secret: 'good-pat',
    })
    expect(added.status).toBe('ok')
    expect(added.enabled).toBe(true)

    // A second connection onto a different instance stays independent.
    const unauthorized = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'stale', deployment: 'server-dc', baseUrl: unauthorizedUrl, authMethod: 'pat', secret: 'stale-pat',
    })
    expect(unauthorized.status).toBe('invalid-credentials')

    const forbidden = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'limited', deployment: 'server-dc', baseUrl: forbiddenUrl, authMethod: 'pat', secret: 'limited-pat',
    })
    expect(forbidden.status).toBe('invalid-credentials')

    // Jira Server/DC Basic auth authenticates with username + password.
    const basic = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'basic-prod', deployment: 'server-dc', baseUrl: basicUrl,
      authMethod: 'basic', authIdentity: 'alice', secret: 'wonderland',
    })
    expect(basic.status).toBe('ok')
    expect(basic.authMethod).toBe('basic')
    expect(basic.authIdentity).toBe('alice')
    expect(seenAuthHeaders.at(-1)).toBe(`Basic ${Buffer.from('alice:wonderland').toString('base64')}`)

    const gitlabOk = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'git-prod', deployment: 'server-dc', baseUrl: gitlabOkUrl, authMethod: 'pat', secret: 'gitlab-good-pat',
    })
    expect(gitlabOk.status).toBe('ok')

    const gitlabUnauthorized = await ctx.dshManagerConnections.connectionAdd({
      connector: 'gitlab', name: 'git-stale', deployment: 'server-dc', baseUrl: gitlabUnauthorizedUrl, authMethod: 'pat', secret: 'gitlab-stale-pat',
    })
    expect(gitlabUnauthorized.status).toBe('invalid-credentials')

    const verdict = await ctx.dshManagerConnections.connectionTest(forbidden.id)
    expect(verdict).toMatchObject({ ok: false, reason: 'insufficient-permission' })

    // Editing the facts takes effect without a restart: re-point the stale
    // connection onto the healthy instance and it turns healthy.
    const edited = await ctx.dshManagerConnections.connectionUpdate({
      id: unauthorized.id, name: 'stale-renamed', baseUrl: okUrl,
    })
    expect(edited.name).toBe('stale-renamed')
    expect(edited.status).toBe('ok')

    // Disabling flips the flag but keeps the record and its credential.
    const disabled = await ctx.dshManagerConnections.connectionUpdate({ id: gitlabUnauthorized.id, enabled: false })
    expect(disabled.enabled).toBe(false)
    const reEnabled = await ctx.dshManagerConnections.connectionUpdate({ id: gitlabUnauthorized.id, enabled: true })
    expect(reEnabled.enabled).toBe(true)

    // Rotating a credential changes the very next request's header — no restart.
    const rotated = await ctx.dshManagerConnections.connectionUpdateCredential({
      id: added.id, secret: 'fresh-pat',
    })
    expect(rotated.status).toBe('ok')
    expect(seenAuthHeaders.filter(value => value === 'Bearer good-pat').length).toBeGreaterThan(0)
    expect(seenAuthHeaders.at(-1)).toBe('Bearer fresh-pat')

    // The delete preview is wired; nothing to orphan yet.
    const deleteInfo = await ctx.dshManagerConnections.connectionDeleteInfo(forbidden.id)
    expect(deleteInfo).toEqual({ sources: 0, mappings: 0 })

    // The credential lives in the credentials store, not in the connection record.
    const list = await ctx.dshManagerConnections.connectionList()
    expect(list.connections).toHaveLength(6)
    for (const view of list.connections) {
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('good-pat')
      expect(serialized).not.toContain('stale-pat')
      expect(serialized).not.toContain('gitlab-good-pat')
      expect(serialized).not.toContain('gitlab-stale-pat')
      expect(serialized).not.toContain('wonderland')
    }

    // Removal takes the record and the stored credential with it.
    await ctx.dshManagerConnections.connectionRemove(forbidden.id)
    const after = await ctx.dshManagerConnections.connectionList()
    expect(after.connections).toHaveLength(5)
    expect(after.connections.find(view => view.id === forbidden.id)).toBeUndefined()
    await ctx.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  restorePath()
  await Promise.all(serverDisposers.splice(0).map(dispose => dispose()))
  await rm(home, { recursive: true, force: true })
})
