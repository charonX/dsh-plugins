/**
 * Plugin configuration accepted from the profile patch.
 *
 * @module dsh-immersive-translate/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { DEFAULT_TARGET_LANGUAGE, ROUTE_PREFIX } from './shared/api.js'

/** Deployment-level configuration; reader preferences live in the plugin state file. */
export interface Config {
  /** HTTP prefix the routes and the Web Client use. */
  routePrefix?: string
  /** Preference file; defaults to `<dshHome>/immersive-translate/prefs.json`. */
  statePath?: string
  /** Batch archive root; defaults to `<dshHome>/immersive-translate/batches`. */
  batchDir?: string
  /** Target language used before the reader picks one. */
  targetLanguage?: string
  /** Items sent in one model request. */
  maxItemsPerBatch?: number
  /** Longest accepted single text unit, in UTF-16 code units. */
  maxCharsPerItem?: number
  /** Output-token ceiling per batch request. */
  maxOutputTokens?: number
  /** Whole-request deadline in milliseconds. */
  requestTimeoutMs?: number
}

/** Validated configuration schema. */
export const Config: Schema<Config> = z.object({
  routePrefix: z.string().default(ROUTE_PREFIX),
  statePath: z.string(),
  batchDir: z.string(),
  targetLanguage: z.string().default(DEFAULT_TARGET_LANGUAGE),
  maxItemsPerBatch: z.number().default(20),
  maxCharsPerItem: z.number().default(4000),
  maxOutputTokens: z.number().default(4096),
  requestTimeoutMs: z.number().default(120_000),
})
