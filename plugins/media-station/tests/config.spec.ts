import { describe, it, expect } from 'vitest'
import { Config } from '../src/config.ts'
import { DEFAULT_ROUTE_PREFIX, LOCALE_NAMESPACE } from '../src/shared/api.ts'
import { name, inject, apply } from '../src/index.ts'

describe('media station configuration', () => {
  it('applies the documented defaults', () => {
    const parsed = Config({})
    expect(parsed.routePrefix).toBe(DEFAULT_ROUTE_PREFIX)
    expect(parsed.crawlerEngine).toBe('jina')
    expect(parsed.minHeatThreshold).toBe(60)
    expect(parsed.enableDedup).toBe(true)
    expect(parsed.scheduleTiming).toBe('hourly')
    expect(parsed.enableShortCircuit).toBe(true)
  })

  it('keeps an explicit deployment value', () => {
    const parsed = Config({
      routePrefix: '/custom-station',
      crawlerEngine: 'crawl4ai',
      minHeatThreshold: 80,
      enableDedup: false,
    })
    expect(parsed.routePrefix).toBe('/custom-station')
    expect(parsed.crawlerEngine).toBe('crawl4ai')
    expect(parsed.minHeatThreshold).toBe(80)
    expect(parsed.enableDedup).toBe(false)
  })

  it('rejects an unknown crawler engine instead of silently degrading', () => {
    expect(() => Config({ crawlerEngine: 'playwright' as never })).toThrow()
  })
})

describe('media station plugin entry', () => {
  it('exports the bundle identity Cordis mounts', () => {
    expect(name).toBe(LOCALE_NAMESPACE)
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
  })
})
