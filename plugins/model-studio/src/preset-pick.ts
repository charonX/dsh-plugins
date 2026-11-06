/**
 * Build-time selection: turn one models.dev provider entry into a preset.
 *
 * Everything here is pure and runs at generation time only — the browser half
 * receives the finished preset. The rules implemented here are the design's
 * R1–R7 (docs/DESIGN.md §4.2): which shapes justify declaring a thinking
 * format, when auto-detection already knows better, which models may travel
 * with a route, and what the reasoning ladder looks like.
 *
 * @module dsh-model-studio/preset-pick
 */

import { switchFormatOf, profileOf, type ReasoningOption, type ReasoningProfile } from './dialect.ts'
import type { Preset, PresetCompat, PresetModel } from './shared/preset.ts'

/** One `reasoning_options` entry as models.dev publishes it. */
export interface ModelsDevReasoningOption {
  readonly type: string
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
}

/** One model entry as models.dev publishes it. */
export interface ModelsDevModel {
  readonly id: string
  readonly name?: string
  readonly tool_call?: boolean
  readonly reasoning?: boolean
  readonly last_updated?: string
  readonly reasoning_options?: readonly ModelsDevReasoningOption[]
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly modalities?: { readonly input?: readonly string[] }
}

/** One provider entry as models.dev publishes it. */
export interface ModelsDevProvider {
  readonly id: string
  readonly name?: string
  readonly api?: string
  readonly env?: readonly string[]
  readonly npm?: string
  readonly doc?: string
  readonly models?: Readonly<Record<string, ModelsDevModel>>
}

/** Providers that serve the chat-completions wire shape this plugin can configure. */
const OPENAI_COMPATIBLE_NPM: readonly string[] = ['@ai-sdk/openai-compatible', '@ai-sdk/openai']

/**
 * Endpoint fragments pi-ai's `detectCompat()` already recognises. A preset for
 * one of these must not declare a thinking format: pi-ai's own answer is more
 * informed than a shape guess. Source: `pi-ai/dist/api/openai-completions.js`
 * `detectCompat()`; update both together.
 */
const DETECTED_ENDPOINT_FRAGMENTS: readonly string[] = [
  'deepseek.com',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.together.ai',
  'api.together.xyz',
  'openrouter.ai',
  'api.ant-ling.com',
  'api.x.ai',
  'chutes.ai',
  'api.cloudflare.com',
  'gateway.ai.cloudflare.com',
  'integrate.api.nvidia.com',
  'cerebras.ai',
  'opencode.ai',
  'api.moonshot.',
]

/**
 * Normalise published options into the dialect vocabulary.
 * models.dev writes `type` as a plain string; an option type this plugin does
 * not model is dropped instead of being guessed at.
 * @param raw - published `reasoning_options`, when present.
 * @returns options the dialect functions accept.
 */
export function optionsOf(raw: readonly ModelsDevReasoningOption[] | undefined): ReasoningOption[] {
  const options: ReasoningOption[] = []
  for (const option of raw ?? []) {
    if (option.type === 'toggle') options.push({ type: 'toggle' })
    else if (option.type === 'effort') {
      options.push({ type: 'effort', ...option.values === undefined ? {} : { values: option.values } })
    } else if (option.type === 'budget_tokens') {
      options.push({
        type: 'budget_tokens',
        ...option.min === undefined ? {} : { min: option.min },
        ...option.max === undefined ? {} : { max: option.max },
      })
    }
  }
  return options
}

/** Levels the adapter accepts as `reasoningEfforts` keys, least to greatest. */
const LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Route ids are used as settings keys, so they stay inside a conservative slug set. */
const ROUTE_ID = /^[a-z0-9][a-z0-9._-]*$/

/** Credential references must name an environment-style identifier. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `detectCompat()` owns this endpoint's dialect. */
export function isDetectedEndpoint(baseURL: string): boolean {
  const normalized = baseURL.toLowerCase()
  return DETECTED_ENDPOINT_FRAGMENTS.some(fragment => normalized.includes(fragment))
}

/**
 * Whether this provider speaks the OpenAI chat-completions shape.
 * An Anthropic-only or multi-tenant gateway cannot be configured from a shape
 * guess, so it never becomes a preset.
 */
export function isOpenAiCompatible(provider: ModelsDevProvider): boolean {
  if (provider.api === undefined || provider.api.trim().length === 0) return false
  const npm = provider.npm
  if (npm === OPENAI_COMPATIBLE_NPM[0]) return true
  // The OpenAI SDK family is only chat-completions here when the endpoint is a
  // plain `/v1` base; the Responses-API endpoints are not.
  return npm === OPENAI_COMPATIBLE_NPM[1] && /\/v1\/?$/u.test(provider.api.trim())
}

/** How a model's documented reasoning control is expressed. */
type ControlClass = 'switch' | 'effort' | 'none'

/**
 * Classify one documented profile.
 * `switch` covers toggle and budget shapes: pi-ai's fallback sends nothing for
 * `off`, so these are the routes a thinking format must be declared for.
 * @param profile - documented control shapes.
 * @returns the class a preset groups models by.
 */
export function controlClass(profile: ReasoningProfile): ControlClass {
  if (profile.shapes.includes('toggle') || profile.shapes.includes('budget')) return 'switch'
  if (profile.shapes.includes('effort')) return 'effort'
  return 'none'
}

/** One candidate model plus the facts selection needs. */
interface Candidate {
  readonly model: ModelsDevModel
  readonly profile: ReasoningProfile
  readonly kind: ControlClass
  readonly updated: string
}

/**
 * Rank every model of one provider.
 * Preference order is documented tool calling, documented reasoning, then the
 * most recently updated entry; the id breaks ties so regeneration is stable.
 * @param provider - provider entry.
 * @returns ranked candidates, best first.
 */
function rankModels(provider: ModelsDevProvider): Candidate[] {
  return Object.values(provider.models ?? {})
    .map((model): Candidate => {
      const profile = profileOf(optionsOf(model.reasoning_options))
      return { model, profile, kind: controlClass(profile), updated: model.last_updated ?? '' }
    })
    .sort((left, right) =>
      Number(right.model.tool_call === true) - Number(left.model.tool_call === true)
      || Number(right.model.reasoning === true) - Number(left.model.reasoning === true)
      || right.updated.localeCompare(left.updated)
      || left.model.id.localeCompare(right.model.id))
}

/**
 * Pick the representative models that travel with a route.
 *
 * Only models whose documented control class matches the provider's dominant
 * reasoning class are eligible: the route-level compat is one value for every
 * model, so a mixed selection would give some of them a dialect they do not
 * speak. Providers documenting no reasoning at all keep their ranked models.
 * @param provider - provider entry.
 * @returns up to three models, or none when the entry is unusable.
 */
export function pickModels(provider: ModelsDevProvider): ModelsDevModel[] {
  const ranked = rankModels(provider)
  const reasoning = ranked.filter(candidate => candidate.kind !== 'none')
  const counts = new Map<ControlClass, number>()
  for (const candidate of reasoning) counts.set(candidate.kind, (counts.get(candidate.kind) ?? 0) + 1)
  let dominant: ControlClass = 'none'
  let best = 0
  for (const kind of ['switch', 'effort'] as const) {
    const count = counts.get(kind) ?? 0
    // `switch` wins ties: a budget/toggle gateway that also documents effort
    // levels still needs a declared format for `off` to mean anything.
    if (count > best) {
      dominant = kind
      best = count
    }
  }
  const eligible = dominant === 'none' ? ranked : ranked.filter(candidate => candidate.kind === dominant)
  return eligible.slice(0, 3).map(candidate => candidate.model)
}

/**
 * Documented levels a model declares, in escalation order.
 * `off` always leads and keeps an empty wire value: the wire spelling of "off"
 * belongs to the thinking format, not to the level name.
 * @param profile - one model's documented control shapes.
 * @returns declared levels, or undefined when the model documents no reasoning.
 */
export function effortsOf(profile: ReasoningProfile): Record<string, string | null> | undefined {
  if (profile.shapes.length === 0) return undefined
  const documented = new Set(profile.effortValues)
  const efforts: Record<string, string | null> = { off: null }
  for (const level of LEVELS) {
    if (documented.has(level)) efforts[level] = level
  }
  // A switch-only model still needs one level to name its "on" state.
  if (Object.keys(efforts).length === 1) efforts['high'] = 'high'
  return efforts
}

/**
 * Route compatibility derived from documented shapes.
 * A declared format is written only for switch-shaped routes, and never for an
 * endpoint pi-ai already recognises; the budget flag follows the documented
 * budget capability.
 * @param profile - aggregate control shapes of the selected models.
 * @param detected - whether pi-ai's own detection owns this endpoint.
 * @returns the compat block a preset writes, without the role switch.
 */
export function compatOf(profile: ReasoningProfile, detected: boolean): PresetCompat {
  const compat: { -readonly [K in keyof PresetCompat]: PresetCompat[K] } = {}
  // Only a switch-shaped dialect carries a wire spelling for `off`; an effort
  // dialect would leave `off` sending nothing, which is the exact failure this
  // plugin exists to fix.
  const format = switchFormatOf(profile)
  if (!detected && controlClass(profile) === 'switch' && format !== undefined) compat.thinkingFormat = format
  // The budget capability is deliberately NOT decided here: it is documented per
  // model, and a route-level flag would send the field to every model on the
  // route. {@link presetModelOf} attaches it to the models that take one.
  return compat
}

/** Input modalities inside the adapter's vocabulary. */
const INPUT_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/**
 * Turn one snapshot model into the entry a preset writes.
 * @param model - snapshot model.
 * @returns the preset model, or undefined when the entry has no usable id.
 */
export function presetModelOf(model: ModelsDevModel): PresetModel | undefined {
  if (model.id.trim().length === 0) return undefined
  const profile = profileOf(optionsOf(model.reasoning_options))
  const contextWindow = model.limit?.context
  const maxTokens = model.limit?.output
  const declared = (model.modalities?.input ?? []).filter((modality): modality is 'text' | 'image' =>
    (INPUT_MODALITIES as readonly string[]).includes(modality))
  const input: readonly ('text' | 'image')[] = declared.length === 0 ? ['text'] : [...new Set(declared)]
  const efforts = effortsOf(profile)
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {},
    ...typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {},
    input,
    ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    ...profile.shapes.includes('budget') ? { compat: { supportsThinkingTokenBudget: true } } : {},
  }
}

/**
 * Build one preset from a provider entry.
 * @param provider - provider entry as published.
 * @returns the preset, or undefined when this gateway cannot be configured safely
 * (unknown protocol, no endpoint, no credential reference, no usable model).
 */
export function buildPreset(provider: ModelsDevProvider): Preset | undefined {
  if (!ROUTE_ID.test(provider.id)) return undefined
  if (!isOpenAiCompatible(provider)) return undefined
  const baseURL = provider.api?.trim()
  if (baseURL === undefined || !/^https?:\/\//u.test(baseURL)) return undefined
  const apiKeyEnv = provider.env?.[0]
  if (apiKeyEnv === undefined || !CREDENTIAL_REF.test(apiKeyEnv)) return undefined
  const chosen = pickModels(provider)
  const models = chosen.map(presetModelOf).filter((model): model is PresetModel => model !== undefined)
  if (models.length === 0) return undefined
  const shapes = chosen.flatMap(model => optionsOf(model.reasoning_options))
  const compat = compatOf(profileOf(shapes), isDetectedEndpoint(baseURL))
  const declaresReasoning = models.some(model => model.reasoningEfforts !== undefined)
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    api: 'openai-completions',
    baseURL,
    apiKeyEnv,
    ...provider.doc === undefined ? {} : { doc: provider.doc },
    // Declaring reasoning makes pi-ai send the system prompt as `developer` on
    // every route it does not recognise; a preset must neutralise that itself
    // (SPEC §3.4). Written only for routes this plugin creates.
    compat: declaresReasoning ? { ...compat, supportsDeveloperRole: false } : compat,
    models,
  }
}
