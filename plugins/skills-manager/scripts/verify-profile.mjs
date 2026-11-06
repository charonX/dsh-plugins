#!/usr/bin/env node
/**
 * Verify the *installed bundle* path: pack the plugin, install it into an
 * isolated DSH profile, boot that profile, and check the host API and browser
 * bundle. Nothing touches the real `~/.dsh` or the user's profiles.
 *
 * Usage:
 *   pnpm verify:profile                 # pack a tarball (published shape), install, boot, remove
 *   pnpm verify:profile -- --linked     # install the checkout itself (fast, dev shape)
 *   pnpm verify:profile -- --keep       # keep the isolated DSH_HOME (and tarball)
 *   DSH_HARNESS_DIR=/path/to/deepseek-harness pnpm verify:profile
 *
 * Requires a built Harness checkout (`pnpm run build`) and network access for
 * this package's runtime dependencies when they are not in the pnpm store.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(process.env.DSH_HARNESS_DIR ?? join(ROOT, '..', 'deepseek-harness'))
const KEEP = process.argv.includes('--keep')
const LINKED = process.argv.includes('--linked')
const PROFILE = 'skills-install-test'
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
const PACKAGE_RE = PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PREFIX = '/dsh-skills-manager'
const BIN = join(HARNESS, 'apps', 'cli', 'src', 'bin.ts')

const checks = []
let temporary
let tarball

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

function dsh(args, options = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', BIN, ...args], {
    cwd: HARNESS,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: options.home, NO_COLOR: '1' },
    timeout: options.timeout ?? 120_000,
  })
  if (result.status !== 0 && options.mustSucceed !== false) {
    throw new Error(`dsh ${args.join(' ')} exited ${String(result.status)}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result
}

async function api(origin, path) {
  const response = await fetch(`${origin}${PREFIX}/api${path}`, { cache: 'no-store' })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

async function waitForServer(child, log) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/u.exec(log())
    if (match !== null) return { origin: `http://127.0.0.1:${match[1]}`, token: match[2] }
    if (child.exitCode !== null) throw new Error(`dsh exited early (${child.exitCode}):\n${log()}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`dsh did not print a URL:\n${log()}`)
}

async function waitForApi(origin) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const snapshot = await api(origin, '/library')
      if (snapshot.status === 200) return snapshot
    } catch {
      // Server is still binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('skills manager API did not answer')
}

async function verifyClientBundle(origin, token) {
  const index = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  assert(index.status < 400, `index answered ${index.status}`)
  const rawCookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie')
  const cookie = rawCookie === null || rawCookie === undefined ? undefined : rawCookie.split(';')[0]
  const html = await (await fetch(`${origin}/`, {
    headers: cookie === undefined ? {} : { cookie },
  })).text()
  assert(html.includes(`${PACKAGE}/client.js`), 'boot graph does not list the client bundle')
  const match = new RegExp(`(?:href|src)="([^"]*${PACKAGE_RE}/client\\.js[^"]*)"`, 'u').exec(html)
  assert(match !== null, 'client bundle row not found in the boot graph')
  const url = match[1].replaceAll('&amp;', '&')
  const response = await fetch(new URL(url, `${origin}/`), {
    headers: cookie === undefined ? {} : { cookie },
  })
  const text = await response.text()
  assert(response.status === 200, `client bundle answered ${response.status}`)
  assert(new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*"${PACKAGE_RE}"`, 'u').test(text), 'client bundle has no loader registration')
  pass('installed bundle appears in the boot graph and is served')
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`Harness checkout not found at ${HARNESS}; set DSH_HARNESS_DIR`)
  if (!existsSync(join(HARNESS, 'packages', 'skill', 'skill', 'lib', 'index.js'))) {
    throw new Error(`Harness build artifacts are missing under ${HARNESS}; run "pnpm run build" there first`)
  }

  console.log(LINKED ? 'Building the plugin (linked install)…' : 'Building and packing the plugin…')
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', timeout: 15 * 60 * 1000 })
  let spec = ROOT
  if (!LINKED) {
    const packed = execFileSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop()
    assert(packed !== undefined && packed.endsWith('.tgz'), 'npm pack did not produce a tarball')
    tarball = join(ROOT, packed)
    spec = tarball
    pass('packed', packed)
  } else {
    pass('linked checkout', ROOT)
  }

  temporary = mkdtempSync(join(tmpdir(), 'dsh-skills-profile-'))
  const home = join(temporary, 'home')
  const profileDir = join(home, 'profiles', PROFILE)
  const env = { home }

  dsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
  assert(existsSync(join(profileDir, 'package.json')), 'profile was not created from the web template')
  pass('profile created from the web template', profileDir)

  const added = dsh(['plugin', '--profile', PROFILE, 'add', spec], env)
  void added
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert(manifest.dsh.profile.bundles.includes(PACKAGE), 'bundle was not appended to dsh.profile.bundles')
  assert(typeof manifest.dependencies[PACKAGE] === 'string', 'package dependency was not recorded')
  pass('plugin installed into the profile', manifest.dependencies[PACKAGE])

  for (const file of ['lib/index.js', 'client/client.js', 'cordis.patch.yml']) {
    assert(existsSync(join(profileDir, 'node_modules', PACKAGE, file)), `installed package is missing ${file}`)
  }
  pass('published files are present in the profile install')

  const dump = dsh(['--profile', PROFILE, '--dump-config'], env)
  assert(dump.stdout.includes(`== ${PACKAGE}`), 'composed config has no skills-manager layer')
  const row = dump.stdout.split('\n').findIndex((line) => line.includes(`== ${PACKAGE}`))
  assert(row >= 0 && dump.stdout.split('\n')[row + 1]?.includes('id: skills-manager'), 'layer row is missing')
  pass('--dump-config shows the applied bundle layer')

  console.log('Booting the installed profile…')
  const child = spawn(process.execPath, ['--import', 'tsx/esm', BIN, '--profile', PROFILE, '--no-open', '--port', '0'], {
    cwd: HARNESS,
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })

  try {
    const { origin, token } = await waitForServer(child, () => log)
    pass('installed profile booted', origin)
    const snapshot = await waitForApi(origin)
    assert(snapshot.body.libraryDir.startsWith(home), `library dir escaped the isolated home: ${snapshot.body.libraryDir}`)
    pass('host API answers', snapshot.body.libraryDir)
    await verifyClientBundle(origin, token)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
      child.on('exit', () => { clearTimeout(timer); resolve() })
    })
  }

  dsh(['plugin', '--profile', PROFILE, 'remove', PACKAGE], env)
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert(!after.dsh.profile.bundles.includes(PACKAGE), 'bundle list still contains the plugin')
  const dumpAfter = dsh(['--profile', PROFILE, '--dump-config'], env)
  assert(!dumpAfter.stdout.includes(`== ${PACKAGE}`), 'layer survived the removal')
  pass('plugin removed from the profile')

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    fail('profile verification', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    if (tarball !== undefined && !KEEP) rmSync(tarball, { force: true })
    if (temporary === undefined) return
    if (KEEP) {
      console.log(`\nKept the isolated DSH_HOME: ${join(temporary, 'home')}`)
      if (tarball !== undefined) console.log(`Kept the tarball: ${tarball}`)
    } else {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
