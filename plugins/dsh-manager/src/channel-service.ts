/**
 * The Channel service: the Thread write side (GLOSSARY) — an approved
 * external action replays through the connection's credentials. The service
 * resolves the connection face and routes the payload; the approval flow
 * never touches credentials directly.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { postGitLabComment, setJiraStatus } from './channel/channel-core.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Channel write service the executor's approved actions replay through. */
    dshManagerChannel: DshManagerChannel
  }
}

/** Channel facet configuration. */
export interface ChannelConfig {}

export const ChannelConfig: z<ChannelConfig> = z.object({})

export class DshManagerChannel extends Service {
  /** Host services the channel reads: the connection faces it writes through. */
  static inject = ['dshManagerConnections']

  static Config: z<ChannelConfig> = ChannelConfig

  constructor(ctx: Context, config: ChannelConfig) {
    super(ctx, 'dshManagerChannel')
    void config
  }

  /**
   * Replay one approved external action through its connection.
   * @param tool - the executor tool the action came from.
   * @param connectionId - the connection the write targets.
   * @param payload - the approved tool arguments, replayed verbatim.
   */
  async execute(tool: string, connectionId: string, payload: unknown): Promise<{ ok: boolean; detail: string }> {
    const facts = await this.ctx.dshManagerConnections.resolveConnectionFacts(connectionId)
    if (facts === undefined) {
      return { ok: false, detail: `connection ${connectionId} has no usable credential` }
    }
    if (tool === 'post_mr_comment') {
      const result = await postGitLabComment(facts.baseUrl, facts.auth, payload as Parameters<typeof postGitLabComment>[2])
      return { ok: result.ok, detail: result.ok ? `note ${result.id ?? ''} posted`.trim() : result.detail }
    }
    if (tool === 'set_jira_status') {
      const result = await setJiraStatus(facts.baseUrl, facts.auth, payload as Parameters<typeof setJiraStatus>[2])
      return { ok: result.ok, detail: result.ok ? 'transition applied' : result.detail }
    }
    return { ok: false, detail: `no channel route for tool ${tool}` }
  }
}

export default DshManagerChannel
