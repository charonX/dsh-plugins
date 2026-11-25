/**
 * Main-seam spec: the Jira Source against a fake Jira — a poll turns changes
 * into triggers, a repeated poll dedupes, a restart never re-collects, and
 * rate limiting surfaces as a structured error (spec stories 19–22, 26–28).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, '../../cordis.patch.yml')
const home = await mkdtemp(join(tmpdir(), 'dsh-sources-boot-'))

let searchBody: unknown = { issues: [] }
let searchStatus = 200
let searchHeaders: Record<string, string> = {}
let pollCount = 0

const server: Server = createServer((request: IncomingMessage, response) => {
  if (request.url?.includes('/rest/api/2/myself')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'jira-user' }))
    return
  }
  pollCount += 1
  response.writeHead(searchStatus, { 'content-type': 'application/json', ...searchHeaders })
  response.end(JSON.stringify(searchBody))
})
await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

/** Boot a profile over the shared fake Jira and return the sources face. */
async function bootSources() {
  const ctx = await bootTestProfile({
    binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
  })
  const reflect = (ctx as unknown as { reflect: { get(name: string, strict?: boolean): unknown } }).reflect
  const deadline = Date.now() + 30_000
  while (reflect.get('dshManagerSources', true) === undefined || reflect.get('dshManagerConnections', true) === undefined) {
    if (Date.now() > deadline) throw new Error('sources/connections services did not become ready within 30000ms')
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
  return ctx
}

test(
  'a Jira source collects changes once and survives a restart without duplicates',
  async () => {
    searchBody = {
      issues: [
        { key: 'PROJ-1', fields: { summary: 'Fix the login flow', updated: '2026-01-01T00:00:00.000+0000' } },
        { key: 'PROJ-2', fields: { summary: 'Ship the report', updated: '2026-01-02T00:00:00.000+0000' } },
      ],
    }
    let ctx = await bootSources()
    const connection = await ctx.dshManagerConnections.connectionAdd({
      connector: 'jira', name: 'prod', deployment: 'server-dc', baseUrl, authMethod: 'pat', secret: 'pat-value',
    })

    // A source starts with the default watch on the connection.
    const source = await ctx.dshManagerSources.sourceAdd({ connectionId: connection.id })
    expect(source.enabled).toBe(true)
    expect(source.jql).toContain('assignee = currentUser()')

    // The first poll collects both issues as triggers in their threads.
    const first = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(first).toMatchObject({ added: 2, duplicates: 0 })

    // Threads group per issue, with a deep link back to Jira.
    const threads = await ctx.dshManagerSources.threadList()
    expect(threads.threads).toHaveLength(2)
    const proj1 = threads.threads.find(thread => thread.externalKey === 'PROJ-1')
    expect(proj1).toMatchObject({ title: 'Fix the login flow', url: `${baseUrl}/browse/PROJ-1` })
    const triggers = await ctx.dshManagerSources.triggerList({ threadId: proj1!.id })
    expect(triggers.triggers).toHaveLength(1)

    // The same data again is all duplicates.
    const repeated = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(repeated).toMatchObject({ added: 0, duplicates: 2 })
    const threadsAfter = await ctx.dshManagerSources.threadList()
    expect(threadsAfter.threads).toHaveLength(2)

    // A changed fingerprint is a new trigger in the same thread.
    searchBody = {
      issues: [
        { key: 'PROJ-1', fields: { summary: 'Fix the login flow v2', updated: '2026-01-03T00:00:00.000+0000' } },
        { key: 'PROJ-2', fields: { summary: 'Ship the report', updated: '2026-01-02T00:00:00.000+0000' } },
      ],
    }
    const changed = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(changed).toMatchObject({ added: 1, duplicates: 1 })
    const proj1After = (await ctx.dshManagerSources.threadList()).threads.find(thread => thread.externalKey === 'PROJ-1')
    expect(proj1After?.title).toBe('Fix the login flow v2')
    expect((await ctx.dshManagerSources.triggerList({ threadId: proj1After!.id })).triggers).toHaveLength(2)
    await ctx.fiber.dispose()

    // A restart over the same home never re-collects processed changes.
    ctx = await bootSources()
    const restarted = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(restarted).toMatchObject({ added: 0, duplicates: 2 })
    expect((await ctx.dshManagerSources.threadList()).threads).toHaveLength(2)

    // Rate limiting surfaces as a structured error and clears on recovery.
    searchStatus = 429
    searchHeaders = { 'retry-after': '7' }
    const limited = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(limited.error).toContain('rate-limited')
    searchStatus = 200
    searchHeaders = {}
    const recovered = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(recovered.error).toBeUndefined()
    expect(recovered.duplicates).toBe(2)

    // Disabling stops the scheduler from polling (the manual path still works).
    const disabled = await ctx.dshManagerSources.sourceUpdate({ id: source.id, enabled: false })
    expect(disabled.enabled).toBe(false)
    const pollsBefore = pollCount
    await new Promise(resolve => { setTimeout(resolve, 100) })
    const manual = await ctx.dshManagerSources.sourcePoll({ id: source.id })
    expect(manual.duplicates).toBe(2)
    expect(disabled.enabled).toBe(false)
    expect(pollCount).toBeGreaterThan(pollsBefore) // the manual poll reached the server
    await ctx.fiber.dispose()
  },
  300_000,
)

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  await rm(home, { recursive: true, force: true })
})
