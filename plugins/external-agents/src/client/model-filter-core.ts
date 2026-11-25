/**
 * Pure per-session model directory filtering logic shared by browser runtime and unit tests.
 */
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { providerIdForAgent, type SessionAgentId } from '../types.ts'

export function filterModelDirectoryState(
  raw: ModelDirectoryState,
  agentId: SessionAgentId,
): ModelDirectoryState {
  const expectedProvider = agentId === 'native' ? undefined : providerIdForAgent(agentId)
  const groups = expectedProvider === undefined
    ? raw.groups.filter(group => !group.id.startsWith('ext-'))
    : raw.groups.filter(group => group.id === expectedProvider)

  const failures = expectedProvider === undefined
    ? raw.failures.filter(failure => !failure.id.startsWith('ext-'))
    : raw.failures.filter(failure => failure.id === expectedProvider)

  const routable = raw.routable === null
    ? null
    : raw.current !== null
      && groups.some(group => group.id === raw.current!.provider
        && group.models.some(model => model.id === raw.current!.model))

  if (
    groups.length === raw.groups.length
    && failures.length === raw.failures.length
    && routable === raw.routable
  ) {
    return raw
  }

  return {
    ...raw,
    groups,
    failures,
    routable,
  }
}
