/** Boot-level spec: the out-of-tree bundle mounts into the shipped web profile. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = resolve(import.meta.dirname, '../../cordis.patch.yml')

let ctx: Awaited<ReturnType<typeof bootTestProfile>> | undefined
let home: string

test(
  'boots the web profile with the dsh-manager bundle and serves an empty board',
  async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-manager-boot-'))
    ctx = await bootTestProfile({
      binName: 'dsh-manager-test',
      profile: 'web',
      overlayPaths: [overlayPath],
      home,
    })
    const board = ctx.dshManagerBoard
    expect(board).toBeDefined()
    const summary = await board.summary()
    expect(summary.columns.map(column => column.id)).toEqual(['inbox', 'pool', 'todo', 'running', 'attention', 'ended'])
    expect(summary.columns.every(column => column.count === 0)).toBe(true)
  },
  240_000,
)

afterAll(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})
