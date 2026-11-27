/**
 * Durable per-DSH-session agent bindings, per-session external model/effort
 * selections, native fallback model memory, and exclusive run locks preventing
 * concurrent external-session writes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DSH_HOME_DIR_NAME, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import type { ExternalAgentId, ExternalTaskState, SavedModelSelection, SessionAgentId } from './types.ts'

export interface PersistedSessionBinding {
  readonly agentId: SessionAgentId
  readonly externalSessionId?: string
  readonly nativeFallbackModel?: SavedModelSelection
  readonly model?: string
  readonly reasoningEffort?: string | null
  readonly permissionMode?: string
  readonly updatedAt: string
}

interface PersistedFileShape {
  readonly version: 1
  readonly lastNativeModel?: SavedModelSelection
  readonly sessions: Readonly<Record<string, PersistedSessionBinding>>
}

export class ConcurrentExternalSessionError extends Error {
  readonly code = 'external-agent/busy'
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrentExternalSessionError'
  }
}

export class ExternalSessionStore {
  private readonly bindings = new Map<string, PersistedSessionBinding>()
  private readonly activeDshSessions = new Set<string>()
  private readonly activeExternalSessions = new Set<string>()
  private readonly backgroundActiveSessions = new Set<string>()
  private readonly tasksBySession = new Map<string, Map<string, ExternalTaskState>>()
  private lastNativeModel: SavedModelSelection | undefined

  constructor(private readonly filePath: string = ExternalSessionStore.defaultFilePath()) {
    this.load()
  }

  static defaultFilePath(): string {
    const homeDir = process.env[DSH_HOME_ENV] || join(homedir(), DSH_HOME_DIR_NAME)
    return join(homeDir, 'external-agents', 'sessions.json')
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedFileShape>
      if (raw.version !== 1 || typeof raw.sessions !== 'object' || raw.sessions === null) return
      if (raw.lastNativeModel !== undefined && typeof raw.lastNativeModel.provider === 'string' && typeof raw.lastNativeModel.model === 'string') {
        this.lastNativeModel = raw.lastNativeModel
      }
      for (const [sessionId, entry] of Object.entries(raw.sessions)) {
        if (entry != null && typeof entry.agentId === 'string') {
          this.bindings.set(sessionId, entry)
        }
      }
    } catch {
      // Corrupt store starts clean rather than blocking host startup.
    }
  }

  private save(): void {
    const sessions: Record<string, PersistedSessionBinding> = {}
    for (const [sessionId, binding] of this.bindings.entries()) {
      sessions[sessionId] = binding
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: PersistedFileShape = {
      version: 1,
      ...(this.lastNativeModel === undefined ? {} : { lastNativeModel: this.lastNativeModel }),
      sessions,
    }
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.filePath)
  }

  getLastNativeModel(): SavedModelSelection | undefined {
    return this.lastNativeModel
  }

  rememberLastNativeModel(selection: SavedModelSelection): void {
    if (selection.provider.startsWith('ext-')) return
    if (
      this.lastNativeModel?.provider === selection.provider
      && this.lastNativeModel?.model === selection.model
      && this.lastNativeModel?.reasoningEffort === selection.reasoningEffort
    ) {
      return
    }
    this.lastNativeModel = selection
    this.save()
  }

  get(sessionId: string): PersistedSessionBinding | undefined {
    return this.bindings.get(sessionId)
  }

  setAgent(
    sessionId: string,
    agentId: SessionAgentId,
    options?: {
      readonly nativeFallbackModel?: SavedModelSelection
      readonly externalSessionId?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly permissionMode?: string
    },
  ): PersistedSessionBinding {
    const existing = this.bindings.get(sessionId)
    const fallback = options?.nativeFallbackModel ?? existing?.nativeFallbackModel
    const sameAgent = existing?.agentId === agentId
    const nextExternal = agentId === 'native'
      ? undefined
      : (options?.externalSessionId ?? (sameAgent ? existing?.externalSessionId : undefined))
    const nextModel = agentId === 'native'
      ? undefined
      : (options?.model ?? (sameAgent ? existing?.model : undefined))
    const nextEffort = agentId === 'native'
      ? undefined
      : (options?.reasoningEffort ?? (sameAgent ? existing?.reasoningEffort : undefined))
    const nextPermission = agentId === 'native'
      ? undefined
      : (options?.permissionMode ?? (sameAgent ? existing?.permissionMode : undefined))
    const next: PersistedSessionBinding = {
      agentId,
      ...(nextExternal === undefined ? {} : { externalSessionId: nextExternal }),
      ...(fallback === undefined ? {} : { nativeFallbackModel: fallback }),
      ...(nextModel === undefined ? {} : { model: nextModel }),
      ...(nextEffort === undefined ? {} : { reasoningEffort: nextEffort }),
      ...(nextPermission === undefined ? {} : { permissionMode: nextPermission }),
      updatedAt: new Date().toISOString(),
    }
    this.bindings.set(sessionId, next)
    this.save()
    return next
  }

  setModelSelection(
    sessionId: string,
    agentId: ExternalAgentId,
    selection: {
      readonly model?: string
      readonly reasoningEffort?: string | null
    },
  ): PersistedSessionBinding {
    const existing = this.bindings.get(sessionId)
    const sameAgent = existing?.agentId === agentId
    const nextModel = selection.model !== undefined
      ? selection.model
      : (sameAgent ? existing?.model : undefined)
    const nextEffort = selection.reasoningEffort !== undefined
      ? selection.reasoningEffort
      : (sameAgent ? existing?.reasoningEffort : undefined)
    const next: PersistedSessionBinding = {
      agentId,
      ...(sameAgent && existing?.externalSessionId !== undefined ? { externalSessionId: existing.externalSessionId } : {}),
      ...(existing?.nativeFallbackModel === undefined ? {} : { nativeFallbackModel: existing.nativeFallbackModel }),
      ...(nextModel === undefined ? {} : { model: nextModel }),
      ...(nextEffort === undefined ? {} : { reasoningEffort: nextEffort }),
      ...(sameAgent && existing?.permissionMode !== undefined ? { permissionMode: existing.permissionMode } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.bindings.set(sessionId, next)
    this.save()
    return next
  }

  setPermissionMode(sessionId: string, agentId: ExternalAgentId, permissionMode: string): PersistedSessionBinding {
    const existing = this.bindings.get(sessionId)
    const sameAgent = existing?.agentId === agentId
    const next: PersistedSessionBinding = {
      agentId,
      ...(sameAgent && existing?.externalSessionId !== undefined
        ? { externalSessionId: existing.externalSessionId }
        : {}),
      ...(existing?.nativeFallbackModel === undefined ? {} : { nativeFallbackModel: existing.nativeFallbackModel }),
      ...(sameAgent && existing?.model !== undefined ? { model: existing.model } : {}),
      ...(sameAgent && existing?.reasoningEffort !== undefined ? { reasoningEffort: existing.reasoningEffort } : {}),
      permissionMode,
      updatedAt: new Date().toISOString(),
    }
    this.bindings.set(sessionId, next)
    this.save()
    return next
  }

  recordExternalSessionId(sessionId: string, agentId: ExternalAgentId, externalSessionId: string): void {
    const existing = this.bindings.get(sessionId)
    if (existing?.agentId === agentId && existing.externalSessionId === externalSessionId) return
    const sameAgent = existing?.agentId === agentId
    this.bindings.set(sessionId, {
      agentId,
      externalSessionId,
      ...(existing?.nativeFallbackModel === undefined ? {} : { nativeFallbackModel: existing.nativeFallbackModel }),
      ...(sameAgent && existing?.model !== undefined ? { model: existing.model } : {}),
      ...(sameAgent && existing?.reasoningEffort !== undefined ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(sameAgent && existing?.permissionMode !== undefined ? { permissionMode: existing.permissionMode } : {}),
      updatedAt: new Date().toISOString(),
    })
    this.save()
  }

  isRunning(sessionId: string): boolean {
    return this.activeDshSessions.has(sessionId)
  }

  getTasks(sessionId: string): readonly ExternalTaskState[] {
    const map = this.tasksBySession.get(sessionId)
    if (map === undefined || map.size === 0) return []
    return [...map.values()]
  }

  upsertTask(sessionId: string, task: ExternalTaskState): void {
    let map = this.tasksBySession.get(sessionId)
    if (map === undefined) {
      map = new Map()
      this.tasksBySession.set(sessionId, map)
    }
    if (task.toolUseId !== undefined) {
      for (const [existingKey, existing] of map.entries()) {
        if (existingKey !== task.taskId && existing.toolUseId === task.toolUseId) {
          map.delete(existingKey)
        }
      }
    }
    map.set(task.taskId, task)
  }

  updateTask(
    sessionId: string,
    key: string,
    patch: Partial<Omit<ExternalTaskState, 'taskId' | 'startedAt'>>,
  ): void {
    const map = this.tasksBySession.get(sessionId)
    if (map === undefined) return
    const target = map.get(key) ?? [...map.values()].find(item => item.toolUseId === key)
    if (target === undefined) return
    map.set(target.taskId, {
      ...target,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    })
  }

  clearTasks(sessionId: string): void {
    this.tasksBySession.delete(sessionId)
  }

  setBackgroundActive(sessionId: string, active: boolean): void {
    if (active) {
      this.backgroundActiveSessions.add(sessionId)
    } else {
      this.backgroundActiveSessions.delete(sessionId)
    }
  }

  isBackgroundActive(sessionId: string): boolean {
    return this.backgroundActiveSessions.has(sessionId)
  }

  clearBackgroundState(sessionId: string): void {
    this.backgroundActiveSessions.delete(sessionId)
    this.tasksBySession.delete(sessionId)
  }

  /**
   * Acquire an exclusive lock on both the DSH session and (if known) its bound
   * external CLI conversation so concurrent turns never race writes.
   */
  acquireRun(dshSessionId: string, externalSessionId?: string): () => void {
    if (this.activeDshSessions.has(dshSessionId)) {
      throw new ConcurrentExternalSessionError(`Session ${dshSessionId} already has an external agent turn running`)
    }
    if (externalSessionId !== undefined && this.activeExternalSessions.has(externalSessionId)) {
      throw new ConcurrentExternalSessionError(
        `External conversation ${externalSessionId} is currently busy; concurrent writes are rejected`,
      )
    }
    this.activeDshSessions.add(dshSessionId)
    if (!this.backgroundActiveSessions.has(dshSessionId)) {
      this.tasksBySession.delete(dshSessionId)
    }
    if (externalSessionId !== undefined) this.activeExternalSessions.add(externalSessionId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeDshSessions.delete(dshSessionId)
      if (!this.backgroundActiveSessions.has(dshSessionId)) {
        this.tasksBySession.delete(dshSessionId)
      }
      if (externalSessionId !== undefined) this.activeExternalSessions.delete(externalSessionId)
    }
  }
}
