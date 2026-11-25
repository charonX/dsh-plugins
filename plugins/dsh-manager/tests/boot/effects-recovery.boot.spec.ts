/** Main-seam spec: the effect queue survives a mid-delivery crash (ADR-0003). */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import type {} from '../../src/index.ts'
import { bootTestProfile } from './boot-test-profile.ts'

const overlayPath = join(import.meta.dirname, '../../cordis.patch.yml')

const home = await mkdtemp(join(tmpdir(), 'dsh-effects-recovery-'))

test(
  'an effect crashed mid-delivery re-delivers exactly once after restart',
  async () => {
    // Boot 1: enqueue and crash while the deliverer hangs before any request
    // reaches the target. The durable record is stuck in-flight.
    const first = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    const crashed = vi.fn(() => new Promise<void>(() => {}))
    first.dshManagerEffects.register('test', crashed)
    const id = await first.dshManagerEffects.enqueue('test', { value: 1 })
    await vi.waitFor(() => { expect(crashed).toHaveBeenCalledTimes(1) })
    await first.fiber.dispose()

    // Boot 2 over the same home: recovery re-delivers; the target answers.
    const second = await bootTestProfile({
      binName: 'dsh-manager-test', profile: 'web', overlayPaths: [overlayPath], home,
    })
    const target = vi.fn(async (_delivery: unknown) => {})
    second.dshManagerEffects.register('test', target)
    await vi.waitFor(
      () => {
        const record = second.dshManagerEffects.listEffects().find(candidate => candidate.id === id)
        expect(record?.status).toBe('done')
      },
      { timeout: 15_000 },
    )
    expect(target).toHaveBeenCalledTimes(1)
    expect(target.mock.calls[0]?.[0]).toMatchObject({ id, kind: 'test', payload: { value: 1 } })
    await second.fiber.dispose()
  },
  240_000,
)

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})
