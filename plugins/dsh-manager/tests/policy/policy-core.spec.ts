/**
 * Domain-core spec for the versioned Policy and its decision records (spec
 * stories 45–48): approval categories and the decision records travel as one
 * versioned whole; proposals apply only as a new version; the Steward's
 * proposal paths never mutate the current version in place.
 */
import { expect, test } from 'vitest'
import { ACTION_CATEGORIES } from '../../src/approval/approval-policy.ts'
import {
  applyProposal,
  defaultPolicy,
  diffPolicies,
  nextVersionOf,
  type PolicyProposal,
} from '../../src/policy/policy-core.ts'

const base = defaultPolicy(100)

test('the default policy is version 1 with every approval category and no decision records', () => {
  expect(base.version).toBe('1')
  expect(base.approvalCategories).toEqual([...ACTION_CATEGORIES])
  expect(base.decisions).toEqual([])
})

test('versions increment numerically', () => {
  expect(nextVersionOf('1')).toBe('2')
  expect(nextVersionOf('12')).toBe('13')
})

test('a confirmed rejection proposal mints the next version with the entry appended', () => {
  const proposal: PolicyProposal = { change: 'add-rejection', statement: '依赖升级 MR 一律不接' }
  const next = applyProposal(base, proposal, 200)
  expect(next.version).toBe('2')
  expect(next.decisions).toEqual([
    { id: expect.any(String), kind: 'rejection', statement: '依赖升级 MR 一律不接', createdAt: 200 },
  ])
  expect(next.approvalCategories).toEqual(base.approvalCategories)
  // The current version's record is untouched — versions are immutable.
  expect(base.decisions).toEqual([])
  expect(base.version).toBe('1')
})

test('a preference proposal records a long-term preference', () => {
  const next = applyProposal(base, { change: 'add-preference', statement: '合并前总是跑全量测试' }, 300)
  expect(next.decisions[0]?.kind).toBe('preference')
})

test('a relax proposal removes one approval category; an unknown category is refused', () => {
  const next = applyProposal(base, { change: 'relax-approval', statement: 'comment' }, 200)
  expect(next.version).toBe('2')
  expect(next.approvalCategories).not.toContain('comment')
  expect(next.approvalCategories).toContain('merge-mr')
  expect(() => applyProposal(base, { change: 'relax-approval', statement: 'not-a-category' }, 200)).toThrow()
})

test('a duplicate statement is refused: confirming twice does not mint twice', () => {
  const first = applyProposal(base, { change: 'add-rejection', statement: '依赖升级 MR 一律不接' }, 200)
  expect(() => applyProposal(first, { change: 'add-rejection', statement: '依赖升级 MR 一律不接' }, 300)).toThrow()
})

test('the diff between two versions lists the entries and categories that moved', () => {
  const withEntry = applyProposal(base, { change: 'add-rejection', statement: '依赖升级 MR 一律不接' }, 200)
  const relaxed = applyProposal(withEntry, { change: 'relax-approval', statement: 'comment' }, 300)
  const forward = diffPolicies(base, relaxed)
  expect(forward.entriesAdded.map(entry => entry.statement)).toEqual(['依赖升级 MR 一律不接'])
  expect(forward.entriesRemoved).toEqual([])
  expect(forward.categoriesAdded).toEqual([])
  expect(forward.categoriesRemoved).toEqual(['comment'])
  const backward = diffPolicies(relaxed, base)
  expect(backward.entriesAdded).toEqual([])
  expect(backward.entriesRemoved.map(entry => entry.statement)).toEqual(['依赖升级 MR 一律不接'])
  expect(backward.categoriesAdded).toEqual(['comment'])
  expect(backward.categoriesRemoved).toEqual([])
})
