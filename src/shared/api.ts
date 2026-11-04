/**
 * Wire types shared by the Host HTTP routes, Agent Tools, and Web Client bundle.
 *
 * @module dsh-media-station/shared
 */

export const DEFAULT_ROUTE_PREFIX = '/dsh-media-station'
export const LOCALE_NAMESPACE = 'media-station'

/** Topic lifecycle status */
export type TopicStatus = 'candidate' | 'planned' | 'drafted' | 'published' | 'archived'

/** Category of a topic */
export type TopicCategory = 'tech' | 'ai' | 'indie' | 'tools' | 'business' | string

/** External reference link supporting the topic */
export interface TopicReference {
  readonly title?: string
  readonly url: string
  readonly source?: string
  readonly pubDate?: string
}

/** Full topic domain view */
export interface TopicView {
  readonly id: string
  readonly workspacePath: string
  readonly batchDate: string
  readonly title: string
  readonly summary: string
  readonly heatScore: number
  readonly viralityScore?: number
  readonly depthScore?: number
  readonly category: TopicCategory
  readonly angles: readonly string[]
  readonly references: readonly TopicReference[]
  readonly status: TopicStatus
  readonly draftPath?: string
  readonly refineStatus?: 'pending' | 'running' | 'done' | 'failed'
  readonly refinedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw article payload before AIHOT scoring & deduplication */
export interface RawArticle {
  readonly title: string
  readonly url: string
  readonly snippet?: string
  readonly sourceName?: string
  readonly category?: string
  readonly pubDate?: string
}

/** Ingestion result */
export interface IngestResult {
  readonly ok: boolean
  readonly batchDate: string
  readonly totalReceived: number
  readonly dedupSkipped: number
  readonly newEvaluated: number
  readonly eventsCreated: number
  readonly degraded: boolean
  readonly topics: readonly TopicView[]
  readonly markdownPath?: string
  readonly refineTaskId?: string
}

/** Check updates probe result */
export interface CheckUpdatesResult {
  readonly ok: boolean
  readonly hasNew: boolean
  readonly newCount: number
  readonly candidatesCount: number
  readonly checkedAt: number
}

/** Deep article summary result */
export interface ArticleSummaryResult {
  readonly ok: boolean
  readonly title: string
  readonly summary: string
  readonly readersBenefit: string
  readonly controversy: string
  readonly hooks: readonly string[]
  readonly heatScore: number
  readonly category?: string
}

/** Managed content source (e.g. RSS feed) */
export interface ContentSource {
  readonly id: string
  readonly workspacePath?: string
  readonly name: string
  readonly type: 'rss' | 'atom' | 'site'
  readonly feedUrl: string
  readonly category: string
  readonly tags: readonly string[]
  readonly enabled: boolean
  readonly lastFetchedAt?: number
  readonly lastStatus?: 'ok' | 'error'
  readonly lastError?: string
  readonly createdAt: number
}

/** Result of adding a source with automatic categorization */
export interface AddSourceResult {
  readonly ok: boolean
  readonly source: ContentSource
  readonly autoCategorized: boolean
  readonly sampleArticlesCount: number
}

/** Aggregated metrics for topics board */
export interface TopicMetrics {
  readonly totalEvents7d: number
  readonly todayTopHeat: number
  readonly draftedCount7d: number
  readonly conversionRate: number
  readonly categoryBreakdown: Record<string, number>
}

/** State of an asynchronous refinement task */
export interface RefineTaskState {
  readonly taskId: string
  readonly status: 'pending' | 'running' | 'done' | 'failed'
  readonly progress: number
  readonly error?: string
  readonly doneCount?: number
  readonly totalCount?: number
}

/** Pipeline integration configuration */
export interface PipelineConfig {
  readonly workspacePath: string
  readonly pipelineType: 'n8n' | 'cron' | 'custom'
  readonly workflowId?: string
  readonly workflowName?: string
  readonly editorUrl?: string
  readonly active: boolean
  readonly deployedAt?: number
  readonly updatedAt?: number
}

/** Scaffold initialization result */
export interface ScaffoldResult {
  readonly ok: boolean
  readonly workspacePath: string
  readonly created: readonly string[]
  readonly existed: readonly string[]
  readonly scaffoldReady: boolean
}
