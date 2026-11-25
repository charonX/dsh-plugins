/**
 * The Policy facility: the versioned Policy and its decision records over
 * the durable policy domain. The Steward only proposes — proposals arrive as
 * attentions and the executor applies them on the user's confirmation; the
 * user's own page edits mint versions directly. The current version feeds
 * every Eval's input.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  applyProposal,
  defaultPolicy,
  diffPolicies,
  nextVersionOf,
  type PolicyDiff,
  type PolicyProposal,
  type PolicyRecord,
} from './policy/policy-core.ts'
import { policyDomain } from './policy/policy-domain.ts'
import { policyDiffInputSchema, policyUpdateInputSchema, type PolicyDiffInput, type PolicyUpdateInput } from './policy/wire-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The versioned Policy API served to the Dsh Manager client. */
    dshManagerPolicy: DshManagerPolicy
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed Policy version does not exist. */
    'dshManager/policy-not-found': { readonly version: string }
  }
}

/** Policy facet configuration. */
export interface PolicyConfig {}

export const PolicyConfig: z<PolicyConfig> = z.object({})

export class DshManagerPolicy extends TypertRemoteService {
  /** Host facilities the policy reads. */
  static inject = ['storageDomain']

  static Config: z<PolicyConfig> = PolicyConfig

  private domain?: Domain<typeof policyDomain>

  constructor(ctx: Context, config: PolicyConfig) {
    super(ctx, 'dshManagerPolicy', { namespace: 'dshManager' })
    void config
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(policyDomain)
    this.domain = domain
    // Seed the version-1 default so the history is complete from the first
    // mutation on, and diffs against `1` resolve.
    if (this.listVersions().length === 0) await this.putVersion(defaultPolicy(Date.now()))
    this.ctx.effect(() => async () => { await domain.close() }, 'dsh-manager: close policy domain')
  }

  /** The versions newest first, for the history page. */
  @Remote
  async policyList(): Promise<{ readonly policies: readonly PolicyRecord[] }> {
    return { policies: this.listVersions() }
  }

  /** What moved between two versions, for the history diff. */
  @Remote
  async policyDiff(rawInput: PolicyDiffInput): Promise<{ readonly diff: PolicyDiff }> {
    const input = policyDiffInputSchema.parse(rawInput)
    const from = this.requireVersion(input.from)
    const to = this.requireVersion(input.to)
    return { diff: diffPolicies(from, to) }
  }

  /**
   * The user's own edit: the next version carries the edited categories and
   * decision records. The user is the policy authority — no confirmation
   * gate on this path.
   */
  @Remote
  async policyUpdate(rawInput: PolicyUpdateInput): Promise<{ readonly policy: PolicyRecord }> {
    const input = policyUpdateInputSchema.parse(rawInput)
    const current = this.currentPolicy()
    const decisions = [
      ...current.decisions.filter(entry => !input.removeEntryIds?.includes(entry.id)),
      ...(input.addEntries ?? []).map(entry => ({
        id: `entry-${crypto.randomUUID()}`,
        kind: entry.kind,
        statement: entry.statement,
        createdAt: Date.now(),
      })),
    ]
    const record = await this.putVersion({
      version: nextVersionOf(current.version),
      approvalCategories: input.approvalCategories ?? current.approvalCategories,
      decisions,
      createdAt: Date.now(),
    })
    return { policy: record }
  }

  /** The policy in force: the newest version, or the version-1 default. */
  currentPolicy(): PolicyRecord {
    return this.listVersions()[0] ?? defaultPolicy(Date.now())
  }

  /**
   * Apply one user-confirmed Steward proposal as the next version. A
   * statement already on file is idempotent: the current version comes back
   * and nothing new mints.
   */
  async applyConfirmedProposal(proposal: PolicyProposal, now: number): Promise<PolicyRecord> {
    const current = this.currentPolicy()
    if (proposal.change !== 'relax-approval'
      && current.decisions.some(entry => entry.statement === proposal.statement)) {
      return current
    }
    const next = applyProposal(current, proposal, now)
    return await this.putVersion(next)
  }

  /** The durable versions, newest first. */
  private listVersions(): readonly PolicyRecord[] {
    return [...this.domain!.table('versions').entries()]
      .map(([, record]) => record)
      .sort((left, right) => Number.parseInt(right.version, 10) - Number.parseInt(left.version, 10))
  }

  private requireVersion(version: string): PolicyRecord {
    const record = this.domain!.table('versions').get(version as never)
    if (record === undefined) {
      throw new RemoteError('dshManager/policy-not-found', `policy version ${version} does not exist`, { version })
    }
    return record
  }

  private async putVersion(record: PolicyRecord): Promise<PolicyRecord> {
    await this.domain!.table('versions').put(record.version as never, record)
    return record
  }
}

export default DshManagerPolicy
