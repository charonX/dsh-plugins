/**
 * Configuration schema for the media station plugin.
 *
 * @module dsh-media-station/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { DEFAULT_ROUTE_PREFIX } from './shared/api.js'

export interface Config {
  /** SQLite database path; defaults to $DSH_HOME/media-station/media.db */
  dbPath?: string
  /** Web API route prefix; defaults to /dsh-media-station */
  routePrefix?: string
  /** Fast model route for scoring & summarization */
  fastModel?: {
    provider?: string
    model?: string
  }
  /** Article content enrichment engine */
  crawlerEngine?: 'crawl4ai' | 'jina' | 'firecrawl'
  /** Base URL for self-hosted Crawl4AI */
  crawl4aiUrl?: string
  /** Optional Jina Reader API key */
  jinaApiKey?: string
  /** Minimum heat score threshold for featured topics */
  minHeatThreshold?: number
  /** Whether to enable fingerprint deduplication */
  enableDedup?: boolean
  /** Schedule timing: 'hourly' | 'every-2h' | 'daily' | Cron expression */
  scheduleTiming?: string
  /** Whether to enable short-circuiting when 0 new articles are found */
  enableShortCircuit?: boolean
  /** Custom prompt template for automated editorial agent */
  customPromptTemplate?: string
}

export const Config: Schema<Config> = z.object({
  dbPath: z.string(),
  routePrefix: z.string().default(DEFAULT_ROUTE_PREFIX),
  fastModel: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  crawlerEngine: z.union(['crawl4ai', 'jina', 'firecrawl']).default('jina'),
  crawl4aiUrl: z.string(),
  jinaApiKey: z.string(),
  minHeatThreshold: z.number().default(60),
  enableDedup: z.boolean().default(true),
  scheduleTiming: z.string().default('hourly'),
  enableShortCircuit: z.boolean().default(true),
  customPromptTemplate: z.string(),
})
