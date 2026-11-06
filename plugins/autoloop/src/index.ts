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
import { resolveOffpeakWindow } from './shared/schedule.js'

export { Config } from './config.js'
export { AutoloopKernel } from './core/kernel.js'
export { JournalStore } from './core/store.js'
export { IntentRouter } from './core/router.js'
export * from './shared/types.js'
export * from './shared/schedule.js'

export const name = 'autoloop'
export const inject = []

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
  const store = new JournalStore(journalPath, {
    completedRetentionDays: config.completedRetentionDays ?? 14,
    compactAfterLines: config.journalCompactLines ?? 2000,
    logger: ctx.logger,
  })

  // One window value serves the kernel, the router narrative, and the monitor.
  const offpeak = resolveOffpeakWindow(config)
  const maxConcurrent = config.maxConcurrent ?? 2

  // 2. Initialize Intent Router
  const router = new IntentRouter({
    defaultWorkspacePath,
    offpeak,
  })

  // 3. Initialize Kernel
  const kernel = new AutoloopKernel({
    store,
    router,
    maxHops: config.maxHops ?? 8,
    defaultWorkspacePath,
    offpeak,
    maxConcurrent,
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

  // 5. Mount HTTP routes when WebServer is present
  const handler = createRequestHandler({
    prefix: DEFAULT_ROUTE_PREFIX,
    kernel,
    ctx,
    defaultWorkspacePath,
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: DEFAULT_ROUTE_PREFIX, handler }),
      'autoloop: http routes',
    )
    ctx.logger.info(`[Autoloop] Mounted REST API routes under ${DEFAULT_ROUTE_PREFIX}`)
  })

  // Teardown
  ctx.effect(() => () => kernel.stop(), 'autoloop: kernel shutdown')
  ctx.logger.info(
    `[Autoloop] Kernel ready. Loaded ${store.getAllTickets().length} historical tickets. `
    + `Off-peak window ${offpeak.start}-${offpeak.end}, max ${maxConcurrent} concurrent.`,
  )
}
