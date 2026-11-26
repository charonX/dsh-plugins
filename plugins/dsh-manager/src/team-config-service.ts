/**
 * Declarative YAML single-source-of-truth (SSOT) store for Flow IR (`team-config.yaml`)
 * with atomic writes, one-time migration from legacy storage-domain tables and v1/v2 YAML,
 * anti-echo file watching, and all-or-nothing validation on hot reload.
 */
import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { legacyCrewDomain, legacyPipelineDomain, legacyRouteDomain } from './team-config/legacy-domains.ts'
import type { HostSkillsPort } from './dispatch/workspace-skills.ts'
import type { FlowDef } from './flow/flow-ir.ts'
import { discoverAndCompileDefaultPlaybooks } from './flow/playbook-catalog.ts'
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
import { teamConfigImportYamlInputSchema, type TeamConfigImportYamlInput } from './team-config/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Unified hot-reloading YAML configuration store for Flow IR. */
    dshManagerTeamConfig: DshManagerTeamConfig
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Config import or validation failed. */
    'dshManager/prompt-invalid': { readonly reason: string }
    /** Flow config validation failed. */
    'dshManager/team-config-invalid': { readonly reason: string }
  }
}

export interface TeamConfigOptions {
  /** Override YAML file path; defaults to `<DSH_HOME>/dsh-manager/team-config.yaml`. */
  filePath?: string
  /** File-watch debounce in milliseconds; defaults to 60ms. */
  debounceMs?: number
  /** Working directory for discovering workspace `skills/playbooks/*.md` defaults on fresh install. */
  playbookCwd?: string
  /** Automatically seed default Playbook flows when no `team-config.yaml` and no legacy storage exist (default: `true`). */
  autoSeedPlaybooks?: boolean
}

export const TeamConfigOptions: z<TeamConfigOptions> = z.object({
  filePath: z.string(),
  debounceMs: z.natural(),
  playbookCwd: z.string(),
  autoSeedPlaybooks: z.boolean(),
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
  static inject = ['storageDomain']

  static Config: z<TeamConfigOptions> = TeamConfigOptions

  private readonly filePath: string
  private readonly debounceMs: number
  private readonly playbookCwdConfig: string | undefined
  private readonly autoSeedPlaybooks: boolean
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
    this.playbookCwdConfig = config.playbookCwd
    this.autoSeedPlaybooks = config.autoSeedPlaybooks ?? true
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

    this.ctx.inject(['tools'], (toolsCtx) => {
      for (const tool of createTeamConfigTools(this)) {
        toolsCtx.effect(
          () => (toolsCtx as unknown as { tools: { register(def: unknown): () => void } }).tools.register(tool),
          `dsh-manager: register ${tool.name}`,
        )
      }
    })
  }

  /** Configured flows sorted by creation order. */
  flows(): readonly FlowDef[] {
    return [...this.doc.flows].sort((left, right) => left.createdAt - right.createdAt)
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

  @Remote
  async teamConfigStatus(): Promise<TeamConfigStatusView> {
    return this.status()
  }

  @Remote
  async teamConfigReload(): Promise<TeamConfigStatusView> {
    return await this.reloadFromDisk()
  }

  @Remote
  async teamConfigExportYaml(): Promise<{ readonly yaml: string; readonly status: TeamConfigStatusView }> {
    return {
      yaml: serializeTeamConfigYaml(this.doc),
      status: this.status(),
    }
  }

  @Remote
  async teamConfigImportYaml(rawInput: TeamConfigImportYamlInput): Promise<{
    readonly status: TeamConfigStatusView
    readonly flows: readonly FlowDef[]
    readonly yaml: string
  }> {
    const input = teamConfigImportYamlInputSchema.parse(rawInput)
    try {
      const parsed = parseTeamConfigYaml(input.yaml)
      const next = await this.mutate(() => parsed)
      return {
        status: this.status(),
        flows: this.flows(),
        yaml: serializeTeamConfigYaml(next),
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('dshManager/team-config-invalid', reason, { reason })
    }
  }

  /** Atomically transform, validate, persist to YAML, and publish a config mutation. */
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

    const migrated = await this.readLegacyDomains()
    const doc = migrated.hadLegacyRecords || !this.autoSeedPlaybooks
      ? migrated.doc
      : await this.seedDefaultFlows()
    const yamlText = serializeTeamConfigYaml(doc)
    const hash = sha256(yamlText)
    await writeTextAtomic(this.filePath, yamlText)
    this.lastWrittenHash = hash
    this.doc = doc
    this.loadedAt = Date.now()
    this.lastError = undefined
    this.lastErrorAt = undefined
  }

  private resolvePlaybookCwd(): string {
    if (this.playbookCwdConfig !== undefined && this.playbookCwdConfig.trim() !== '') {
      return this.playbookCwdConfig
    }
    const reg = (this.ctx as unknown as {
      get?: (key: string) => { list?: () => readonly { readonly path?: string }[] } | undefined
    }).get?.('workspaceRegistry')
    const firstPath = reg?.list?.()?.[0]?.path
    return firstPath !== undefined && firstPath !== '' ? firstPath : process.cwd()
  }

  private async seedDefaultFlows(): Promise<TeamConfigDocument> {
    try {
      const hostSkills = (this.ctx as unknown as { get?: (key: string) => unknown }).get?.('skills') as HostSkillsPort | undefined
      const compiled = await discoverAndCompileDefaultPlaybooks({
        cwd: this.resolvePlaybookCwd(),
        hostSkills,
      })
      if (compiled.length === 0) return emptyTeamConfig()
      return validateTeamConfigDocument({
        version: 3,
        flows: compiled.map(entry => entry.flow),
      })
    } catch (error) {
      this.ctx.logger?.warn('dsh-manager default playbook auto-seed failed (falling back to empty config): %s', error instanceof Error ? error.message : String(error))
      return emptyTeamConfig()
    }
  }

  private async readLegacyDomains(): Promise<{ readonly doc: TeamConfigDocument; readonly hadLegacyRecords: boolean }> {
    const crewDom = await this.ctx.storageDomain.open(legacyCrewDomain)
    const pipelineDom = await this.ctx.storageDomain.open(legacyPipelineDomain)
    const routeDom = await this.ctx.storageDomain.open(legacyRouteDomain)
    try {
      const crew = [...crewDom.table('members').entries()].map(([, record]) => record)
      const pipelines = [...pipelineDom.table('pipelines').entries()].map(([, record]) => record)
      const routes = [...routeDom.table('rules').entries()].map(([, record]) => record)
      if (crew.length === 0 && pipelines.length === 0 && routes.length === 0) {
        return { doc: emptyTeamConfig(), hadLegacyRecords: false }
      }
      const { doc, warnings } = sanitizeLegacyTeamConfig({ crew, pipelines, routes })
      for (const warning of warnings) {
        this.ctx.logger?.warn('dsh-manager team-config migration: %s', warning)
      }
      return { doc, hadLegacyRecords: true }
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
