/**
 * Shared Playwright E2E harness for `dsh-plugins`.
 *
 * Launches an isolated `dsh web` instance backed by a throwaway `DSH_HOME`
 * directory so tests never mutate the user's real `~/.dsh` storage, sessions,
 * or credentials, while still loading linked workspace plugins. Set
 * `DSH_E2E_URL` to reuse an externally started `dsh web` server instead.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN_QUERY_RE = /([?&]token=)[^&\s"']+/g
const WEB_READY_URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9._-]+/

/** Redact `token=` query values before writing URLs or logs to stdout/stderr. */
export function redactUrlTokens(text) {
  return String(text).replace(TOKEN_QUERY_RE, '$1<REDACTED>')
}

/** Reserve an ephemeral TCP port on loopback. */
export function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rejectPort)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      srv.close((err) => {
        if (err) rejectPort(err)
        else resolvePort(port)
      })
    })
  })
}

function defaultSourceProfileDir() {
  const sourceHome = process.env.DSH_SOURCE_HOME || join(homedir(), '.dsh')
  return join(sourceHome, 'profiles', 'web')
}

/**
 * Create a temporary `DSH_HOME` whose `profiles/web` links against the current
 * workspace bundles from `sourceProfileDir`, with blank storage/config.
 */
export function prepareIsolatedDshHome({
  sourceProfileDir = defaultSourceProfileDir(),
  requiredBundles = [],
} = {}) {
  const manifestPath = join(sourceProfileDir, 'package.json')
  const nodeModulesPath = join(sourceProfileDir, 'node_modules')
  if (!existsSync(manifestPath) || !existsSync(nodeModulesPath)) {
    throw new Error(
      `E2E harness: missing web profile at ${sourceProfileDir}. ` +
      'Run `./dev.sh --link-missing -a --no-start` in repos/dsh first.',
    )
  }

  const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = Array.isArray(rawManifest?.dsh?.profile?.bundles)
    ? rawManifest.dsh.profile.bundles
    : []
  for (const bundle of requiredBundles) {
    if (!bundles.includes(bundle)) {
      throw new Error(
        `E2E harness: bundle "${bundle}" is not enabled in ${manifestPath}. ` +
        'Run `./dev.sh --link-missing -a --no-start` to link workspace plugins.',
      )
    }
    if (!existsSync(join(nodeModulesPath, bundle))) {
      throw new Error(
        `E2E harness: linked package missing at ${join(nodeModulesPath, bundle)}. ` +
        'Run `./dev.sh --link-missing -a --no-start`.',
      )
    }
  }

  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-e2e-home-'))
  const targetProfileDir = join(tempHome, 'profiles', 'web')
  mkdirSync(targetProfileDir, { recursive: true })

  // Keep only bundle/dependency wiring; omit any secrets, logs, sessions, or user patches.
  const cleanManifest = {
    name: rawManifest.name ?? 'dsh-profile-web-e2e',
    private: true,
    dependencies: rawManifest.dependencies ?? {},
    dsh: {
      profile: {
        bundles,
      },
    },
  }
  writeFileSync(join(targetProfileDir, 'package.json'), JSON.stringify(cleanManifest, undefined, 2) + '\n')
  writeFileSync(join(targetProfileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(targetProfileDir, 'cordis.patch.yml'), '[]\n')
  symlinkSync(nodeModulesPath, join(targetProfileDir, 'node_modules'), 'dir')

  for (const optionalFile of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const src = join(sourceProfileDir, optionalFile)
    if (existsSync(src)) {
      writeFileSync(join(targetProfileDir, optionalFile), readFileSync(src, 'utf8'))
    }
  }

  return tempHome
}

async function waitForHttpReady(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { redirect: 'manual' })
      if (res.status < 500) return
    } catch {
      // Server still binding listener.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`E2E harness: HTTP server at ${redactUrlTokens(baseUrl)} did not respond in ${timeoutMs}ms`)
}

/**
 * Start an isolated `dsh web` server and return its tokenized URL + `stop()` handle.
 */
export async function startIsolatedDshWeb({
  dshRoot,
  requiredBundles = [],
  timeoutMs = 60_000,
} = {}) {
  if (!dshRoot) throw new Error('startIsolatedDshWeb requires dshRoot')
  const harnessDir = join(dshRoot, 'deepseek-harness')
  const port = await findFreePort()
  const tempHome = prepareIsolatedDshHome({ requiredBundles })

  let child
  const logs = []
  let cleaned = false
  const cleanupTempHome = () => {
    rmSync(tempHome, { recursive: true, force: true })
  }

  const stop = async () => {
    if (cleaned) return
    cleaned = true
    if (child && child.pid) {
      const terminate = (sig) => {
        try {
          process.kill(-child.pid, sig)
        } catch {
          try { child.kill(sig) } catch {}
        }
      }
      terminate('SIGTERM')
      await new Promise((resolveExit) => {
        const timer = setTimeout(() => {
          terminate('SIGKILL')
          resolveExit()
        }, 4_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveExit()
        })
      })
    }
    cleanupTempHome()
  }

  try {
    child = spawn('pnpm', ['dsh', 'web', '--port', String(port), '--no-open'], {
      cwd: harnessDir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_HOME: tempHome,
        BROWSER: 'none',
      },
    })

    const url = await new Promise((resolveUrl, rejectUrl) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        rejectUrl(new Error(
          `E2E harness: timed out waiting for dsh web URL after ${timeoutMs}ms.\n` +
          `Redacted logs:\n${redactUrlTokens(logs.slice(-30).join(''))}`,
        ))
      }, timeoutMs)

      const onData = (chunk) => {
        const text = chunk.toString('utf8')
        logs.push(text)
        const match = text.match(WEB_READY_URL_RE)
        if (match && Number(match[1]) === port && !settled) {
          settled = true
          clearTimeout(timer)
          resolveUrl(match[0])
        }
      }

      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectUrl(new Error(
          `E2E harness: dsh web exited early with code ${code}.\n` +
          `Redacted logs:\n${redactUrlTokens(logs.slice(-30).join(''))}`,
        ))
      })
    })

    await waitForHttpReady(url)
    return { url, port, tempHome, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/**
 * Playwright `globalSetup` factory: starts an isolated `dsh web` instance unless
 * `DSH_E2E_URL` is already provided, exports `process.env.DSH_E2E_URL` in memory
 * for worker processes, and tears down both process tree and temp `DSH_HOME`.
 */
export async function setupDshWebGlobal({ dshRoot, requiredBundles = [] }) {
  if (process.env.DSH_E2E_URL) {
    return async () => {}
  }
  const session = await startIsolatedDshWeb({ dshRoot, requiredBundles })
  process.env.DSH_E2E_URL = session.url
  return async () => {
    await session.stop()
  }
}
