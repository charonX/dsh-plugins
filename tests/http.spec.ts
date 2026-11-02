import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { JobRegistry } from '../src/jobs.ts'
import { createRequestHandler } from '../src/http.ts'
import { StateStore } from '../src/state.ts'
import type { JobView, LibrarySnapshot } from '../src/shared/api.ts'
import { jsonBody, skillFields, tempTree, writeSkill, type TempTree } from './helpers.ts'

const silentLogger = { warn: () => {} }

interface Harness {
  readonly base: string
  readonly tree: TempTree
  readonly state: StateStore
  close(): Promise<void>
}

const open: Harness[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (harness) => await harness.close()))
})

async function startServer(options: { crossSiteTrustedHosts?: string[] } = {}): Promise<Harness> {
  const tree = tempTree()
  const state = new StateStore(tree.path('skills-manager', 'state.json'), silentLogger)
  const handler = createRequestHandler({
    prefix: '/dsh-skills-manager',
    libraryDir: tree.path('skills-manager', 'library'),
    statePath: tree.path('skills-manager', 'state.json'),
    allowFileProtocol: true,
    state,
    jobs: new JobRegistry(),
    logger: silentLogger,
    trustedHosts: () => options.crossSiteTrustedHosts,
    onLibraryChanged: () => {},
  })
  const server: Server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  const harness: Harness = {
    base: `http://127.0.0.1:${String(address.port)}`,
    tree,
    state,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      tree.cleanup()
    },
  }
  open.push(harness)
  return harness
}

async function waitForJob(harness: Harness, jobId: string): Promise<JobView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${harness.base}/dsh-skills-manager/api/jobs/${jobId}`)
    const job = await jsonBody<JobView>(response)
    if (job.status === 'success' || job.status === 'error') return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('job did not settle')
}

describe('skills manager routes', () => {
  it('serves an empty library snapshot and the resolved paths', async () => {
    const harness = await startServer()
    const response = await fetch(`${harness.base}/dsh-skills-manager/api/library`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const snapshot = await jsonBody<LibrarySnapshot>(response)
    expect(snapshot.libraryDir).toBe(harness.tree.path('skills-manager', 'library'))
    expect(snapshot.sources).toEqual([])
  })

  it('installs a local source through a job and lists it', async () => {
    const harness = await startServer()
    writeSkill(harness.tree.path('outside', 'skills', 'alpha'), skillFields('alpha', 'Alpha does A.'))

    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    expect(start.status).toBe(202)
    const { jobId } = await jsonBody<{ jobId: string }>(start)
    expect(jobId).not.toBe('')
    expect((await waitForJob(harness, jobId)).status).toBe('success')

    const snapshot = await jsonBody<LibrarySnapshot>(
      await fetch(`${harness.base}/dsh-skills-manager/api/library`),
    )
    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.sources[0]?.slug).toBe('outside')
    expect(snapshot.sources[0]?.sourceType).toBe('local')
    expect(snapshot.sources[0]?.enabled).toBe(true)
    expect(snapshot.sources[0]?.skills.map((skill) => skill.name)).toEqual(['alpha'])
  })

  it('patches source and skill state, then deletes the source', async () => {
    const harness = await startServer()
    writeSkill(harness.tree.path('outside', 'skills', 'alpha'), skillFields('alpha'))
    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)

    const disableSkill = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside/skills/alpha`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, note: 'not for this repo' }),
    })
    expect(disableSkill.status).toBe(200)

    const disableSource = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, category: 'engineering' }),
    })
    const afterPatch = await jsonBody<LibrarySnapshot>(disableSource)
    expect(afterPatch.sources[0]?.enabled).toBe(false)
    expect(afterPatch.sources[0]?.category).toBe('engineering')
    expect(afterPatch.sources[0]?.skills[0]?.enabled).toBe(false)
    expect(afterPatch.sources[0]?.skills[0]?.note).toBe('not for this repo')

    const removed = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect((await jsonBody<LibrarySnapshot>(removed)).sources).toEqual([])
    expect(existsSync(harness.tree.path('skills-manager', 'library', 'outside'))).toBe(false)
    // The dropped source also loses its state entries.
    expect(harness.state.read().sources).toEqual({})
    expect(harness.state.read().skills).toEqual({})
  })

  it('rejects cross-site writes and accepts same-origin writes', async () => {
    const harness = await startServer()
    writeSkill(harness.tree.path('outside'), skillFields('alpha'))
    const blocked = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    expect(blocked.status).toBe(403)
    expect((await jsonBody<{ error: { code: string } }>(blocked)).error.code).toBe('UNTRUSTED_REQUEST')

    const blockedOrigin = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    expect(blockedOrigin.status).toBe(403)

    const sameOrigin = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.base },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    expect(sameOrigin.status).toBe(202)
  })

  it('reports identity, method, route, and payload failures with codes', async () => {
    const harness = await startServer()
    const badSlug = await fetch(`${harness.base}/dsh-skills-manager/api/sources/..%2Fescape`, { method: 'DELETE' })
    expect(badSlug.status).toBe(400)

    const wrongMethod = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`)
    expect(wrongMethod.status).toBe(405)
    expect((await jsonBody<{ error: { code: string } }>(wrongMethod)).error.code).toBe('METHOD_NOT_ALLOWED')

    const unknown = await fetch(`${harness.base}/dsh-skills-manager/api/nope`)
    expect(unknown.status).toBe(404)

    const badBody = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'npm', identifier: 'x' }),
    })
    expect(badBody.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(badBody)).error.code).toBe('SKILL_SOURCE_INVALID')

    const noIdentifier = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'git' }),
    })
    expect(noIdentifier.status).toBe(400)

    const missingSource = await fetch(`${harness.base}/dsh-skills-manager/api/sources/missing`, { method: 'DELETE' })
    expect(missingSource.status).toBe(404)

    const badJson = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(badJson.status).toBe(400)
  })

  it('surfaces an install failure as the job error', async () => {
    const harness = await startServer()
    mkdirSync(harness.tree.path('empty'), { recursive: true })
    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('empty') }),
    })
    const job = await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)
    expect(job.status).toBe('error')
    expect(job.error?.code).toBe('SKILL_SOURCE_INVALID')
  })

  it('rejects an identifier that is not a git transport', async () => {
    const harness = await startServer()
    const response = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'git', identifier: 'ext::sh -c rm -rf /' }),
    })
    expect(response.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe('SKILL_SOURCE_INVALID')
  })
})
