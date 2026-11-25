import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditStore, type RequestAuditRecord } from '../src/audit.ts'

describe('AuditStore', () => {
  let tmpDir: string
  let auditPath: string
  const logger = { warn: () => {} }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dsh-audit-test-'))
    auditPath = join(tmpDir, 'audit.json')
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  const sampleRecord = (overrides: Partial<RequestAuditRecord> = {}): RequestAuditRecord => ({
    id: `req_${Date.now()}_${Math.random()}`,
    timestamp: Date.now(),
    targetLanguage: 'zh-CN',
    provider: 'p',
    model: 'm',
    totalItems: 4,
    cachedItems: 3,
    modelItems: 1,
    status: 'partial_cache',
    durationMs: 350,
    aiDurationMs: 320,
    attempts: 1,
    reasoned: false,
    items: [
      { id: '1', source: 'a', translation: '甲', fromCache: true },
      { id: '2', source: 'b', translation: '乙', fromCache: true },
      { id: '3', source: 'c', translation: '丙', fromCache: true },
      { id: '4', source: 'd', translation: '丁', fromCache: false },
    ],
    ...overrides,
  })

  it('starts empty when file does not exist', () => {
    const store = new AuditStore(auditPath, logger)
    expect(store.size()).toBe(0)
    const list = store.list()
    expect(list.total).toBe(0)
    expect(list.records).toHaveLength(0)
    expect(list.summary.totalRequests).toBe(0)
    expect(list.summary.overallHitRate).toBe(0)
  })

  it('adds and persists records, computing accurate summaries', () => {
    const store = new AuditStore(auditPath, logger)
    store.addRecord(sampleRecord({
      totalItems: 10,
      cachedItems: 10,
      modelItems: 0,
      status: 'full_cache',
      durationMs: 0,
      aiDurationMs: 0,
    }))
    store.addRecord(sampleRecord({
      totalItems: 10,
      cachedItems: 0,
      modelItems: 10,
      status: 'model_only',
      durationMs: 500,
      aiDurationMs: 480,
    }))

    expect(store.size()).toBe(2)
    const { summary, records } = store.list()
    expect(records).toHaveLength(2)
    expect(summary.totalRequests).toBe(2)
    expect(summary.totalItems).toBe(20)
    expect(summary.totalCachedItems).toBe(10)
    expect(summary.totalModelItems).toBe(10)
    expect(summary.overallHitRate).toBe(0.5)
    expect(summary.totalDurationMs).toBe(500)
    expect(summary.totalAiDurationMs).toBe(480)

    // Verify persistence by reloading
    const reloaded = new AuditStore(auditPath, logger)
    expect(reloaded.size()).toBe(2)
    expect(reloaded.list().summary.totalItems).toBe(20)
  })

  it('supports pagination via limit and offset', () => {
    const store = new AuditStore(auditPath, logger)
    for (let i = 0; i < 15; i += 1) {
      store.addRecord(sampleRecord({ id: `req_${i}` }))
    }

    const page1 = store.list(5, 0)
    expect(page1.records).toHaveLength(5)
    expect(page1.total).toBe(15)
    expect(page1.records[0]!.id).toBe('req_14') // newest first

    const page2 = store.list(5, 5)
    expect(page2.records).toHaveLength(5)
    expect(page2.records[0]!.id).toBe('req_9')
  })

  it('clears records cleanly', () => {
    const store = new AuditStore(auditPath, logger)
    store.addRecord(sampleRecord())
    expect(store.size()).toBe(1)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.list().records).toHaveLength(0)

    const reloaded = new AuditStore(auditPath, logger)
    expect(reloaded.size()).toBe(0)
  })
})
