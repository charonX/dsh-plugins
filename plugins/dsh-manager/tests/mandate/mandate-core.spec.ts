/**
 * Domain-core spec for follow-up tickets and mandate inheritance (spec
 * stories 61–63): a follow-up inherits its parent's Mandate, a scope may
 * only narrow it, and widening the scope goes to the human as an Approval.
 */
import { expect, test } from 'vitest'
import { inheritMandate, mandateCovers, scopeItems } from '../../src/mandate/mandate-core.ts'

const parentMandate = { strength: 'explicit' as const, scope: 'login flow, session store', policyVersion: '1' }

test('a scope is the comma-separated surfaces it names, trimmed and case-folded', () => {
  expect(scopeItems('Login Flow, session store')).toEqual(['login flow', 'session store'])
  expect(scopeItems('  single ')).toEqual(['single'])
  expect(scopeItems(', ,')).toEqual([])
})

test('a follow-up may narrow the mandate: the same scope, or a subset of its surfaces', () => {
  expect(mandateCovers(parentMandate.scope, 'login flow, session store')).toBe(true)
  expect(mandateCovers(parentMandate.scope, 'Login Flow')).toBe(true)
  expect(mandateCovers(parentMandate.scope, 'session store')).toBe(true)
})

test('a follow-up may not widen the mandate: a new surface or an empty scope is overreach', () => {
  expect(mandateCovers(parentMandate.scope, 'login flow, payment store')).toBe(false)
  expect(mandateCovers(parentMandate.scope, 'the whole repository')).toBe(false)
  expect(mandateCovers(parentMandate.scope, '')).toBe(false)
})

test('an equal-or-narrower scope mints directly with the parent mandate inherited', () => {
  const decision = inheritMandate(parentMandate, 'login flow')
  expect(decision.path).toBe('direct')
  expect(decision.mandate).toEqual({
    strength: 'explicit',
    scope: 'login flow',
    policyVersion: '1',
  })
})

test('a widened scope needs an Approval before the follow-up mints', () => {
  const decision = inheritMandate(parentMandate, 'login flow, payment store')
  expect(decision.path).toBe('needs-approval')
  // The proposed mandate rides the decision, so approving it mints exactly
  // what was proposed.
  expect(decision.mandate.scope).toBe('login flow, payment store')
})
