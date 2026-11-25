/**
 * Resolve `AgentOptions` model fields for Manager's built-in Steward and
 * Executor agents: starts from the host's `agentDefaultModel` (when mounted),
 * then applies explicit bundle config and per-member overrides in order.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Sparse model selection layer (`provider`, `model`, optional `reasoningEffort`). */
export interface ModelOptionLayer {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
}

interface DefaultModelLike {
  currentSelection?: () => {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: ReasoningEffortId
  }
}

/** Read the host's configured default model without adding a hard inject edge. */
function hostDefaultSelection(ctx: Context): ModelOptionLayer {
  try {
    const service = (ctx as unknown as { get(key: string): unknown }).get('agentDefaultModel') as DefaultModelLike | undefined
    const selection = service?.currentSelection?.()
    if (selection !== undefined && typeof selection.provider === 'string' && selection.provider !== ''
      && typeof selection.model === 'string' && selection.model !== '') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      }
    }
  } catch {
    // Minimal test profiles without `agentDefaultModel` rely on bundle config.
  }
  return {}
}

/**
 * Merge `agentDefaultModel.currentSelection()` with caller-supplied override
 * layers (later layers win per field).
 */
export function resolveAgentModelOptions(ctx: Context, ...layers: readonly ModelOptionLayer[]): Pick<AgentOptions, 'provider' | 'model' | 'reasoningEffort'> {
  const resolved: { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId } = { ...hostDefaultSelection(ctx) }
  for (const layer of layers) {
    if (layer.provider !== undefined && layer.provider !== '') resolved.provider = layer.provider
    if (layer.model !== undefined && layer.model !== '') resolved.model = layer.model
    if (layer.reasoningEffort !== undefined && layer.reasoningEffort !== '') resolved.reasoningEffort = layer.reasoningEffort
  }
  return resolved
}
