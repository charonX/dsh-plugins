/**
 * Autoloop microkernel Cordis plugin entry.
 *
 * @module @charonx/dsh-autoloop
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DshAgentExecutor } from './adapters/dsh-executor.js'
import { Config, type Config as ConfigShape } from './config.js'
import { AutoloopKernel } from './core/kernel.js'
import { IntentRouter } from './core/router.js'
import { JournalStore } from './core/store.js'
import { createRequestHandler, DEFAULT_ROUTE_PREFIX } from './http/routes.js'

export { Config } from './config.js'
export { AutoloopKernel } from './core/kernel.js'
export { JournalStore } from './core/store.js'
export { IntentRouter } from './core/router.js'
export * from './shared/types.js'

export const name = 'autoloop'
export const inject = ['webServer?']

declare module '@deepseek-ai/cordis' {
  interface Context {
    autoloop: AutoloopKernel
  }
}

/**
 * Register Autoloop microkernel onto Harness context.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  if (config.enabled === false) {
    ctx.logger.info('[Autoloop] Plugin is disabled in configuration')
    return
  }

  const dshHome = resolveDshHome()
  const dataHome = join(dshHome, 'autoloop')
  const journalPath = config.journalPath
    ? expandHomePath(config.journalPath)
    : join(dataHome, 'journal.jsonl')
  const defaultWorkspacePath = config.defaultWorkspacePath
    ? expandHomePath(config.defaultWorkspacePath)
    : process.cwd()

  // 1. Initialize Event-Sourcing Store
  const store = new JournalStore(journalPath)

  // 2. Initialize Intent Router
  const router = new IntentRouter({
    defaultWorkspacePath,
  })

  // 3. Initialize Kernel
  const kernel = new AutoloopKernel({
    store,
    router,
    maxHops: config.maxHops ?? 8,
    defaultWorkspacePath,
    logger: ctx.logger,
  })

  // Expose service on Cordis context
  ctx.provide('autoloop')
  ctx.autoloop = kernel

  // 4. Register native Agent Executor
  const executor = new DshAgentExecutor(ctx, {
    autoWorktree: config.autoWorktree ?? false,
  })
  ctx.effect(() => kernel.registerExecutor(executor), 'autoloop: executor')

  // 5. Mount HTTP routes if WebServer is present
  const handler = createRequestHandler({
    prefix: DEFAULT_ROUTE_PREFIX,
    kernel,
    ctx,
  })

  const webServer = ctx.get('webServer') as {
    register: (opts: { kind: 'prefix'; path: string; handler: (req: any, res: any) => Promise<void> }) => () => void
  } | undefined

  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: DEFAULT_ROUTE_PREFIX, handler }),
      'autoloop: http routes',
    )
  }

  // Teardown
  ctx.effect(() => () => kernel.stop(), 'autoloop: kernel shutdown')
  ctx.logger.info(`[Autoloop] Kernel ready. Loaded ${store.getAllTickets().length} historical tickets.`)
}
