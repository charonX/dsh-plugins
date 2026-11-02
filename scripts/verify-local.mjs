#!/usr/bin/env node
/**
 * End-to-end local verification of the skills manager against a Harness
 * checkout. Boots `dsh web` from source with an isolated overlay, drives the
 * HTTP API, checks the real symlinks, and asserts the browser bundle is served.
 *
 * Usage:
 *   pnpm verify:local                 # build, boot, run, clean up
 *   pnpm verify:local -- --keep       # keep the temporary workspace for inspection
 *   DSH_HARNESS_DIR=/path/to/deepseek-harness pnpm verify:local
 *
 * Requires a built Harness checkout (`pnpm run build` there) and `git`.
 */

import { spawn, execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(process.env.DSH_HARNESS_DIR ?? join(ROOT, '..', 'deepseek-harness'))
const KEEP = process.argv.includes('--keep')
const PREFIX = '/dsh-skills-manager'
const BUILD_TIMEOUT_MS = 15 * 60 * 1000

const checks = []
let temporary

function pass(name, detail = '') {
  checks.push({ name, ok: true })
  console.log(`  ✓ ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false })
  console.error(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function skillMarkdown(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the ${name} steps.\n`
}

function git(cwd, args) {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'verify',
      GIT_AUTHOR_EMAIL: 'verify@example.com',
      GIT_COMMITTER_NAME: 'verify',
      GIT_COMMITTER_EMAIL: 'verify@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

async function api(origin, path, init = {}) {
  const response = await fetch(`${origin}${PREFIX}/api${path}`, {
    ...init,
    headers: {
      origin,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    cache: 'no-store',
  })
  const text = await response.text()
  const body = text === '' ? undefined : JSON.parse(text)
  return { status: response.status, body }
}

async function waitForJob(origin, jobId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await api(origin, `/jobs/${jobId}`)
    assert(job.status === 200, `job polling answered ${job.status}`)
    if (job.body.status === 'success') return job.body
    if (job.body.status === 'error') {
      throw new Error(`job failed: ${job.body.error?.code} ${job.body.error?.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('job did not settle')
}

async function waitForServer(child, log) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/u.exec(log())
    if (match !== null) return { origin: `http://127.0.0.1:${match[1]}`, token: match[2] }
    if (child.exitCode !== null) throw new Error(`dsh exited early (${child.exitCode}):\n${log()}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`dsh web did not print a URL within 90s:\n${log()}`)
}

async function verifyClientBundle(origin, token) {
  const index = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie')
  assert(index.status < 400, `index answered ${index.status}`)
  const cookieHeader = cookie === null || cookie === undefined ? undefined : cookie.split(';')[0]
  const htmlResponse = await fetch(`${origin}/`, { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } })
  const html = await htmlResponse.text()
  assert(html.includes('dsh-skills-manager/client.js'), 'boot graph does not list the client bundle')
  const match = /href="([^"]*dsh-skills-manager\/client\.js[^"]*)"/u.exec(html)
    ?? /src="([^"]*dsh-skills-manager\/client\.js[^"]*)"/u.exec(html)
  assert(match !== null, 'boot graph row for the client bundle not found')
  const url = match[1].replaceAll('&amp;', '&')
  const bundle = await fetch(new URL(url, `${origin}/`), {
    headers: cookieHeader === undefined ? {} : { cookie: cookieHeader },
  })
  const text = await bundle.text()
  assert(bundle.status === 200, `client bundle answered ${bundle.status}`)
  assert(/window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-skills-manager"/u.test(text), 'client bundle has no loader registration')
  pass('client bundle served', `${new URL(url, `${origin}/`).pathname.slice(0, 48)}…`)
}

async function main() {
  if (!existsSync(join(HARNESS, 'apps', 'cli', 'src', 'bin.ts'))) {
    throw new Error(`Harness checkout not found at ${HARNESS}; set DSH_HARNESS_DIR`)
  }
  if (!existsSync(join(HARNESS, 'packages', 'skill', 'skill', 'lib', 'index.js'))) {
    throw new Error(`Harness build artifacts are missing under ${HARNESS}; run "pnpm run build" there first`)
  }
  console.log('Building the plugin…')
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS })
  assert(existsSync(join(ROOT, 'lib', 'index.js')), 'lib/index.js was not produced')
  assert(existsSync(join(ROOT, 'client', 'client.js')), 'client/client.js was not produced')
  pass('build produced host and client artifacts')

  temporary = mkdtempSync(join(tmpdir(), 'dsh-skills-verify-'))
  const library = join(temporary, 'library')
  const project = join(temporary, 'project')
  const localSource = join(temporary, 'local-source')
  const gitRemote = join(temporary, 'git-remote')
  mkdirSync(join(localSource, 'skills', 'alpha'), { recursive: true })
  mkdirSync(join(localSource, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(localSource, 'skills', 'alpha', 'SKILL.md'), skillMarkdown('alpha', 'First verification skill.'))
  writeFileSync(join(localSource, 'skills', 'beta', 'SKILL.md'), skillMarkdown('beta', 'Second verification skill.'))
  mkdirSync(project, { recursive: true })
  mkdirSync(join(gitRemote, 'skills', 'gamma'), { recursive: true })
  writeFileSync(join(gitRemote, 'skills', 'gamma', 'SKILL.md'), skillMarkdown('gamma', 'Git verification skill.'))
  git(gitRemote, ['init', '-b', 'main'])
  git(gitRemote, ['add', '.'])
  git(gitRemote, ['commit', '-m', 'first'])
  git(gitRemote, ['tag', 'v1.0.0'])

  const overlay = join(temporary, 'overlay.yml')
  writeFileSync(overlay, [
    '- insert:',
    '    - id: skills-manager',
    `      name: '${join(ROOT, 'lib', 'index.js')}'`,
    '      config:',
    `        libraryDir: ${library}`,
    `        statePath: ${join(temporary, 'state.json')}`,
    `        linksPath: ${join(temporary, 'links.json')}`,
    `        updatesPath: ${join(temporary, 'updates.json')}`,
    '',
  ].join('\n'))

  console.log(`Booting dsh web from ${HARNESS}…`)
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm',
    join(HARNESS, 'apps', 'cli', 'src', 'bin.ts'),
    'web', '--patch', overlay, '--no-open', '--port', '0',
  ], {
    cwd: HARNESS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })
  let log = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })

  try {
    const { origin, token } = await waitForServer(child, () => log)
    pass('dsh web booted with the overlay', origin)
    for (let attempt = 0; ; attempt += 1) {
      try {
        const snapshot = await api(origin, '/library')
        assert(snapshot.status === 200, `library answered ${snapshot.status}`)
        break
      } catch (error) {
        if (attempt > 100) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    // 1. Install a local source.
    const install = await api(origin, '/sources/install', {
      method: 'POST',
      body: JSON.stringify({ sourceType: 'local', identifier: localSource }),
    })
    assert(install.status === 202, `install answered ${install.status}`)
    await waitForJob(origin, install.body.jobId)
    let snapshot = await api(origin, '/library')
    const local = snapshot.body.sources.find((source) => source.slug === 'local-source')
    assert(local !== undefined, 'local source was not listed')
    assert(local.skills.length === 2, `expected 2 skills, saw ${local.skills.length}`)
    pass('local source installed', 'alpha + beta')

    // 2. Link it into a project as symlinks.
    const link = await api(origin, '/links', {
      method: 'POST',
      body: JSON.stringify({ project, source: 'local-source', agents: ['dsh'] }),
    })
    assert(link.status === 200, `link answered ${link.status}`)
    assert(link.body.counts.linked === 2, `linked ${link.body.counts.linked} positions`)
    const alphaLink = join(project, '.dsh', 'skills', 'alpha')
    assert(lstatSync(alphaLink).isSymbolicLink(), 'alpha is not a symlink')
    assert(readlinkSync(alphaLink) === join(library, 'local-source', 'skills', 'alpha'), 'alpha points elsewhere')
    pass('project link created', `${join(project, '.dsh', 'skills')} -> library`)

    // 3. Per-project switch: off for one skill, record kept.
    const off = await api(origin, '/links', {
      method: 'PUT',
      body: JSON.stringify({ project, source: 'local-source', skillName: 'alpha', enabled: false }),
    })
    assert(off.status === 200, `project switch answered ${off.status}`)
    assert(!existsSync(alphaLink), 'alpha link survived the project switch')
    assert(existsSync(join(project, '.dsh', 'skills', 'beta')), 'beta link disappeared')
    assert(off.body.project.entries.some((entry) => entry.skillName === 'alpha' && entry.enabled === false), 'record dropped')
    pass('per-project switch removes the link but keeps the record')

    // 4. Global switch: detach every link, keep records, restore on enable.
    const globalOff = await api(origin, '/sources/local-source', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    })
    assert(globalOff.status === 200, `global switch answered ${globalOff.status}`)
    assert(!existsSync(join(project, '.dsh', 'skills', 'beta')), 'beta link survived the global switch')
    const kept = await api(origin, '/links')
    assert((kept.body.projects[0]?.entries.length ?? 0) === 2, 'project records were dropped by the global switch')
    const globalOn = await api(origin, '/sources/local-source', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    assert(globalOn.status === 200, `global restore answered ${globalOn.status}`)
    assert(existsSync(join(project, '.dsh', 'skills', 'beta')), 'beta link was not restored')
    assert(!existsSync(alphaLink), 'alpha came back although its project switch is off')
    pass('global switch detaches and restores, honoring project switches')

    // 5. Version and update check on a real git source.
    const gitInstall = await api(origin, '/sources/install', {
      method: 'POST',
      body: JSON.stringify({ sourceType: 'git', identifier: `file://${gitRemote}` }),
    })
    assert(gitInstall.status === 202, `git install answered ${gitInstall.status}`)
    await waitForJob(origin, gitInstall.body.jobId)
    snapshot = await api(origin, '/library')
    const gitSource = snapshot.body.sources.find((source) => source.sourceType === 'git')
    assert(gitSource !== undefined, 'git source was not listed')
    assert(gitSource.version === 'v1.0.0', `expected version v1.0.0, saw ${gitSource.version}`)
    const firstCheck = await api(origin, `/sources/${gitSource.slug}/check`, { method: 'POST' })
    assert(firstCheck.body.check.behind === 0, `expected behind 0, saw ${firstCheck.body.check.behind}`)
    mkdirSync(join(gitRemote, 'skills', 'delta'), { recursive: true })
    writeFileSync(join(gitRemote, 'skills', 'delta', 'SKILL.md'), skillMarkdown('delta', 'Added after install.'))
    git(gitRemote, ['add', '.'])
    git(gitRemote, ['commit', '-m', 'second'])
    const behind = await api(origin, `/sources/${gitSource.slug}/check`, { method: 'POST' })
    assert(behind.body.check.behind === 1, `expected behind 1, saw ${behind.body.check.behind}`)
    const update = await api(origin, `/sources/${gitSource.slug}/update`, { method: 'POST' })
    await waitForJob(origin, update.body.jobId)
    const afterUpdate = await api(origin, `/sources/${gitSource.slug}/check`, { method: 'POST' })
    assert(afterUpdate.body.check.behind === 0, 'clone is still behind after the update')
    pass('git version, update check, and fast-forward update work')

    // 6. The browser bundle is part of the boot graph and is served.
    await verifyClientBundle(origin, token)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
      child.on('exit', () => { clearTimeout(timer); resolve() })
    })
    if (KEEP) {
      console.log(`\nKept the temporary workspace: ${temporary}`)
      console.log(`Overlay: ${overlay}`)
    } else {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  fail('verification', error instanceof Error ? error.message : String(error))
  if (temporary !== undefined && KEEP) console.error(`Temporary workspace kept at ${temporary}`)
  process.exitCode = 1
})
