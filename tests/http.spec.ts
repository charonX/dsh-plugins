import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequestHandler } from '../src/http.ts'
import { JobRegistry } from '../src/jobs.ts'
import { LinkManager } from '../src/links.ts'
import type { AgentTargetView, JobView, LibrarySnapshot, LinkReport, ProjectLinkView, UpdateCheck } from '../src/shared/api.ts'
import { StateStore } from '../src/state.ts'
import { UpdateStore } from '../src/updates.ts'
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
  const links = new LinkManager({
    libraryDir: tree.path('skills-manager', 'library'),
    recordPath: tree.path('skills-manager', 'links.json'),
    logger: silentLogger,
    readState: () => state.read(),
  })
  const updates = new UpdateStore(tree.path('skills-manager', 'updates.json'), silentLogger)
  const handler = createRequestHandler({
    prefix: '/dsh-skills-manager',
    libraryDir: tree.path('skills-manager', 'library'),
    statePath: tree.path('skills-manager', 'state.json'),
    allowFileProtocol: true,
    state,
    jobs: new JobRegistry(),
    links,
    updates,
    listWorkspaces: () => [{ path: tree.path('project'), title: 'Project' }],
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

describe('workspace options over HTTP', () => {
  it('serves the DSH workspaces as link targets', async () => {
    const harness = await startServer()
    const response = await fetch(`${harness.base}/dsh-skills-manager/api/projects`)
    expect(response.status).toBe(200)
    const body = await jsonBody<{ projects: readonly { path: string; title: string }[] }>(response)
    expect(body.projects).toEqual([{ path: harness.tree.path('project'), title: 'Project' }])
  })
})

describe('project links over HTTP', () => {
  async function seedSource(harness: Harness): Promise<void> {
    writeSkill(harness.tree.path('outside', 'skills', 'alpha'), skillFields('alpha'))
    writeSkill(harness.tree.path('outside', 'skills', 'beta'), skillFields('beta'))
    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)
  }

  it('exposes the agent registry with DSH first', async () => {
    const harness = await startServer()
    const response = await fetch(`${harness.base}/dsh-skills-manager/api/agents`)
    const body = await jsonBody<{ agents: readonly AgentTargetView[] }>(response)
    expect(body.agents[0]).toMatchObject({ name: 'dsh', skillsDir: '.dsh/skills' })
    expect(body.agents.some((agent) => agent.name === 'claude-code' && agent.skillsDir === '.claude/skills')).toBe(true)
  })

  it('links, lists, cascades on disable, and deletes links with the source', async () => {
    const harness = await startServer()
    await seedSource(harness)
    mkdirSync(harness.tree.path('project'), { recursive: true })

    const linked = await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: harness.tree.path('project'), source: 'outside', agents: ['dsh'] }),
    })
    expect(linked.status).toBe(200)
    const report = await jsonBody<LinkReport>(linked)
    expect(report.counts.linked).toBe(2)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(true)

    const listed = await jsonBody<{ projects: readonly ProjectLinkView[] }>(
      await fetch(`${harness.base}/dsh-skills-manager/api/links`),
    )
    expect(listed.projects.map((project) => project.project)).toEqual([harness.tree.path('project')])

    const disabled = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside/skills/alpha`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(false)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'beta'))).toBe(true)

    const removed = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'beta'))).toBe(false)
    const after = await jsonBody<{ projects: readonly ProjectLinkView[] }>(
      await fetch(`${harness.base}/dsh-skills-manager/api/links`),
    )
    expect(after.projects).toEqual([])
  })

  it('resyncs a project and rejects unknown agents or relative projects', async () => {
    const harness = await startServer()
    await seedSource(harness)
    mkdirSync(harness.tree.path('project'), { recursive: true })
    await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: harness.tree.path('project'), source: 'outside', agents: ['dsh'] }),
    })
    rmSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))

    const resynced = await fetch(`${harness.base}/dsh-skills-manager/api/links/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: harness.tree.path('project') }),
    })
    expect(resynced.status).toBe(200)
    expect((await jsonBody<LinkReport>(resynced)).counts.linked).toBe(2)

    const unknownAgent = await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: harness.tree.path('project'), source: 'outside', agents: ['nope'] }),
    })
    expect(unknownAgent.status).toBe(400)

    const relative = await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'relative', source: 'outside' }),
    })
    expect(relative.status).toBe(400)
  })
})

describe('update checks over HTTP', () => {
  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  }

  it('checks a git source and exposes the recorded result on the snapshot', async () => {
    const harness = await startServer()
    const remote = harness.tree.path('remote')
    mkdirSync(remote, { recursive: true })
    git(remote, ['init', '-b', 'main'])
    writeSkill(`${remote}/skills/alpha`, skillFields('alpha'))
    git(remote, ['add', '.'])
    git(remote, ['commit', '-m', 'first'])
    git(remote, ['tag', 'v1.0.0'])

    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'git', identifier: `file://${remote}` }),
    })
    const job = await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)
    expect(job.status).toBe('success')

    const checked = await fetch(`${harness.base}/dsh-skills-manager/api/sources/remote/check`, { method: 'POST' })
    expect(checked.status).toBe(200)
    const { check } = await jsonBody<{ check: UpdateCheck }>(checked)
    expect(check.behind).toBe(0)
    expect(check.remoteVersion).toContain('v1.0.0')

    const snapshot = await jsonBody<LibrarySnapshot>(
      await fetch(`${harness.base}/dsh-skills-manager/api/library`),
    )
    expect(snapshot.sources[0]?.update?.behind).toBe(0)
  })

  it('rejects a check for a local source', async () => {
    const harness = await startServer()
    writeSkill(harness.tree.path('local'), skillFields('local'))
    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('local') }),
    })
    await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)
    const checked = await fetch(`${harness.base}/dsh-skills-manager/api/sources/local/check`, { method: 'POST' })
    expect(checked.status).toBe(400)
    expect((await jsonBody<{ error: { code: string } }>(checked)).error.code).toBe('SKILL_UPDATE_UNSUPPORTED')
  })
})

describe('per-project switches over HTTP', () => {
  async function seed(harness: Harness): Promise<void> {
    writeSkill(harness.tree.path('outside', 'skills', 'alpha'), skillFields('alpha'))
    writeSkill(harness.tree.path('outside', 'skills', 'beta'), skillFields('beta'))
    const start = await fetch(`${harness.base}/dsh-skills-manager/api/sources/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'local', identifier: harness.tree.path('outside') }),
    })
    await waitForJob(harness, (await jsonBody<{ jobId: string }>(start)).jobId)
    mkdirSync(harness.tree.path('project'), { recursive: true })
    await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: harness.tree.path('project'), source: 'outside', agents: ['dsh'] }),
    })
  }

  it('turns one entry off and on without losing the record', async () => {
    const harness = await startServer()
    await seed(harness)
    const off = await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: harness.tree.path('project'),
        source: 'outside',
        skillName: 'alpha',
        enabled: false,
      }),
    })
    expect(off.status).toBe(200)
    const disabled = await jsonBody<LinkReport>(off)
    expect(disabled.project.entries).toContainEqual({ source: 'outside', skillName: 'alpha', enabled: false })
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(false)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'beta'))).toBe(true)

    const on = await fetch(`${harness.base}/dsh-skills-manager/api/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: harness.tree.path('project'),
        source: 'outside',
        skillName: 'alpha',
        enabled: true,
      }),
    })
    expect((await jsonBody<LinkReport>(on)).project.entries.every((entry) => entry.enabled)).toBe(true)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(true)
  })

  it('keeps project records for a global disable and restores them on re-enable', async () => {
    const harness = await startServer()
    await seed(harness)
    const off = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(false)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'beta'))).toBe(false)
    const kept = await jsonBody<{ projects: readonly ProjectLinkView[] }>(
      await fetch(`${harness.base}/dsh-skills-manager/api/links`),
    )
    expect(kept.projects[0]?.entries).toHaveLength(2)

    const on = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(on.status).toBe(200)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'alpha'))).toBe(true)
    expect(existsSync(harness.tree.path('project', '.dsh', 'skills', 'beta'))).toBe(true)

    const removed = await fetch(`${harness.base}/dsh-skills-manager/api/sources/outside`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    const after = await jsonBody<{ projects: readonly ProjectLinkView[] }>(
      await fetch(`${harness.base}/dsh-skills-manager/api/links`),
    )
    expect(after.projects).toEqual([])
  })
})
