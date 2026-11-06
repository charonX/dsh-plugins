import { describe, it, expect } from 'vitest'
import {
  clockMinutes,
  DEFAULT_OFFPEAK_WINDOW,
  describeOffpeak,
  describeOffpeakView,
  formatClock,
  isWindowAllDay,
  isWithinOffpeak,
  nextOffpeakOpen,
  normalizeClock,
  resolveOffpeakWindow,
  resolveSchedule,
  ScheduleInputError,
} from '../src/shared/schedule.ts'

/** Local instant at a fixed wall clock, so assertions never depend on the runner's clock. */
function at(hours: number, minutes = 0): Date {
  const date = new Date(2026, 0, 5, hours, minutes, 0, 0)
  return date
}

describe('off-peak window', () => {
  it('canonicalizes a valid clock and rejects the rest', () => {
    expect(normalizeClock(' 07:30 ')).toBe('07:30')
    expect(normalizeClock('23:00')).toBe('23:00')
    expect(normalizeClock('00:00')).toBe('00:00')
    expect(normalizeClock('24:00')).toBeUndefined()
    expect(normalizeClock('7:30')).toBeUndefined()
    expect(normalizeClock('07:60')).toBeUndefined()
    expect(normalizeClock(undefined)).toBeUndefined()
    expect(normalizeClock(730)).toBeUndefined()
  })

  it('falls back per bound so one typo cannot disable the other', () => {
    expect(resolveOffpeakWindow({})).toEqual(DEFAULT_OFFPEAK_WINDOW)
    expect(resolveOffpeakWindow({ offpeakStart: '22:15' })).toEqual({ start: '22:15', end: '07:00' })
    expect(resolveOffpeakWindow({ offpeakStart: 'nope', offpeakEnd: '06:45' })).toEqual({ start: '23:00', end: '06:45' })
  })

  it('measures minutes after midnight', () => {
    expect(clockMinutes('00:00')).toBe(0)
    expect(clockMinutes('23:59')).toBe(1439)
  })

  it('treats equal bounds as open all day', () => {
    const window = { start: '09:00', end: '09:00' }
    expect(isWindowAllDay(window)).toBe(true)
    expect(isWithinOffpeak(at(3), window)).toBe(true)
    expect(isWithinOffpeak(at(9), window)).toBe(true)
  })

  it('admits a same-day window with an exclusive end', () => {
    const window = { start: '09:00', end: '17:00' }
    expect(isWithinOffpeak(at(8, 59), window)).toBe(false)
    expect(isWithinOffpeak(at(9), window)).toBe(true)
    expect(isWithinOffpeak(at(16, 59), window)).toBe(true)
    expect(isWithinOffpeak(at(17), window)).toBe(false)
  })

  it('admits a window that crosses midnight', () => {
    const window = { start: '23:00', end: '07:00' }
    expect(isWithinOffpeak(at(22, 59), window)).toBe(false)
    expect(isWithinOffpeak(at(23), window)).toBe(true)
    expect(isWithinOffpeak(at(3), window)).toBe(true)
    expect(isWithinOffpeak(at(6, 59), window)).toBe(true)
    expect(isWithinOffpeak(at(7), window)).toBe(false)
    expect(isWithinOffpeak(at(12), window)).toBe(false)
  })

  it('reports the next opening for a closed window', () => {
    const window = { start: '23:00', end: '07:00' }
    expect(nextOffpeakOpen(at(12, 30), window)).toEqual(at(23))
    // While open, the current instant is the answer.
    expect(nextOffpeakOpen(at(2, 15), window)).toEqual(at(2, 15))
  })

  it('formats a label and a client view', () => {
    const window = { start: '23:00', end: '07:00' }
    expect(describeOffpeak(window)).toBe('23:00–07:00')
    expect(formatClock(at(4, 5))).toBe('04:05')

    expect(describeOffpeakView(at(12), window)).toEqual({
      start: '23:00', end: '07:00', open: false, allDay: false, opensAt: '23:00',
    })
    expect(describeOffpeakView(at(2), window)).toEqual({
      start: '23:00', end: '07:00', open: true, allDay: false,
    })
    expect(describeOffpeakView(at(2), { start: '00:00', end: '00:00' })).toEqual({
      start: '00:00', end: '00:00', open: true, allDay: true,
    })
  })
})

describe('schedule decision', () => {
  const now = new Date(2026, 0, 5, 12, 0, 0, 0).getTime()

  it('defaults to immediate', () => {
    expect(resolveSchedule(undefined, undefined, now)).toEqual({ mode: 'immediate' })
    expect(resolveSchedule('', 123, now)).toEqual({ mode: 'immediate' })
    expect(resolveSchedule('immediate', 123, now)).toEqual({ mode: 'immediate' })
  })

  it('accepts the retired nightly spelling as offpeak', () => {
    expect(resolveSchedule('offpeak', undefined, now)).toEqual({ mode: 'offpeak' })
    expect(resolveSchedule('nightly', undefined, now)).toEqual({ mode: 'offpeak' })
  })

  it('requires a future instant for a custom time', () => {
    expect(resolveSchedule('scheduled', now + 60_000, now)).toEqual({ mode: 'scheduled', scheduledAt: now + 60_000 })
    expect(() => resolveSchedule('scheduled', undefined, now)).toThrow(ScheduleInputError)
    expect(() => resolveSchedule('scheduled', now, now)).toThrow(/future/u)
    expect(() => resolveSchedule('scheduled', 'tomorrow', now)).toThrow(/epoch milliseconds/u)
  })

  it('rejects an unknown mode instead of silently degrading', () => {
    expect(() => resolveSchedule('whenever', undefined, now)).toThrow(ScheduleInputError)
    expect(() => resolveSchedule('whenever', undefined, now)).toThrow(/unknown schedule mode/u)
  })
})
