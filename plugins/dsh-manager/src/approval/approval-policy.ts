/**
 * Approval-policy domain core: which action categories need a human's
 * approval before the executor's tool call proceeds (spec stories 38–44,
 * ADR-0002). Pure decision logic over the category union — the interception
 * itself lives at the harness tool-call layer, never in prompts.
 */

/**
 * Every action category that can need a human's approval: the executor's
 * external writes, the Steward's mandate expansion when a follow-up ticket
 * would widen its parent's Mandate (spec story 62), and its Policy-change
 * proposals (spec stories 45–48).
 */
export const ACTION_CATEGORIES = [
  'comment', 'push-branch', 'open-mr', 'merge-mr',
  'jira-transition', 'rerun-pipeline',
  'delete-data', 'modify-credentials',
  'mandate-expansion', 'policy-change',
] as const
export type ActionCategory = (typeof ACTION_CATEGORIES)[number]

/** One approval policy: which categories require approval, by version. */
export interface ApprovalPolicy {
  /** The policy version the decision ran under. */
  readonly version: string
  /** The categories that require approval; everything outside them flows. */
  readonly categories: readonly ActionCategory[]
}

/**
 * The default policy: every external-write category needs approval. Reading,
 * analyzing, editing inside the worktree, running tests, and drafting
 * deliverables are not categories at all — they never hit this decision.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  version: '1',
  categories: ACTION_CATEGORIES,
}

/** The executor's external-action tools and the category each one is. */
export const TOOL_CATEGORIES: Readonly<Record<string, ActionCategory>> = {
  'post_mr_comment': 'comment',
  'set_jira_status': 'jira-transition',
  'local_merge_branch': 'merge-mr',
  'push_branch': 'push-branch',
  'create_mr_or_pr': 'open-mr',
}

/**
 * Classify one tool call into its action category.
 * @param toolName - the tool the executor called.
 * @returns the category, or `undefined` when the tool is not an external write.
 */
export function categorizeTool(toolName: string): ActionCategory | undefined {
  return TOOL_CATEGORIES[toolName]
}

/**
 * Whether one category requires approval under the given policy.
 * @param category - the classified action category.
 * @param policy - the policy in effect; defaults to the default policy.
 */
export function requiresApproval(category: ActionCategory, policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): boolean {
  return policy.categories.includes(category)
}
