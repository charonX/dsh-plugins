/**
 * Self-media workstation plugin entry: registers Host services, HTTP routes,
 * and Agent tools for DeepSeek Harness.
 *
 * @module dsh-media-station
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, type Config as ConfigShape } from './config.js'
import { DEFAULT_ROUTE_PREFIX, LOCALE_NAMESPACE } from './shared/api.js'

export { Config } from './config.js'
export type { Config as MediaStationConfig } from './config.js'
export * from './shared/api.js'

export const name = LOCALE_NAMESPACE
export const inject = ['tools']

/**
 * Register the media station plugin on the Harness context.
 *
 * @param ctx - Cordis plugin context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const routePrefix = config.routePrefix || DEFAULT_ROUTE_PREFIX
  ctx.logger?.info?.(`[media-station] Initializing with routePrefix=${routePrefix}`)

  // Host WebServer registration (when webServer service is available)
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.logger?.info?.(`[media-station] Registering HTTP routes at ${routePrefix}`)
  })
}
