/**
 * Declarative YAML single-source-of-truth (SSOT) store for Crew, Pipelines,
 * and Route Rules with atomic writes, one-time migration from legacy
 * storage-domain tables, anti-echo file watching, and all-or-nothing
 * validation on hot reload.
 */
import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { crewDomain } from './crew/crew-domain.ts'
import type { CrewMember } from './crew/crew-core.ts'
import { pipelineDomain } from './pipeline/pipeline-domain.ts'
import type { PipelineRecord } from './pipeline/pipeline-core.ts'
import { routeDomain } from './route/route-domain.ts'
import type { RouteRule } from './route/route-core.ts'
import {
  emptyTeamConfig,
  parseTeamConfigYaml,
  sanitizeLegacyTeamConfig,
  serializeTeamConfigYaml,
  validateTeamConfigDocument,
  type TeamConfigDocument,
  type TeamConfigStatusView,
} from './team-config/team-config-core.ts'
import { createTeamConfigTools } from './team-config/team-config-tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Unified hot-reloading YAML configuration store for team, pipelines, and routes. */
    dshManagerTeamConfig: DshManagerTeamConfig
  }
}

/** Configuration options for the team-config YAML store. */
export interface TeamConfigOptions {
  /** Override YAML file path; defaults to `<DSH_HOME>/dsh-manager/team-config.yaml`. */
  filePath?: string
  /** File-watch debounce in milliseconds; defaults to 60ms. */
  debounceMs?: number
}

export const TeamConfigOptions: z<TeamConfigOptions> = z.object({
  filePath: z.string(),
  debounceMs: z.natural(),
})

const DEFAULT_DEBOUNCE_MS = 60

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function resolveDshHome(ctx: Context): string {
  const profileContext = (ctx as unknown as { get?: (key: string) => unknown }).get?.('profileContext') as
    | { readonly home?: string }
    | undefined
  return profileContext?.home ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(filePath)}.tmp-${randomUUID()}`)
  try {
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

export class DshManagerTeamConfig extends TypertRemoteService {
  /** Reads legacy storage-domain tables once during first-boot migration. */
  static inject = ['storageDomain']

  static Config: z<TeamConfigOptions> = TeamConfigOptions

  private readonly filePath: string
  private readonly debounceMs: number
  private doc: TeamConfigDocument = emptyTeamConfig()
  private revision = 1
  private loadedAt = Date.now()
  private lastError: string | undefined
  private lastErrorAt: number | undefined
  private lastWrittenHash: string | undefined
  private chain: Promise<void> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly listeners = new Set<(status: TeamConfigStatusView) => void>()

  constructor(ctx: Context, config: TeamConfigOptions = {}) {
    super(ctx, 'dshManagerTeamConfig', { namespace: 'dshManager' })
    this.filePath = config.filePath ?? join(resolveDshHome(ctx), 'dsh-manager', 'team-config.yaml')
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  protected async [Service.init](): Promise<void> {
    await this.loadOrMigrate()
    await this.startWatcher()
    this.ctx.effect(() => () => {
      this.closed = true
      if (this.debounceTimer !== undefined) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = undefined
      }
      this.watcher?.close()
      this.watcher = undefined
    }, 'dsh-manager: close team-config watcher')

    // Register global chat/MCP tools when `tools` is available on the host.
    this.ctx.inject(['tools'], (toolsCtx) => {
      for (const tool of createTeamConfigTools(this)) {
        toolsCtx.effect(
          () => (toolsCtx as unknown as { tools: { register(def: unknown): () => void } }).tools.register(tool),
          `dsh-manager: register ${tool.name}`,
        )
      }
    })
  }

  /** Current crew members sorted by creation order. */
  crew(): readonly CrewMember[] {
    return [...this.doc.crew].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Current pipelines sorted by creation order. */
  pipelines(): readonly PipelineRecord[] {
    return [...this.doc.pipelines].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Current route rules in stable order. */
  routes(): readonly RouteRule[] {
    return [...this.doc.routes].sort((left, right) => left.order - right.order || left.createdAt - right.createdAt)
  }

  /** Immutable snapshot of the active validated configuration. */
  snapshot(): TeamConfigDocument {
    return this.doc
  }

  /** Current file path, revision counter, and last validation error (if any). */
  status(): TeamConfigStatusView {
    return {
      filePath: this.filePath,
      revision: this.revision,
      loadedAt: this.loadedAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
    }
  }

  /** Subscribe to in-process config or validation-status changes. */
  subscribe(listener: (status: TeamConfigStatusView) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Remote status query consumed by Team UI polling / refresh. */
  @Remote
  async teamConfigStatus(): Promise<TeamConfigStatusView> {
    return this.status()
  }

  /** Remote explicit reload trigger from disk (also used in tests). */
  @Remote
  async teamConfigReload(): Promise<TeamConfigStatusView> {
    return await this.reloadFromDisk()
  }

  /**
   * Atomically transform, validate, persist to YAML, and publish a config
   * mutation. Serialized on a single write chain to prevent interleaved edits.
   */
  async mutate(transform: (current: TeamConfigDocument) => TeamConfigDocument): Promise<TeamConfigDocument> {
    return await this.enqueue(async () => {
      const next = validateTeamConfigDocument(transform(this.doc))
      const yamlText = serializeTeamConfigYaml(next)
      const hash = sha256(yamlText)
      await writeTextAtomic(this.filePath, yamlText)
      this.lastWrittenHash = hash
      this.doc = next
      this.revision += 1
      this.loadedAt = Date.now()
      this.lastError = undefined
      this.lastErrorAt = undefined
      this.emitChange()
      return next
    })
  }

  /** Re-read `team-config.yaml` from disk, applying atomically or preserving the previous valid state on error. */
  async reloadFromDisk(): Promise<TeamConfigStatusView> {
    return await this.enqueue(async () => {
      await this.applyFromDisk('reload')
      return this.status()
    })
  }

  private async loadOrMigrate(): Promise<void> {
    let existingText: string | undefined
    try {
      existingText = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.recordFailure(`failed to read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    if (existingText !== undefined) {
      await this.applyYamlText(existingText)
      return
    }

    // First-boot migration from legacy storage-domain tables (if any records exist).
    const migrated = await this.readLegacyDomains()
    const yamlText = serializeTeamConfigYaml(migrated)
    const hash = sha256(yamlText)
    await writeTextAtomic(this.filePath, yamlText)
    this.lastWrittenHash = hash
    this.doc = migrated
    this.loadedAt = Date.now()
    this.lastError = undefined
    this.lastErrorAt = undefined
  }

  private async readLegacyDomains(): Promise<TeamConfigDocument> {
    const crewDom = await this.ctx.storageDomain.open(crewDomain)
    const pipelineDom = await this.ctx.storageDomain.open(pipelineDomain)
    const routeDom = await this.ctx.storageDomain.open(routeDomain)
    try {
      const crew = [...crewDom.table('members').entries()].map(([, record]) => record)
      const pipelines = [...pipelineDom.table('pipelines').entries()].map(([, record]) => record)
      const routes = [...routeDom.table('rules').entries()].map(([, record]) => record)
      if (crew.length === 0 && pipelines.length === 0 && routes.length === 0) {
        return emptyTeamConfig()
      }
      const { doc, warnings } = sanitizeLegacyTeamConfig({ crew, pipelines, routes })
      for (const warning of warnings) {
        this.ctx.logger?.warn('dsh-manager team-config migration: %s', warning)
      }
      return doc
    } finally {
      await Promise.allSettled([crewDom.close(), pipelineDom.close(), routeDom.close()])
    }
  }

  private async startWatcher(): Promise<void> {
    const dir = dirname(this.filePath)
    const targetName = basename(this.filePath)
    await mkdir(dir, { recursive: true })
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (this.closed) return
        if (filename !== null && filename !== undefined && String(filename) !== targetName) return
        if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = undefined
          if (!this.closed) void this.reloadFromDisk()
        }, this.debounceMs)
      })
      this.watcher.on('error', (error) => {
        this.ctx.logger?.warn('dsh-manager team-config watcher error: %s', error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      this.ctx.logger?.warn('dsh-manager team-config watcher unavailable: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private async applyFromDisk(source: 'watch' | 'reload'): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recordFailure(`team-config file missing: ${this.filePath}`)
        return
      }
      this.recordFailure(`failed to read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const hash = sha256(text)
    if (hash === this.lastWrittenHash && this.lastError === undefined) {
      return
    }
    await this.applyYamlText(text, hash, source)
  }

  private async applyYamlText(text: string, hash = sha256(text), _source: 'boot' | 'watch' | 'reload' = 'boot'): Promise<void> {
    try {
      const parsed = parseTeamConfigYaml(text)
      this.doc = parsed
      this.lastWrittenHash = hash
      this.revision += 1
      this.loadedAt = Date.now()
      this.lastError = undefined
      this.lastErrorAt = undefined
      this.emitChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.recordFailure(message)
    }
  }

  private recordFailure(message: string): void {
    this.lastError = message
    this.lastErrorAt = Date.now()
    this.revision += 1
    this.ctx.logger?.warn('dsh-manager team-config validation failed (keeping previous valid config): %s', message)
    this.emitChange()
  }

  private emitChange(): void {
    const current = this.status()
    for (const listener of this.listeners) {
      try {
        listener(current)
      } catch {
        // Listener errors never break the config store.
      }
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }
}

export default DshManagerTeamConfig
