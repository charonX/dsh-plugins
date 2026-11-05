/**
 * Plugin entry: reader preferences, the model-backed translation engine, and
 * the HTTP route the Web Client calls.
 *
 * @module dsh-immersive-translate
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import type { EngineLimits } from './engine.js'
import { createRequestHandler } from './http.js'
import { listCatalog, selectionOfProjection } from './models.js'
import { PrefsStore } from './prefs.js'
import { appendBatchPointer, BatchArchive } from './records.js'
import { DEFAULT_TARGET_LANGUAGE, ROUTE_PREFIX, type SelectionView, type TranslatePrefs } from './shared/api.js'

export { Config } from './config.js'
export type { Config as ImmersiveTranslateConfig } from './config.js'
export { parseBatchOutput, preferNoThinking, stripFence, translateBatch } from './engine.js'
export { canDisableThinking, listCatalog, resolveSelection } from './models.js'
export { batchKey, BatchArchive } from './records.js'

export const name = 'immersive-translate'
export const inject = ['webServer']

/**
 * Register the translation engine and its HTTP route.
 * @param ctx - plugin context; `ctx.webServer` must be available.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const dshHome = resolveDshHome()
  const dataHome = join(dshHome, 'immersive-translate')
  const statePath = config.statePath === undefined ? join(dataHome, 'prefs.json') : expandHomePath(config.statePath)
  const batchDir = config.batchDir === undefined ? join(dataHome, 'batches') : expandHomePath(config.batchDir)
  const routePrefix = normalizePrefix(config.routePrefix ?? ROUTE_PREFIX)
  const logger = { warn: (message: string): void => { ctx.logger.warn(message) } }
  const defaults: TranslatePrefs = {
    targetLanguage: config.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
    followDefaultModel: true,
  }

  const prefs = new PrefsStore(statePath, logger, defaults)
  const archive = new BatchArchive(batchDir, logger)
  const limits: EngineLimits = {
    maxItemsPerBatch: config.maxItemsPerBatch ?? 20,
    maxCharsPerItem: config.maxCharsPerItem ?? 4000,
    maxOutputTokens: config.maxOutputTokens ?? 8192,
    requestTimeoutMs: config.requestTimeoutMs ?? 120_000,
  }

  const selectionOf = (value: unknown): SelectionView | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
    return { provider: record.provider, model: record.model }
  }

  const handler = createRequestHandler({
    prefix: routePrefix,
    limits,
    prefs,
    archive,
    logger,
    trustedHosts: () => trustedHostsOf(config),
    llm: () => {
      const runtime = ctx.get('llm')
      return runtime === undefined ? undefined : { runtime }
    },
    defaultSelection: () => {
      const service = ctx.get('agentDefaultModel')
      return service === undefined ? undefined : selectionOf(service.currentSelection())
    },
    sessionSelection: (sessionId) => {
      const sessions = ctx.get('sessions')
      const projections = ctx.get('sessionProjections')
      if (sessions === undefined || projections === undefined) return undefined
      const session = sessions.get(sessionId as never)
      if (session === undefined) return undefined
      const snapshot = projections.snapshot(session, ['modelSelection'])
      return selectionOfProjection(snapshot.values.modelSelection)
    },
    catalog: async (signal) => {
      const runtime = ctx.get('llm')
      return runtime === undefined ? [] : await listCatalog(runtime, signal)
    },
    recordPointer: (sessionId, record) => appendBatchPointer(ctx, sessionId, record, logger),
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: routePrefix, handler }),
    `immersive-translate: route ${routePrefix}`,
  )
}

function trustedHostsOf(config: ConfigShape): readonly string[] | undefined {
  const entries = (config as { trustedHosts?: readonly string[] }).trustedHosts
  return entries === undefined || entries.length === 0 ? undefined : entries
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/u, '')
  if (trimmed === '') return ROUTE_PREFIX
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}
