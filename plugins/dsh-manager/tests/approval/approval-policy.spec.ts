/** Approval-policy decisions: which action categories the executor must not run unapproved. */
import { describe, expect, test } from 'vitest'
import {
  ACTION_CATEGORIES, DEFAULT_APPROVAL_POLICY, categorizeTool, requiresApproval,
  type ApprovalPolicy,
} from '../../src/approval/approval-policy.ts'

describe('approval policy', () => {
  test('every external-write category requires approval under the default policy', () => {
    for (const category of ACTION_CATEGORIES) {
      expect(requiresApproval(category)).toBe(true)
    }
  })

  test('the default policy carries a version and covers all categories', () => {
    expect(DEFAULT_APPROVAL_POLICY.version).toBe('1')
    expect(DEFAULT_APPROVAL_POLICY.categories).toEqual(ACTION_CATEGORIES)
  })

  test('executor external-action tools classify into their categories', () => {
    expect(categorizeTool('post_mr_comment')).toBe('comment')
    expect(categorizeTool('set_jira_status')).toBe('jira-transition')
    expect(categorizeTool('local_merge_branch')).toBe('merge-mr')
    expect(categorizeTool('push_branch')).toBe('push-branch')
    expect(categorizeTool('create_mr_or_pr')).toBe('open-mr')
    expect(categorizeTool('check_branch_rebase')).toBeUndefined()
  })

  test('harness-native tools are not external writes and never hit the approval decision', () => {
    expect(categorizeTool('write')).toBeUndefined()
    expect(categorizeTool('bash')).toBeUndefined()
    expect(categorizeTool('pwsh')).toBeUndefined()
    expect(categorizeTool('present')).toBeUndefined()
    expect(categorizeTool('submit_report')).toBeUndefined()
    expect(categorizeTool('ask_user')).toBeUndefined()
  })

  test('a narrower policy allows a category the default would gate', () => {
    const policy: ApprovalPolicy = { version: '2', categories: ['merge-mr'] }
    expect(requiresApproval('comment', policy)).toBe(false)
    expect(requiresApproval('merge-mr', policy)).toBe(true)
  })
})
