/**
 * Settings writes this plugin performs, as pure functions.
 *
 * Both surfaces (the footer preset panel and the per-card compat editor) turn a
 * user action into ordered `set`/`unset` operations here, so the "what gets
 * written" contract is testable without a browser or a Host. The shapes mirror
 * `SettingsPathOpView`; nothing in this module imports the wire types, which
 * keeps the client bundle free of remote-package type dependencies.
 *
 * @module dsh-model-studio/client/ops
 */

import type { Preset, PresetModel } from '../shared/preset.ts'

/** JSON value shape accepted by the settings write path. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** One path-addressed edit against a settings namespace. */
export type PathOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: Json }
  | { readonly op: 'unset'; readonly path: string[] }

/** Route-id collision outcome for a preset. */
export type PresetConflict = 'exists'

/**
 * Whether a preset may be written.
 * An id that already appears in the configurable directory — a shipped catalog
 * route or a stored profile — must never be rewritten: doing so would replace
 * a working route's defaults with a snapshot guess.
 * @param preset - preset being applied.
 * @param knownRouteIds - route ids the page already knows.
 * @returns `'exists'` when writing must be refused.
 */
export function presetConflict(preset: Preset, knownRouteIds: ReadonlySet<string>): PresetConflict | undefined {
  return knownRouteIds.has(preset.id) ? 'exists' : undefined
}

/**
 * One preset model as the profile's `models[]` entry.
 * @param model - representative model from the snapshot.
 * @returns the settings value for that entry.
 */
function modelValue(model: PresetModel): Json {
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.input === undefined ? {} : { input: [...model.input] },
    ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...model.reasoningEfforts } },
  }
}

/**
 * Operations that create one route from a preset.
 * The write covers exactly the route's declaration plus its route-level
 * compatibility; credentials are never written, and no existing field of an
 * unrelated route is touched.
 * @param preset - preset to apply.
 * @param routePath - path to the route inside the namespace, e.g. `['providers', '<id>']`.
 * @returns ordered operations for one atomic mutation.
 */
export function presetOps(preset: Preset, routePath: readonly string[]): PathOp[] {
  const base = [...routePath]
  const ops: PathOp[] = [
    { op: 'set', path: [...base, 'displayName'], value: preset.name },
    { op: 'set', path: [...base, 'api'], value: preset.api },
    { op: 'set', path: [...base, 'baseURL'], value: preset.baseURL },
    { op: 'set', path: [...base, 'apiKeyEnv'], value: preset.apiKeyEnv },
    { op: 'set', path: [...base, 'models'], value: preset.models.map(modelValue) },
  ]
  for (const [field, value] of Object.entries(preset.compat)) {
    if (value === undefined) continue
    ops.push({ op: 'set', path: [...base, 'compat', field], value: value as Json })
  }
  return ops
}

/** Editable boolean compat fields, in render order. */
export const COMPAT_SWITCHES = ['supportsDeveloperRole', 'supportsReasoningEffort', 'supportsThinkingTokenBudget'] as const

/** Editable text compat field carrying a JSON object. */
export const COMPAT_KWARGS = 'chatTemplateKwargs'

/** One compat editor draft: every field as text, `''` meaning "auto". */
export interface CompatDraft {
  readonly thinkingFormat: string
  readonly maxTokensField: string
  readonly supportsDeveloperRole: string
  readonly supportsReasoningEffort: string
  readonly supportsThinkingTokenBudget: string
  readonly chatTemplateKwargs: string
}

/** An empty draft: every field left to auto-detection. */
export const EMPTY_DRAFT: CompatDraft = {
  thinkingFormat: '',
  maxTokensField: '',
  supportsDeveloperRole: '',
  supportsReasoningEffort: '',
  supportsThinkingTokenBudget: '',
  chatTemplateKwargs: '',
}

/**
 * Read the stored compat into an editable draft.
 * Only the fields this editor owns are read; anything else stays untouched.
 * @param stored - the route's stored compat object, when one exists.
 * @returns draft values, `''` for every field that is not explicitly set.
 */
export function compatDraftOf(stored: unknown): CompatDraft {
  const source = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {}
  const text = (field: string): string => {
    const value = source[field]
    if (typeof value === 'string') return value
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return ''
  }
  const kwargs = source[COMPAT_KWARGS]
  return {
    thinkingFormat: text('thinkingFormat'),
    maxTokensField: text('maxTokensField'),
    supportsDeveloperRole: text('supportsDeveloperRole'),
    supportsReasoningEffort: text('supportsReasoningEffort'),
    supportsThinkingTokenBudget: text('supportsThinkingTokenBudget'),
    chatTemplateKwargs: typeof kwargs === 'object' && kwargs !== null && Object.keys(kwargs).length > 0
      ? JSON.stringify(kwargs, null, 2)
      : '',
  }
}

/** Outcome of validating one draft. */
export type CompatParse =
  | { readonly ops: PathOp[]; readonly error?: undefined }
  | { readonly error: 'invalidKwargs'; readonly ops?: undefined }

/**
 * Turn a draft into operations, clearing every field left on "auto".
 *
 * `unset` is the only way back to pi-ai's own detection, so an emptied field
 * must delete the key instead of writing an empty value.
 * @param compatPath - path to the route's compat block.
 * @param draft - editor values.
 * @returns operations to write, or the validation error.
 */
export function compatOps(compatPath: readonly string[], draft: CompatDraft): CompatParse {
  const base = [...compatPath]
  const ops: PathOp[] = []
  const setOrUnset = (field: string, value: Json | undefined): void => {
    if (value === undefined) ops.push({ op: 'unset', path: [...base, field] })
    else ops.push({ op: 'set', path: [...base, field], value })
  }
  const text = (value: string): string | undefined => {
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  setOrUnset('thinkingFormat', text(draft.thinkingFormat))
  setOrUnset('maxTokensField', text(draft.maxTokensField))
  for (const field of COMPAT_SWITCHES) {
    const value = text(draft[field])
    setOrUnset(field, value === undefined ? undefined : value === 'true')
  }
  const kwargs = draft.chatTemplateKwargs.trim()
  if (kwargs.length === 0) {
    setOrUnset(COMPAT_KWARGS, undefined)
    return { ops }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(kwargs)
  } catch {
    return { error: 'invalidKwargs' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'invalidKwargs' }
  setOrUnset(COMPAT_KWARGS, parsed as Json)
  return { ops }
}

/**
 * Summary line for a preset's compatibility, for the preview panel.
 * @param preset - preset being previewed.
 * @returns field names the preset will write, in stable order.
 */
export function compatSummary(preset: Preset): string[] {
  return Object.entries(preset.compat)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => `${field}=${String(value)}`)
}
