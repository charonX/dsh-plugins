import { describe, it, expect, vi, afterAll } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequestHandler } from '../src/http/routes.js'
import { AutoloopKernel } from '../src/core/kernel.js'
import { JournalStore } from '../src/core/store.js'
import { IntentRouter } from '../src/core/router.js'

function createMockReqRes(method: string, url: string, body?: unknown) {
  const req = new EventEmitter() as unknown as IncomingMessage
  ;(req as any).method = method
  ;(req as any).url = url

  const resState = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
  }

  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      resState.statusCode = status
      if (headers) Object.assign(resState.headers, headers)
    },
    end: (chunk?: string) => {
      if (chunk) resState.body += chunk
    },
  } as unknown as ServerResponse

  return { req, res, resState }
}

describe('HTTP routes', () => {
  const defaultWorkspacePath = '/mock/workspace'
  // A temp journal keeps the suite from writing a stray ':memory:' file into the repo.
  const tempDir = mkdtempSync(join(tmpdir(), 'autoloop-routes-test-'))
  const store = new JournalStore(join(tempDir, 'journal.jsonl'))
  const router = new IntentRouter({ defaultWorkspacePath })
  const kernel = new AutoloopKernel({ store, router, defaultWorkspacePath })

  afterAll(() => {
    kernel.stop()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('handles GET /api/autoloop/workspaces with fallback when registry is empty', async () => {
    const mockCtx = {
      get: vi.fn().mockReturnValue(undefined),
    } as any

    const handler = createRequestHandler({
      prefix: '/api/autoloop',
      kernel,
      ctx: mockCtx,
      defaultWorkspacePath,
    })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/workspaces')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(200)
    const json = JSON.parse(resState.body)
    expect(json.workspaces).toHaveLength(1)
    expect(json.workspaces[0].path).toBe('/mock/workspace')
  })

  it('handles GET /api/autoloop/workspaces when registry has entries', async () => {
    const mockRegistry = {
      list: () => [
        { id: 'ws1', path: '/code/project1', title: 'Project One', sessionIds: ['s1', 's2'] },
      ],
      archivedSessionIds: ['s2'],
    }

    const mockCtx = {
      get: vi.fn((key: string) => {
        if (key === 'workspaceRegistry') return mockRegistry
        return undefined
      }),
    } as any

    const handler = createRequestHandler({
      prefix: '/api/autoloop',
      kernel,
      ctx: mockCtx,
      defaultWorkspacePath,
    })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/workspaces')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(200)
    const json = JSON.parse(resState.body)
    expect(json.workspaces).toHaveLength(1)
    expect(json.workspaces[0].title).toBe('Project One')
    // s2 is archived, so only s1 should remain
    expect(json.workspaces[0].sessions).toHaveLength(1)
    expect(json.workspaces[0].sessions[0].id).toBe('s1')
  })

  it('handles GET /api/autoloop/snapshot', async () => {
    const mockCtx = { get: vi.fn() } as any
    const handler = createRequestHandler({
      prefix: '/api/autoloop',
      kernel,
      ctx: mockCtx,
      defaultWorkspacePath,
    })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/snapshot')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(200)
    const json = JSON.parse(resState.body)
    expect(json).toHaveProperty('active')
    expect(json).toHaveProperty('done')
    expect(json).toHaveProperty('doneTotal')
    expect(json).toHaveProperty('stats')
  })

  it('handles GET /api/autoloop/models with fallback when services are empty', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({
      prefix: '/api/autoloop',
      kernel,
      ctx: mockCtx,
      defaultWorkspacePath,
    })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/models')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(200)
    const json = JSON.parse(resState.body)
    expect(json.groups).toBeDefined()
    expect(json.groups.length).toBeGreaterThan(0)
    expect(json.groups[0].models[0].id).toBe('deepseek-chat')
  })

  it('handles GET /api/autoloop/models querying live sessionController.modelCatalog', async () => {
    const mockCatalog = {
      default: { provider: 'custom-prov', model: 'custom-model' },
      groups: [
        {
          id: 'custom-prov',
          name: 'Custom Provider',
          models: [{ id: 'custom-model', name: 'Custom Model', badge: 'Pro' }],
        },
      ],
    }
    const mockCtx = {
      get: vi.fn((key: string) => {
        if (key === 'sessionController') {
          return { modelCatalog: vi.fn().mockResolvedValue(mockCatalog) }
        }
        return undefined
      }),
    } as any

    const handler = createRequestHandler({
      prefix: '/api/autoloop',
      kernel,
      ctx: mockCtx,
      defaultWorkspacePath,
    })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/models')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(200)
    const json = JSON.parse(resState.body)
    expect(json.defaultSelection.model).toBe('custom-model')
    expect(json.groups[0].name).toBe('Custom Provider')
    expect(json.groups[0].models[0].badge).toBe('Pro')
  })
  it('rejects an unhonorable schedule with 400 instead of running immediately', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({ prefix: '/api/autoloop', kernel, ctx: mockCtx, defaultWorkspacePath })

    const { req, res, resState } = createMockReqRes('POST', '/api/autoloop/events')
    const promise = handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({
      summary: '定时任务',
      payload: { scheduleMode: 'scheduled' },
    })))
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(400)
    const json = JSON.parse(resState.body)
    expect(json.code).toBe('invalid_schedule')
    expect(json.error).toContain('scheduledAt')
  })

  it('exposes the configured window through the snapshot', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({ prefix: '/api/autoloop', kernel, ctx: mockCtx, defaultWorkspacePath })

    const { req, res, resState } = createMockReqRes('GET', '/api/autoloop/snapshot')
    const promise = handler(req, res)
    req.emit('end')
    await promise

    const json = JSON.parse(resState.body)
    expect(json.offpeak.start).toBe('23:00')
    expect(json.offpeak.end).toBe('07:00')
    expect(json.limits.maxConcurrent).toBe(2)
  })

  it('answers 409 when retrying a ticket that is not retryable', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({ prefix: '/api/autoloop', kernel, ctx: mockCtx, defaultWorkspacePath })

    const { req, res, resState } = createMockReqRes('POST', '/api/autoloop/tickets/retry')
    const promise = handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ ticketId: 'does-not-exist' })))
    req.emit('end')
    await promise

    expect(resState.statusCode).toBe(409)
  })
  it('rejects an unhonorable reschedule with 400 and an unknown ticket with 409', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({ prefix: '/api/autoloop', kernel, ctx: mockCtx, defaultWorkspacePath })

    // No executor on this kernel, so the created ticket stays queued.
    const create = createMockReqRes('POST', '/api/autoloop/events')
    const createPromise = handler(create.req, create.res)
    create.req.emit('data', Buffer.from(JSON.stringify({
      threadId: 'th-reschedule-route',
      summary: '调整执行时机',
    })))
    create.req.emit('end')
    await createPromise
    expect(create.resState.statusCode).toBe(201)
    const created = JSON.parse(create.resState.body)

    const bad = createMockReqRes('POST', '/api/autoloop/tickets/schedule')
    const badPromise = handler(bad.req, bad.res)
    bad.req.emit('data', Buffer.from(JSON.stringify({
      ticketId: created.ticketId,
      scheduleMode: 'scheduled',
    })))
    bad.req.emit('end')
    await badPromise
    expect(bad.resState.statusCode).toBe(400)
    expect(JSON.parse(bad.resState.body).code).toBe('invalid_schedule')

    const missing = createMockReqRes('POST', '/api/autoloop/tickets/schedule')
    const missingPromise = handler(missing.req, missing.res)
    missing.req.emit('data', Buffer.from(JSON.stringify({ ticketId: 'nope', scheduleMode: 'immediate' })))
    missing.req.emit('end')
    await missingPromise
    expect(missing.resState.statusCode).toBe(409)
  })
  it('honors the Done page query and tolerates malformed bounds', async () => {
    const mockCtx = { get: vi.fn().mockReturnValue(undefined) } as any
    const handler = createRequestHandler({ prefix: '/api/autoloop', kernel, ctx: mockCtx, defaultWorkspacePath })

    const beyond = createMockReqRes('GET', '/api/autoloop/snapshot?doneLimit=5&doneOffset=999')
    const beyondPromise = handler(beyond.req, beyond.res)
    beyond.req.emit('end')
    await beyondPromise
    expect(beyond.resState.statusCode).toBe(200)
    const beyondJson = JSON.parse(beyond.resState.body)
    expect(beyondJson.done).toEqual([])
    expect(typeof beyondJson.doneTotal).toBe('number')

    // Malformed bounds fall back to the defaults instead of failing the poll.
    const malformed = createMockReqRes('GET', '/api/autoloop/snapshot?doneLimit=abc&doneOffset=-1')
    const malformedPromise = handler(malformed.req, malformed.res)
    malformed.req.emit('end')
    await malformedPromise
    expect(malformed.resState.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(malformed.resState.body).done)).toBe(true)
  })
})
