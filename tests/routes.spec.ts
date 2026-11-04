import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
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
  const store = new JournalStore(':memory:')
  const router = new IntentRouter({ defaultWorkspacePath })
  const kernel = new AutoloopKernel({ store, router, defaultWorkspacePath })

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
    expect(json).toHaveProperty('tickets')
    expect(json).toHaveProperty('stats')
  })
})
