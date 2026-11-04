/**
 * Execution-timing model: the configured off-peak window plus the per-ticket
 * schedule decision.
 *
 * This module is the single source of truth for timing on both halves of the
 * plugin: the kernel admits work with it, the router narrates with it, the HTTP
 * snapshot publishes it, and the Kanban renders it. No other module may hold a
 * clock literal — a deployment that wants different quiet hours changes
 * `offpeakStart` / `offpeakEnd` in its patch, and every surface follows.
 *
 * @module @charonx/dsh-autoloop/shared/schedule
 */

import type { OffpeakView, OffpeakWindow, ScheduleMode } from './types.js'

/** Window used when configuration omits either bound. */
export const DEFAULT_OFFPEAK_WINDOW: OffpeakWindow = { start: '23:00', end: '07:00' }

/** Canonical `HH:mm`, 24-hour, host-local wall clock. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/u

/**
 * Canonicalize one `HH:mm` wall-clock value.
 * @param value - Candidate configuration value.
 * @returns The trimmed value, or undefined when it is not a valid clock.
 */
export function normalizeClock(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return CLOCK.test(trimmed) ? trimmed : undefined
}

/**
 * Resolve the deployment's window, falling back per bound to the default.
 * An invalid bound falls back on its own; a valid sibling bound still applies.
 * @param config - Raw configuration values.
 * @returns The canonical window.
 */
export function resolveOffpeakWindow(config: { offpeakStart?: unknown; offpeakEnd?: unknown }): OffpeakWindow {
  return {
    start: normalizeClock(config.offpeakStart) ?? DEFAULT_OFFPEAK_WINDOW.start,
    end: normalizeClock(config.offpeakEnd) ?? DEFAULT_OFFPEAK_WINDOW.end,
  }
}

/**
 * Minutes after local midnight for one canonical clock value.
 * @param value - Canonical `HH:mm`.
 * @returns Minutes in `0..1439`.
 */
export function clockMinutes(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Whether the window never closes.
 * @param window - Canonical window.
 * @returns True when both bounds are equal.
 */
export function isWindowAllDay(window: OffpeakWindow): boolean {
  return window.start === window.end
}

/**
 * Whether one instant falls inside the window.
 * A window whose start is later than its end crosses midnight; both bounds are
 * host-local wall clock, so the answer follows the operator's own clock.
 * @param now - Instant to test.
 * @param window - Canonical window.
 * @returns True when admission is allowed.
 */
export function isWithinOffpeak(now: Date, window: OffpeakWindow): boolean {
  if (isWindowAllDay(window)) return true
  const start = clockMinutes(window.start)
  const end = clockMinutes(window.end)
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

/**
 * The next instant the window opens.
 * @param now - Instant to start from.
 * @param window - Canonical window.
 * @returns `now` itself while the window is open, otherwise the next local start.
 */
export function nextOffpeakOpen(now: Date, window: OffpeakWindow): Date {
  if (isWithinOffpeak(now, window)) return new Date(now.getTime())
  const start = clockMinutes(window.start)
  const next = new Date(now.getTime())
  next.setHours(Math.floor(start / 60), start % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/**
 * Format one instant as a local `HH:mm` label.
 * @param date - Instant to format.
 * @returns Zero-padded local wall clock.
 */
export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * One `start–end` label of the configured window.
 * @param window - Canonical window.
 * @returns Label used by logs and triage narratives.
 */
export function describeOffpeak(window: OffpeakWindow): string {
  return `${window.start}–${window.end}`
}

/**
 * Build the client-facing view of the window at one instant.
 * @param now - Instant used to decide openness.
 * @param window - Canonical window.
 * @returns Window bounds plus the current state and the next opening clock.
 */
export function describeOffpeakView(now: Date, window: OffpeakWindow): OffpeakView {
  const open = isWithinOffpeak(now, window)
  const allDay = isWindowAllDay(window)
  return {
    start: window.start,
    end: window.end,
    open,
    allDay,
    ...(open || allDay ? {} : { opensAt: formatClock(nextOffpeakOpen(now, window)) }),
  }
}

/** Rejection raised when a request names an unusable timing. */
export class ScheduleInputError extends Error {
  /** Stable discriminator for HTTP 400 mapping. */
  readonly code = 'invalid_schedule'

  constructor(message: string) {
    super(message)
    this.name = 'ScheduleInputError'
  }
}

/** Resolved timing carried by a ticket. */
export interface ScheduleDecision {
  /** Mode the ticket will be stored with. */
  readonly mode: ScheduleMode
  /** Committed instant for `scheduled`; absent otherwise. */
  readonly scheduledAt?: number
}

/**
 * Validate and normalize a requested timing.
 *
 * `nightly` remains accepted as an input alias of `offpeak` so external callers
 * written before the rename keep working; the alias is never stored.
 *
 * @param mode - Requested mode from an ingress payload; absent means immediate.
 * @param scheduledAt - Requested instant in epoch milliseconds.
 * @param now - Current instant used to reject a past schedule.
 * @returns The decision to persist.
 * @throws ScheduleInputError when the request cannot be honored.
 */
export function resolveSchedule(mode: unknown, scheduledAt: unknown, now: number): ScheduleDecision {
  if (mode === undefined || mode === null || mode === '') return { mode: 'immediate' }
  if (mode === 'immediate') return { mode: 'immediate' }
  if (mode === 'offpeak' || mode === 'nightly') return { mode: 'offpeak' }
  if (mode === 'scheduled') {
    if (typeof scheduledAt !== 'number' || !Number.isFinite(scheduledAt)) {
      throw new ScheduleInputError('scheduled mode requires scheduledAt as epoch milliseconds')
    }
    if (scheduledAt <= now) {
      throw new ScheduleInputError('scheduled mode requires scheduledAt in the future')
    }
    return { mode: 'scheduled', scheduledAt: Math.trunc(scheduledAt) }
  }
  throw new ScheduleInputError(`unknown schedule mode "${String(mode)}"`)
}
