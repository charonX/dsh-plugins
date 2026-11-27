/**
 * Pure helpers for the single-popover external model/effort picker and
 * custom model text parsing in Settings.
 */
import type {
  AgentDescriptor,
  AgentModelOption,
  AgentReasoningEffort,
  ExternalAgentSettings,
  SessionAgentState,
} from '../types.ts'

export function filterExternalModels(
  models: readonly AgentModelOption[],
  query: string,
): readonly AgentModelOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return models
  const prefix: AgentModelOption[] = []
  const substring: AgentModelOption[] = []
  for (const item of models) {
    const idLower = item.id.toLowerCase()
    const nameLower = item.name.toLowerCase()
    if (nameLower.startsWith(needle) || idLower.startsWith(needle)) {
      prefix.push(item)
    } else if (nameLower.includes(needle) || idLower.includes(needle)) {
      substring.push(item)
    }
  }
  return [...prefix, ...substring]
}

const PARAMETERIZED_EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

export function extractParameterizedEffort(modelId: string): string | undefined {
  const bracketStart = modelId.indexOf('[')
  const bracketEnd = modelId.lastIndexOf(']')
  if (bracketStart === -1 || bracketEnd <= bracketStart) return undefined
  const inner = modelId.slice(bracketStart + 1, bracketEnd)
  for (const part of inner.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    if ((key === 'effort' || key === 'reasoning_effort' || key === 'reasoning') && val !== '') {
      return PARAMETERIZED_EFFORT_LABELS[val.toLowerCase()] ?? val
    }
  }
  return undefined
}

export function resolveActiveModelAndEffort(
  descriptor: AgentDescriptor | undefined,
  sessionState: SessionAgentState | null,
  agentSettings?: ExternalAgentSettings,
): {
  readonly modelId: string
  readonly modelLabel: string
  readonly effortId: string | undefined
  readonly effortLabel: string | undefined
  readonly efforts: readonly AgentReasoningEffort[]
} {
  const modelId = sessionState?.selectedExternalModel?.model
    ?? agentSettings?.defaultModel
    ?? descriptor?.defaultModel
    ?? 'default'
  const models = descriptor?.models ?? []
  const matchedModel = models.find(item => item.id === modelId)
  const modelLabel = matchedModel?.name ?? (modelId === 'default' ? 'Default' : modelId)

  const efforts = descriptor?.reasoning?.efforts ?? []
  const hasSessionSelection = sessionState?.selectedExternalModel !== undefined
  const effortId = hasSessionSelection
    ? sessionState.selectedExternalModel.reasoningEffort
    : (agentSettings?.defaultReasoningEffort ?? descriptor?.reasoning?.defaultEffort)
  const matchedEffort = effortId === undefined ? undefined : efforts.find(item => item.id === effortId)
  const effortLabel = matchedEffort?.name ?? effortId ?? (efforts.length === 0 ? extractParameterizedEffort(modelId) : undefined)

  return {
    modelId,
    modelLabel,
    effortId,
    effortLabel,
    efforts,
  }
}

export function parseCustomModelsText(raw: string): readonly AgentModelOption[] {
  const seen = new Set<string>()
  const out: AgentModelOption[] = []
  for (const chunk of raw.split(/[\n,]+/u)) {
    const trimmed = chunk.trim()
    if (trimmed === '') continue
    const sep = trimmed.indexOf('|')
    const id = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim()
    const name = (sep === -1 ? id : trimmed.slice(sep + 1)).trim() || id
    if (id === '' || id === 'default' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

export function formatCustomModelsText(models: readonly AgentModelOption[] | undefined): string {
  if (models === undefined || models.length === 0) return ''
  return models
    .map(item => (item.name !== item.id ? `${item.id}|${item.name}` : item.id))
    .join('\n')
}
