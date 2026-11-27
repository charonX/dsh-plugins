/**
 * Subscription quota / rate-limit parsers and durable snapshot store for
 * `@charonx/dsh-external-agents`.
 *
 * Quota data is strictly separated by real CLI capability:
 * - Antigravity (`agy`): active 0-token probe via `agy -p "/usage" --output-format json`.
 * - Claude Code (`claude`): passive capture from `rate_limit_event` + `claude auth status --json`.
 * - Codex (`codex`): passive/on-demand rate-limit snapshot when installed.
 * - Pi Agent (`pi`): explicitly unsupported (no subscription quota API).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DSH_HOME_DIR_NAME, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import {
  EXTERNAL_AGENT_IDS,
  type AgentAuthStatus,
  type AgentQuotaBucket,
  type AgentQuotaGroup,
  type AgentQuotaSnapshot,
  type AgentQuotaWindow,
  type ExternalAgentId,
} from './types.ts'

interface PersistedQuotaFile {
  readonly version: 1
  readonly quotas: Partial<Record<ExternalAgentId, AgentQuotaSnapshot>>
}

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function isoFromUnixSeconds(raw: unknown): string | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return new Date(raw * 1000).toISOString()
}

function cleanIsoTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const ts = Date.parse(raw)
  if (!Number.isFinite(ts) || ts <= 0) return undefined
  return new Date(ts).toISOString()
}

function normalizeWindow(raw: unknown): AgentQuotaWindow {
  if (raw === '5h' || raw === 'five_hour' || raw === 'session') return '5h'
  if (raw === 'weekly' || raw === 'seven_day') return 'weekly'
  return 'other'
}

/** Parse `agy -p "/usage" --output-format json` stdout into an `AgentQuotaSnapshot`. */
export function parseAgyUsageOutput(raw: string, observedAt = new Date().toISOString()): AgentQuotaSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as Record<string, unknown>
  const command = typeof rec.command === 'object' && rec.command !== null
    ? rec.command as Record<string, unknown>
    : undefined
  const data = command !== undefined && typeof command.data === 'object' && command.data !== null
    ? command.data as Record<string, unknown>
    : undefined
  const rawGroups = data?.groups
  if (!Array.isArray(rawGroups)) return undefined

  const groups: AgentQuotaGroup[] = []
  for (const item of rawGroups) {
    if (typeof item !== 'object' || item === null) continue
    const groupObj = item as Record<string, unknown>
    const name = typeof groupObj.name === 'string' && groupObj.name.trim() !== ''
      ? groupObj.name.trim()
      : 'Quota'
    const description = typeof groupObj.description === 'string' && groupObj.description.trim() !== ''
      ? groupObj.description.trim()
      : undefined
    const rawBuckets = Array.isArray(groupObj.buckets) ? groupObj.buckets : []
    const buckets: AgentQuotaBucket[] = []
    for (const bucketRaw of rawBuckets) {
      if (typeof bucketRaw !== 'object' || bucketRaw === null) continue
      const b = bucketRaw as Record<string, unknown>
      const id = typeof b.id === 'string' && b.id.trim() !== '' ? b.id.trim() : `${name}-${buckets.length}`
      const label = typeof b.name === 'string' && b.name.trim() !== '' ? b.name.trim() : id
      const frac = typeof b.remaining_fraction === 'number' ? clampPercent(b.remaining_fraction * 100) : undefined
      const usedPercent = frac === undefined ? undefined : clampPercent(100 - frac)
      const resetAt = cleanIsoTimestamp(b.reset_time)
      const bucketDesc = typeof b.description === 'string' && b.description.trim() !== '' ? b.description.trim() : undefined
      buckets.push({
        id,
        label,
        window: normalizeWindow(b.window),
        ...(frac === undefined ? {} : { remainingPercent: frac }),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(bucketDesc === undefined ? {} : { description: bucketDesc }),
        ...(frac === undefined ? {} : {
          status: frac <= 0 ? 'rejected' : frac <= 20 ? 'warning' : 'allowed',
        }),
      })
    }
    if (buckets.length > 0) {
      groups.push({
        name,
        ...(description === undefined ? {} : { description }),
        buckets,
      })
    }
  }

  if (groups.length === 0) return undefined
  return {
    status: 'ok',
    source: 'active_cli',
    observedAt,
    groups,
  }
}

function mapClaudeStatus(raw: unknown): 'allowed' | 'warning' | 'rejected' | undefined {
  if (raw === 'allowed') return 'allowed'
  if (raw === 'allowed_warning') return 'warning'
  if (raw === 'rejected') return 'rejected'
  return undefined
}

function claudeWindowMeta(name: string): { readonly id: string; readonly label: string; readonly window: AgentQuotaWindow } | undefined {
  switch (name) {
    case 'five_hour':
      return { id: 'claude-5h', label: '5-Hour Limit', window: '5h' }
    case 'seven_day':
      return { id: 'claude-weekly', label: 'Weekly Limit', window: 'weekly' }
    case 'seven_day_opus':
      return { id: 'claude-weekly-opus', label: 'Weekly Opus Limit', window: 'weekly' }
    case 'seven_day_sonnet':
      return { id: 'claude-weekly-sonnet', label: 'Weekly Sonnet Limit', window: 'weekly' }
    default:
      return undefined
  }
}

/** Parse Claude Code `rate_limit_event.rate_limit_info` into an `AgentQuotaSnapshot`. */
export function parseClaudeRateLimitInfo(
  raw: unknown,
  observedAt = new Date().toISOString(),
): AgentQuotaSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const info = raw as Record<string, unknown>
  const byId = new Map<string, AgentQuotaBucket>()

  const pushWindow = (
    name: string,
    utilizationRaw: unknown,
    resetsAtRaw: unknown,
    statusRaw: unknown,
  ): void => {
    const meta = claudeWindowMeta(name)
    if (meta === undefined) return
    const used = typeof utilizationRaw === 'number' ? clampPercent(utilizationRaw * 100) : undefined
    const remaining = used === undefined ? undefined : clampPercent(100 - used)
    const resetAt = isoFromUnixSeconds(resetsAtRaw)
    const status = mapClaudeStatus(statusRaw)
    if (used === undefined && resetAt === undefined && status === undefined) return
    const existing = byId.get(meta.id)
    byId.set(meta.id, {
      id: meta.id,
      label: meta.label,
      window: meta.window,
      ...(remaining !== undefined ? { remainingPercent: remaining } : existing?.remainingPercent !== undefined ? { remainingPercent: existing.remainingPercent } : {}),
      ...(used !== undefined ? { usedPercent: used } : existing?.usedPercent !== undefined ? { usedPercent: existing.usedPercent } : {}),
      ...(resetAt !== undefined ? { resetAt } : existing?.resetAt !== undefined ? { resetAt: existing.resetAt } : {}),
      ...(status !== undefined ? { status } : existing?.status !== undefined ? { status: existing.status } : {}),
    })
  }

  if (typeof info.rateLimitType === 'string') {
    pushWindow(info.rateLimitType, info.utilization, info.resetsAt, info.status)
  }

  if (typeof info.unifiedWindows === 'object' && info.unifiedWindows !== null) {
    for (const [name, winRaw] of Object.entries(info.unifiedWindows as Record<string, unknown>)) {
      if (typeof winRaw !== 'object' || winRaw === null) continue
      const win = winRaw as Record<string, unknown>
      pushWindow(name, win.utilization, win.resetsAt, win.status ?? (name === info.rateLimitType ? info.status : undefined))
    }
  }

  const buckets = [...byId.values()]
  if (buckets.length === 0) return undefined
  return {
    status: 'ok',
    source: 'passive_stream',
    observedAt,
    groups: [{
      name: 'Claude Subscription',
      buckets,
    }],
  }
}

/**
 * Parse non-secret auth status from `claude auth status --json`.
 * Never reads or returns credential/token/email strings if not needed; exposes only
 * `authenticated`, `method`, and `plan`.
 */
export function parseClaudeAuthStatus(raw: string): AgentAuthStatus | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const rec = parsed as Record<string, unknown>
  const authenticated = typeof rec.loggedIn === 'boolean' ? rec.loggedIn : undefined
  const method = typeof rec.authMethod === 'string' && rec.authMethod.trim() !== '' ? rec.authMethod.trim() : undefined
  const plan = typeof rec.subscriptionType === 'string' && rec.subscriptionType.trim() !== ''
    ? rec.subscriptionType.trim()
    : typeof rec.plan === 'string' && rec.plan.trim() !== ''
      ? rec.plan.trim()
      : undefined
  if (authenticated === undefined && method === undefined && plan === undefined) return undefined
  const parts: string[] = []
  if (authenticated === true) parts.push('Logged in')
  else if (authenticated === false) parts.push('Not logged in')
  if (plan !== undefined) parts.push(plan)
  else if (method !== undefined) parts.push(method)
  return {
    ...(authenticated === undefined ? {} : { authenticated }),
    ...(method === undefined ? {} : { method }),
    ...(plan === undefined ? {} : { plan }),
    ...(parts.length > 0 ? { summary: parts.join(' · ') } : {}),
  }
}

export class ExternalQuotaStore {
  private readonly snapshots = new Map<ExternalAgentId, AgentQuotaSnapshot>()

  constructor(private readonly filePath: string = ExternalQuotaStore.defaultFilePath()) {
    this.load()
  }

  static defaultFilePath(sessionsStoreFile?: string): string {
    if (sessionsStoreFile !== undefined && sessionsStoreFile !== '') {
      return join(dirname(sessionsStoreFile), 'quotas.json')
    }
    const homeDir = process.env[DSH_HOME_ENV] || join(homedir(), DSH_HOME_DIR_NAME)
    return join(homeDir, 'external-agents', 'quotas.json')
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedQuotaFile>
      if (raw.version !== 1 || raw.quotas == null || typeof raw.quotas !== 'object') return
      for (const id of EXTERNAL_AGENT_IDS) {
        const entry = raw.quotas[id]
        if (entry != null && typeof entry.status === 'string') {
          this.snapshots.set(id, entry)
        }
      }
    } catch {
      // Corrupt quota cache starts clean rather than blocking host startup.
    }
  }

  private save(): void {
    const quotas: Partial<Record<ExternalAgentId, AgentQuotaSnapshot>> = {}
    for (const id of EXTERNAL_AGENT_IDS) {
      const snap = this.snapshots.get(id)
      if (snap !== undefined) {
        quotas[id] = snap
      }
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: PersistedQuotaFile = { version: 1, quotas }
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.filePath)
  }

  get(agentId: ExternalAgentId): AgentQuotaSnapshot | undefined {
    return this.snapshots.get(agentId)
  }

  set(agentId: ExternalAgentId, snapshot: AgentQuotaSnapshot): AgentQuotaSnapshot {
    this.snapshots.set(agentId, snapshot)
    this.save()
    return snapshot
  }

  getAll(): Partial<Record<ExternalAgentId, AgentQuotaSnapshot>> {
    const out: Partial<Record<ExternalAgentId, AgentQuotaSnapshot>> = {}
    for (const id of EXTERNAL_AGENT_IDS) {
      const snap = this.snapshots.get(id)
      if (snap !== undefined) out[id] = snap
    }
    return out
  }
}
