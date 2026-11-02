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
import { LibrarySkillProvider } from './provider.js'
import { DEFAULT_ROUTE_PREFIX } from './shared/api.js'
import { StateStore } from './state.js'

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
  const routePrefix = normalizePrefix(config.routePrefix ?? DEFAULT_ROUTE_PREFIX)

  const state = new StateStore(statePath, ctx.logger)
  const jobs = new JobRegistry()

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
