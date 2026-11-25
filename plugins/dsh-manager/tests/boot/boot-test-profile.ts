/** Boot a test overlay over the shipped web-profile bundle layers. */

import { createRequire } from 'node:module'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  type ProfileContext,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'

/** First resolution anchor: the installed dsh CLI package, like the real launcher. */
const installAnchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')

function insertedPluginNames(entries: readonly EntryOptions[]): string[] {
  return entries.flatMap((entry) => {
    const children = entry.group && Array.isArray(entry.config)
      ? insertedPluginNames(entry.config as EntryOptions[])
      : []
    return [entry.name, ...children]
  })
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function resolvePackageDir(patchPath: string, name: string): string {
  const fromPatch = createRequire(patchPath)
  try {
    return dirname(fromPatch.resolve(`${name}/package.json`))
  } catch {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`))
  }
}

function overlayModuleLayers(path: string, patches: readonly PatchOptions[]): ProfileLayer[] {
  const packages = new Map<string, string>()
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  for (const specifier of insertedPluginNames(inserted)) {
    const name = packageName(specifier)
    if (name === undefined || packages.has(name)) continue
    packages.set(name, resolvePackageDir(path, name))
  }
  return [...packages].map(([name, packageDir], index) => ({
    packageName: `test-overlay:${index}:${name}`,
    packageDir,
    patchPaths: [path],
    patches: [],
  }))
}

/** Inputs for {@link bootTestProfile}. */
export interface TestProfileOptions {
  /** Diagnostic prefix for profile and Loader failures. */
  readonly binName: string
  /** Shipped profile whose bundle layers form the test tree. */
  readonly profile: string
  /** Test overlay files, named `*.patch.yml`, applied above the shipped bundle layers in order. */
  readonly overlayPaths: readonly string[]
  /** Harness home; defaults to a temp-adjacent path under the OS temp when unset. */
  readonly home?: string
  /** Optional host setup before any composed entry mounts. */
  readonly prepare?: (ctx: Context) => Promise<void> | void
}

/**
 * Load and compose one shipped profile with narrow test overlays, mirroring
 * the harness loader-smoke `bootProductionProfile` helper on published APIs.
 * @param options - profile, overlay files, home, and optional host setup.
 * @returns the settled Loader root context.
 */
export async function bootTestProfile(options: TestProfileOptions): Promise<Context> {
  for (const path of options.overlayPaths) {
    if (!path.endsWith('.patch.yml')) {
      throw new Error(`${options.binName}: test overlay path must end in .patch.yml: ${path}`)
    }
  }
  // `!!js dshHomePath(...)` config expressions resolve $DSH_HOME at call
  // time; pin the env so test storage and credentials never reach the real
  // home. Suites run serialized, so the pin is safe.
  const previousHome = process.env['DSH_HOME']
  if (options.home !== undefined) process.env['DSH_HOME'] = options.home
  try {
    return await bootTestProfileInner(options)
  } finally {
    if (options.home === undefined) delete process.env['DSH_HOME']
    else if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
  }
}

/**
 * Write the test run's webserver patch: an OS-assigned port (0) keeps every
 * boot independent of the desktop instance that may hold the default port,
 * and of the other suites running in parallel. Applied after the spec's own
 * overlays, so a spec's explicit webserver patch is overridden consistently.
 */
async function ensureTestWebserverPatch(home: string): Promise<string> {
  const patchPath = join(home, 'dsh-test-webserver.patch.yml')
  await writeFile(patchPath, [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '',
  ].join('\n'))
  return patchPath
}

async function bootTestProfileInner(options: TestProfileOptions): Promise<Context> {
  const profile = loadProfile(options.binName, options.profile, installAnchor, options.home, { userLayer: false })
  const rootConfig = join(profile.dir, 'cordis.yml')
  const { writeFile: writeRootConfig } = await import('node:fs/promises')
  await writeRootConfig(rootConfig, '[]\n')

  const overlayPaths = [...options.overlayPaths]
  if (options.home !== undefined) overlayPaths.push(await ensureTestWebserverPatch(options.home))
  const overlays = overlayPaths.map(path => loadOverlayPatches(options.binName, path))
  // Overlay-only packages need profile module visibility in plain-Node mode,
  // but these synthetic layers do not contribute Cordis patches.
  const moduleLayers = options.overlayPaths.flatMap((path, index) => (
    overlayModuleLayers(path, overlays[index] ?? [])
  ))
  const resolution = await createRuntimeResolution({
    installAnchor,
    profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
  })
  return await boot(
    options.binName,
    rootConfig,
    [
      ...profile.layers.flatMap(layer => layer.patches),
      ...overlays.flat(),
    ],
    async (ctx) => {
      // The launcher's own profile facts, so profile-backed services activate as in production.
      // Provide both `overlays` (0.2.2-rc.x npm) and `overlayPaths` (master) so
      // boot tests stay compatible across both harness lines.
      const profileContext = {
        name: options.profile, dir: profile.dir, patchPath: profile.patchPath, installAnchor,
        cwd: process.cwd(), home: options.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
        startedBundles: profile.layers.map(layer => layer.packageName),
        overlays: overlays.flat(),
        overlayPaths,
        telemetryDisabledEnv: process.env['DSH_TELEMETRY_DISABLED'],
      } as unknown as ProfileContext
      ctx.provide('profileContext', profileContext)
      // Launcher facts every web-profile entry reads: empty argv with --no-open
      // so tests never spawn real browser tabs, a bounded exit request, and
      // immediate application readiness.
      ctx.provide('cmdlineArgs', { get: () => ['--no-open'] })
      ctx.provide('appExit', () => {})
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      await ctx.plugin(PluginPackages, { resolution })
      await options.prepare?.(ctx)
    },
  )
}

/**
 * Put a tiny stub `glab` binary on `PATH` so GitLab connectivity boot specs
 * remain deterministic in environments without `glab` installed globally.
 * @param binDir - temporary directory created by the caller.
 * @returns a disposer that restores the original `PATH`.
 */
export async function installFakeGlab(binDir: string): Promise<() => void> {
  await mkdir(binDir, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'glab.cmd'), '@echo off\r\necho glab version 1.0.0-test\r\n')
  } else {
    const binPath = join(binDir, 'glab')
    await writeFile(binPath, '#!/bin/sh\necho "glab version 1.0.0-test"\n')
    await chmod(binPath, 0o755)
  }
  const previousPath = process.env['PATH']
  process.env['PATH'] = previousPath === undefined ? binDir : `${binDir}${delimiter}${previousPath}`
  return () => {
    if (previousPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = previousPath
  }
}
