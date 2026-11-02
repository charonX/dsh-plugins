/**
 * Skills manager plugin entry: registers the library-backed skill provider and
 * the HTTP routes the Web Client uses.
 *
 * @module dsh-skills-manager
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { createRequestHandler } from './http.js'
import { JobRegistry } from './jobs.js'
import { LinkManager } from './links.js'
import { LibrarySkillProvider } from './provider.js'
import { DEFAULT_ROUTE_PREFIX, type WorkspaceOptionView } from './shared/api.js'
import { StateStore } from './state.js'
import { UpdateStore } from './updates.js'

export { Config } from './config.js'
export type { Config as SkillsManagerConfig } from './config.js'
export { LibrarySkillProvider, MANAGED_SKILL_SOURCE } from './provider.js'
export { StateStore } from './state.js'
export { buildSnapshot } from './view.js'

export const name = 'skills-manager'
export const inject = ['skills']

/**
 * Register the manager on the Harness context.
 * @param ctx - plugin context; `ctx.skills` must be available.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const dshHome = resolveDshHome()
  const dataHome = join(dshHome, 'skills-manager')
  const libraryDir = config.libraryDir === undefined
    ? join(dataHome, 'library')
    : expandHomePath(config.libraryDir)
  const statePath = config.statePath === undefined
    ? join(dataHome, 'manager-state.json')
    : expandHomePath(config.statePath)
  const linksPath = config.linksPath === undefined
    ? join(dataHome, 'links.json')
    : expandHomePath(config.linksPath)
  const updatesPath = config.updatesPath === undefined
    ? join(dataHome, 'updates.json')
    : expandHomePath(config.updatesPath)
  const routePrefix = normalizePrefix(config.routePrefix ?? DEFAULT_ROUTE_PREFIX)

  const state = new StateStore(statePath, ctx.logger)
  const jobs = new JobRegistry()
  const updates = new UpdateStore(updatesPath, ctx.logger)
  const links = new LinkManager({
    libraryDir,
    recordPath: linksPath,
    logger: ctx.logger,
    readState: () => state.read(),
  })

  let provider: LibrarySkillProvider | undefined
  ctx.effect(
    () => ctx.skills.registerProvider((control: SkillProviderControl) => {
      provider = new LibrarySkillProvider(
        {
          libraryDir,
          providerName: config.providerName ?? 'skills-manager',
          rank: config.rank ?? 450,
          readState: () => state.read(),
          logger: ctx.logger,
        },
        control,
      )
      return provider
    }),
    'skills-manager: skill provider',
  )

  const handler = createRequestHandler({
    prefix: routePrefix,
    libraryDir,
    statePath,
    allowFileProtocol: config.allowFileProtocol !== false,
    state,
    jobs,
    links,
    updates,
    listWorkspaces: () => readWorkspaces(ctx),
    logger: ctx.logger,
    trustedHosts: () => readTrustedHosts(ctx),
    onLibraryChanged: () => provider?.invalidate(),
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: routePrefix, handler }),
      'skills-manager: http routes',
    )
  })
}

/**
 * Read the host's workspaces as link targets, tolerating a host without the
 * workspace registry (headless or minimal profiles).
 * @param ctx - plugin context.
 * @returns current workspaces with their absolute directories.
 */
function readWorkspaces(ctx: Context): readonly WorkspaceOptionView[] {
  const registry: unknown = ctx.get('workspaceRegistry')
  if (typeof registry !== 'object' || registry === null) return []
  const list = (registry as { list?: unknown }).list
  if (typeof list !== 'function') return []
  const rows: unknown = (list as () => unknown).call(registry)
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const result: WorkspaceOptionView[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const candidate = row as { path?: unknown; title?: unknown }
    if (typeof candidate.path !== 'string' || candidate.path === '' || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    result.push({
      path: candidate.path,
      title: typeof candidate.title === 'string' && candidate.title !== '' ? candidate.title : candidate.path,
    })
  }
  return result
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/u, '')
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash === '' ? DEFAULT_ROUTE_PREFIX : withLeadingSlash
}

/**
 * Read the host's declared trusted authorities, tolerating an older host
 * without the connection service.
 * @param ctx - plugin context.
 * @returns the trusted host list, or undefined when the service is absent.
 */
function readTrustedHosts(ctx: Context): readonly string[] | undefined {
  const connection: unknown = ctx.get('connection')
  if (typeof connection !== 'object' || connection === null) return undefined
  const hosts = (connection as { trustedHosts?: unknown }).trustedHosts
  if (!Array.isArray(hosts)) return undefined
  return hosts.filter((entry): entry is string => typeof entry === 'string')
}
