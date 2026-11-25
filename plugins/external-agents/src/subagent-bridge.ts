/**
 * Registers shared external agent adapters as `ctx.subagents` providers so DSH
 * native sessions can also delegate subagent work through the exact same runtime.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  AssistantOutputFold,
  NO_START_CAPABILITIES,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { EXTERNAL_AGENT_IDS, type ExternalAgentId } from './types.ts'
import type { ExternalAgentAdapter, ExternalPermissionPolicy } from './adapters/index.ts'

function promptBlocksToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

class SharedExternalSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly adapter: ExternalAgentAdapter,
    private readonly getSubprocess: () => SubprocessRuntime | undefined,
    private readonly getPermissionPolicy: () => ExternalPermissionPolicy,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const cwd = assertUsableCwd(`external-agents/${this.adapter.id}`, 'child cwd', request.cwd)
    const subprocess = this.getSubprocess()
    if (subprocess === undefined) {
      throw new Error('Subprocess runtime is unavailable')
    }
    const id = brandString<SessionId>(randomUUID())
    const runAbort = new AbortController()
    let cancelled = false
    const onRequestAbort = (): void => {
      cancelled = true
      runAbort.abort(request.signal.reason)
    }
    request.signal.addEventListener('abort', onRequestAbort, { once: true })

    const fold = new AssistantOutputFold()
    const prompt = promptBlocksToText(request.prompt)

    const result: Promise<SubagentResult> = settleRunResult({
      attempt: async (): Promise<SubagentResult> => {
        try {
          const outcome = await this.adapter.runTurn(subprocess, {
            prompt,
            cwd,
            permissionPolicy: this.getPermissionPolicy(),
            signal: runAbort.signal,
            onEvent: (event) => {
              if (event.type === 'text_delta') fold.pushText(event.delta)
              else if (event.type === 'text') fold.pushText(event.text)
            },
          })
          const collected = fold.collect()
          if (collected !== undefined && collected.length > 0) {
            return { stopReason: 'completed', output: collected }
          }
          const output: ContentBlock[] = outcome.finalText.trim() === ''
            ? []
            : [{ type: 'text', text: outcome.finalText }]
          return { stopReason: 'completed', output }
        } catch (error) {
          if (runAbort.signal.aborted) {
            return { stopReason: 'aborted', output: fold.collect() ?? [] }
          }
          const msg = error instanceof Error ? error.message : String(error)
          return {
            stopReason: 'error',
            output: [{ type: 'text', text: msg }],
          }
        }
      },
      collectOutput: () => fold.collect() ?? [],
      collectDiagnostic: () => undefined,
      cancelled: () => cancelled,
      signal: request.signal,
      onAbort: onRequestAbort,
    })

    return subprocessRunHandle({
      id,
      result,
      signal: request.signal,
      onAbort: onRequestAbort,
      requestCancel: () => {
        cancelled = true
        runAbort.abort(new Error('subagent disposed'))
      },
      teardown: async () => {
        await result.catch(() => {})
      },
    })
  }
}

export function registerExternalSubagents(
  ctx: Context,
  adapters: ReadonlyMap<ExternalAgentId, ExternalAgentAdapter>,
  getSubprocess: () => SubprocessRuntime | undefined,
  getPermissionPolicy: () => ExternalPermissionPolicy,
): () => void {
  const scope = ctx.inject(['subagents'], (subCtx) => {
    const subagents = subCtx.subagents as SubagentRuntime
    for (const id of EXTERNAL_AGENT_IDS) {
      const adapter = adapters.get(id)
      if (adapter === undefined) continue
      const providerName = `ext-${id}`
      const provider = new SharedExternalSubagentProvider(
        providerName,
        adapter,
        getSubprocess,
        getPermissionPolicy,
      )
      subCtx.effect(
        () => subagents.registerProvider(provider),
        `external-agents.subagent:${providerName}`,
      )
    }
  })

  return () => {
    scope.dispose()
  }
}
