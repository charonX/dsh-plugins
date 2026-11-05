import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createRequestHandler, matchSegments, type HttpDeps } from '../src/http.ts'
import { PrefsStore } from '../src/prefs.ts'
import { BatchArchive } from '../src/records.ts'
import { ROUTE_PREFIX, type TranslatePrefs } from '../src/shared/api.ts'

/** Collects warnings instead of printing them. */
const logger = { warn: (): void => {} }

/**
 * Serve one plugin handler on an ephemeral port.
 * @param deps - route dependencies.
 * @returns the base URL and a disposer.
 */
async function serve(deps: HttpDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = createRequestHandler(deps)
  const server: Server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${String(port)}${ROUTE_PREFIX}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/**
 * Stand-in runtime answering one batch with the reference translation.
 * @param capture - receives the prompt the engine dispatched.
 * @returns an LLM runtime shaped like the Host service.
 */
function fakeLlm(capture: { instruction?: string } = {}): LlmRuntime {
  return {
    prepareCall: async (config: Record<string, unknown>) => {
      const resolved = { ...config, reasoningEffort: ReasoningEffortId('off') }
      return {
        config: resolved,
        stream: (options: { messages?: readonly { content: readonly { text: string }[] }[] }) => {
          capture.instruction = options.messages?.[0]?.content[0]?.text
          return (async function* produce() {
            yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
            yield { type: 'text-delta' as const, index: 0, text: '{"items":[{"id":"a","text":"甲"}]}' }
            yield { type: 'finish' as const, reason: { kind: 'stop' } }
          })()
        },
      }
    },
  } as unknown as LlmRuntime
}

const prefs: TranslatePrefs = { targetLanguage: 'zh-CN', followDefaultModel: true }

/**
 * Build route dependencies over fakes.
 * @param overrides - fields to replace for one case.
 * @returns the dependency set.
 */
function deps(overrides: Partial<HttpDeps> = {}): HttpDeps {
  return {
    prefix: ROUTE_PREFIX,
    limits: { maxItemsPerBatch: 2, maxCharsPerItem: 10, maxOutputTokens: 512, requestTimeoutMs: 5000 },
    prefs: { read: () => prefs, update: (patch: Partial<TranslatePrefs>) => ({ ...prefs, ...patch }) } as unknown as PrefsStore,
    archive: { write: () => true, read: () => undefined } as unknown as BatchArchive,
    logger,
    trustedHosts: () => undefined,
    llm: () => ({ runtime: fakeLlm() }),
    defaultSelection: () => ({ provider: 'p', model: 'm' }),
    sessionSelection: () => undefined,
    catalog: async () => [{
      id: 'p',
      name: 'P',
      models: [{ id: 'm', name: 'M', efforts: ['off'], canDisableThinking: true }],
    }],
    recordPointer: async () => true,
    ...overrides,
  }
}

let running: { close: () => Promise<void> } | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('matchSegments', () => {
  it('splits the path below the prefix', () => {
    expect(matchSegments(`${ROUTE_PREFIX}/api/state`, ROUTE_PREFIX)).toEqual(['api', 'state'])
  })

  it('rejects an unrelated path', () => {
    expect(matchSegments('/other/api/state', ROUTE_PREFIX)).toBeUndefined()
  })
})

describe('routes', () => {
  it('answers the state read without touching the model', async () => {
    const { base, close } = await serve(deps())
    running = { close }
    const response = await fetch(`${base}/api/state`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      prefs,
      resolution: { source: 'default', selection: { provider: 'p', model: 'm' } },
      limits: { maxItemsPerBatch: 2 },
    })
  })

  it('translates a batch through the resolved route', async () => {
    const capture: { instruction?: string } = {}
    const { base, close } = await serve(deps({ llm: () => ({ runtime: fakeLlm(capture) }) }))
    running = { close }
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'a', text: 'one' }] }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      results: [{ id: 'a', text: '甲' }],
      selection: { provider: 'p', model: 'm' },
      source: 'default',
      reasoned: false,
    })
    expect(capture.instruction).toContain('translation engine')
  })

  it('refuses a batch above the configured item limit', async () => {
    const { base, close } = await serve(deps())
    running = { close }
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }] }),
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'BATCH_TOO_LARGE' } })
  })

  it('refuses a mutating request from another site', async () => {
    const { base, close } = await serve(deps())
    running = { close }
    const response = await fetch(`${base}/api/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ targetLanguage: 'en' }),
    })
    expect(response.status).toBe(403)
  })

  it('reports a missing engine instead of failing the request silently', async () => {
    const { base, close } = await serve(deps({ llm: () => undefined }))
    running = { close }
    const response = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'a', text: 'one' }] }),
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'ENGINE_UNAVAILABLE' } })
  })
})
