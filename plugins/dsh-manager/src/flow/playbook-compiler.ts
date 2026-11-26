/**
 * One-shot Playbook -> Flow IR compiler with SHA-256 hash caching.
 *
 * Strategy (compile once, reuse forever until source changes):
 * 1. If `existingFlow?.source?.hash === contentHash`: immediate cache hit (zero work).
 * 2. Deterministic tier (zero LLM cost):
 *    - Parse optional YAML frontmatter (`name`, `when`/`description`, `workspaceMode`, `steps[]`).
 *    - If explicit `steps[]` exist in frontmatter, materialize them directly.
 *    - Otherwise extract ordered Markdown steps (`1. ...`, `## Step ...`, `### 1. ...`),
 *      auto-matching referenced skill names from `availableSkillNames`, inferring `readOnly`
 *      for inspection/review steps, and wiring `onFail` rework loops on verification gates.
 * 3. Optional LLM fallback tier (only when prose yields < 2 clear steps and `compileWithLlm`
 *    is provided): runs a single structured JSON extraction call and validates via Zod.
 * 4. On recompile (`existingFlow` present with stale hash), preserves user's per-step
 *    runtime bindings (`agent`, `humanConfirm`) matched by step id or position.
 */
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  WORKSPACE_MODES,
  flowDefSchema,
  normalizeStepInputs,
  validateFlows,
  type FlowDef,
  type FlowStepDef,
  type FlowStepInput,
  type WorkspaceMode,
} from './flow-ir.ts'

export interface CompilePlaybookInput {
  readonly kind: 'skill' | 'file'
  readonly ref: string
  readonly content: string
  readonly availableSkillNames?: readonly string[]
  readonly existingFlow?: FlowDef
  readonly compileWithLlm?: (prompt: string) => Promise<string>
  readonly now?: number
  readonly idFactory?: (prefix: string) => string
}

export interface CompilePlaybookResult {
  readonly flow: FlowDef
  readonly cacheHit: boolean
  readonly method: 'cache' | 'frontmatter' | 'markdown' | 'llm'
}

export function hashPlaybookContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

interface ParsedFrontmatter {
  readonly meta: Record<string, unknown>
  readonly body: string
}

function splitFrontmatter(markdown: string): ParsedFrontmatter {
  const trimmed = markdown.trimStart()
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: markdown }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed)
  if (match === null) {
    return { meta: {}, body: markdown }
  }
  try {
    const parsed = parseYaml(match[1] ?? '')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { meta: parsed as Record<string, unknown>, body: match[2] ?? '' }
    }
  } catch {
    // Malformed frontmatter falls back to plain markdown body parsing.
  }
  return { meta: {}, body: match[2] ?? '' }
}

function slugifyId(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned === '' ? fallback : cleaned
}

function extractTitleFromMarkdown(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+)$/.exec(line.trim())
    if (heading?.[1] !== undefined) {
      return heading[1].replace(/[`*_#]/g, '').trim().slice(0, 60) || fallback
    }
  }
  return fallback
}

function inferWorkspaceMode(text: string): WorkspaceMode {
  if (/\b(worktree|git branch|pull request|opening a pr|local_merge_branch|push_branch)\b/i.test(text)) {
    return 'worktree'
  }
  return 'in-place'
}

function detectReferencedSkills(text: string, availableSkillNames: readonly string[]): string[] {
  if (availableSkillNames.length === 0) return []
  const found: string[] = []
  const seen = new Set<string>()
  const lower = text.toLowerCase()
  for (const skillName of availableSkillNames) {
    const escaped = skillName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'i')
    if (pattern.test(lower) && !seen.has(skillName)) {
      seen.add(skillName)
      found.push(skillName)
    }
  }
  return found
}

function isReadOnlyStepText(text: string): boolean {
  return /\b(read-only|readonly|investigate|reproduce|repro|review|audit|inspect|verify)\b|只读|复现|调研|审查|核验|自检/i.test(text)
}

function isGateStepText(text: string): boolean {
  return /\b(review|gate|verify|check|rework|on fail)\b|审查|验收|复测|自检|打回/i.test(text)
}

function isWriteLikeStepText(text: string): boolean {
  return /\b(implement|fix|write|draft|edit|refactor|build|patch)\b|实现|修复|撰写|编写|起草|修改/i.test(text)
}

function stripStepDecoration(raw: string): string {
  return raw
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function extractMarkdownSteps(
  body: string,
  availableSkillNames: readonly string[],
): FlowStepInput[] {
  const lines = body.split(/\r?\n/)
  const rawSteps: { readonly title: string; readonly detail: string }[] = []

  // First try numbered list items (`1. ...`, `2. ...`) at top indentation.
  let currentNumbered: { title: string; details: string[] } | undefined
  for (const line of lines) {
    const numMatch = /^\s*(\d+)\.\s+(.+)$/.exec(line)
    if (numMatch?.[2] !== undefined) {
      if (currentNumbered !== undefined) {
        rawSteps.push({
          title: currentNumbered.title,
          detail: currentNumbered.details.join(' ').trim(),
        })
      }
      const cleaned = stripStepDecoration(numMatch[2])
      // Split title from detail on punctuation (`: `, `：`, `. `) or spaced dashes (` - ` / ` — `),
      // never on intra-word hyphens such as `ship-pr` or `read-only`.
      const splitMatch = /^([^:：—–]{2,48}?)(?:[:：]\s*|\.\s+|\s+[—–-]+\s*|[—–]\s+)(.+)$/.exec(cleaned)
      currentNumbered = splitMatch !== null
        ? { title: splitMatch[1]!.trim(), details: [splitMatch[2]!.trim()] }
        : { title: cleaned.slice(0, 48), details: [cleaned] }
      continue
    }
    if (currentNumbered !== undefined) {
      const trimmed = line.trim()
      if (trimmed === '' || /^#{1,4}\s+/.test(trimmed)) {
        rawSteps.push({
          title: currentNumbered.title,
          detail: currentNumbered.details.join(' ').trim(),
        })
        currentNumbered = undefined
      } else if (/^[-*]\s+/.test(trimmed) || /^\s{2,}/.test(line)) {
        currentNumbered.details.push(stripStepDecoration(trimmed.replace(/^[-*]\s+/, '')))
      }
    }
  }
  if (currentNumbered !== undefined) {
    rawSteps.push({
      title: currentNumbered.title,
      detail: currentNumbered.details.join(' ').trim(),
    })
  }

  // If numbered steps were sparse, look for `## Step` / `### Phase` headings.
  if (rawSteps.length < 2) {
    const headingSteps: { title: string; detail: string }[] = []
    let currentHeading: { title: string; details: string[] } | undefined
    for (const line of lines) {
      const hMatch = /^#{2,3}\s+(.+)$/.exec(line.trim())
      if (hMatch?.[1] !== undefined) {
        if (currentHeading !== undefined) {
          headingSteps.push({
            title: currentHeading.title,
            detail: currentHeading.details.join(' ').trim(),
          })
        }
        const headingText = stripStepDecoration(hMatch[1])
        if (!/^(reply|start|overview|notes?|references?|pitfalls?)$/i.test(headingText)) {
          currentHeading = { title: headingText.slice(0, 48), details: [] }
        } else {
          currentHeading = undefined
        }
        continue
      }
      if (currentHeading !== undefined) {
        const trimmed = line.trim()
        if (trimmed !== '' && !trimmed.startsWith('```')) {
          currentHeading.details.push(stripStepDecoration(trimmed.replace(/^[-*]\s+/, '')))
        }
      }
    }
    if (currentHeading !== undefined) {
      headingSteps.push({
        title: currentHeading.title,
        detail: currentHeading.details.join(' ').trim(),
      })
    }
    if (headingSteps.length > rawSteps.length) {
      rawSteps.splice(0, rawSteps.length, ...headingSteps)
    }
  }

  const normalized = rawSteps.slice(0, 8).map((entry, idx) => {
    const combined = `${entry.title} ${entry.detail}`
    const skills = detectReferencedSkills(combined, availableSkillNames)
    const id = slugifyId(entry.title, `step-${idx + 1}`)
    const readOnly = isReadOnlyStepText(entry.title) || (!isWriteLikeStepText(entry.title) && isReadOnlyStepText(combined))
    return {
      id,
      name: entry.title.slice(0, 60) || `Step ${idx + 1}`,
      skills,
      ...(entry.detail !== '' ? { goal: entry.detail.slice(0, 500) } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    } satisfies FlowStepInput
  })

  // Wire `onFail` automatically on gate/review steps to the closest preceding writable step.
  let lastWritableId: string | undefined
  return normalized.map((step, idx) => {
    if (step.readOnly !== true) {
      lastWritableId = step.id ?? `step-${idx + 1}`
      return step
    }
    if (lastWritableId !== undefined && isGateStepText(`${step.name} ${step.goal ?? ''}`)) {
      return { ...step, onFail: lastWritableId }
    }
    return step
  })
}

const frontmatterStepSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  skills: z.array(z.string().trim().min(1)).default([]),
  goal: z.string().trim().optional(),
  readOnly: z.boolean().optional(),
  onFail: z.string().trim().min(1).optional(),
  humanConfirm: z.boolean().optional(),
})

const llmFlowExtractionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  when: z.string().trim().min(1).max(500),
  workspaceMode: z.enum(WORKSPACE_MODES).default('in-place'),
  steps: z.array(frontmatterStepSchema).min(1).max(8),
})

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in LLM compiler response')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

function preserveUserBindings(
  compiledSteps: readonly FlowStepDef[],
  previous: FlowDef | undefined,
): readonly FlowStepDef[] {
  if (previous === undefined) return compiledSteps
  return compiledSteps.map((step, index) => {
    const match = previous.steps.find(prev => prev.id === step.id || prev.name === step.name)
      ?? previous.steps[index]
    if (match === undefined) return step
    return {
      ...step,
      ...(match.agent === undefined ? {} : { agent: match.agent }),
      ...(match.humanConfirm === undefined ? {} : { humanConfirm: match.humanConfirm }),
    }
  })
}

/**
 * Compile a Playbook Markdown or Skill file into a cached FlowDef.
 * Returns immediately on `source.hash` match without touching LLM.
 */
export async function compilePlaybookToFlow(input: CompilePlaybookInput): Promise<CompilePlaybookResult> {
  const now = input.now ?? Date.now()
  const hash = hashPlaybookContent(input.content)
  if (input.existingFlow?.source?.hash === hash) {
    return { flow: input.existingFlow, cacheHit: true, method: 'cache' }
  }

  const idFactory = input.idFactory ?? ((prefix: string) => `${prefix}-${crypto.randomUUID()}`)
  const availableSkillNames = input.availableSkillNames ?? []
  const { meta, body } = splitFrontmatter(input.content)

  const refBase = input.ref.split('/').pop()?.replace(/\.md$/i, '') || 'playbook'
  const metaName = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim().slice(0, 60) : undefined
  const metaWhen = typeof meta.when === 'string' && meta.when.trim() !== ''
    ? meta.when.trim()
    : (typeof meta.description === 'string' && meta.description.trim() !== '' ? meta.description.trim() : undefined)
  const metaWorkspaceMode = WORKSPACE_MODES.includes(meta.workspaceMode as WorkspaceMode)
    ? (meta.workspaceMode as WorkspaceMode)
    : undefined

  // Tier 1a: Explicit frontmatter `steps[]`.
  const parsedFrontmatterSteps = z.array(frontmatterStepSchema).safeParse(meta.steps)
  if (parsedFrontmatterSteps.success && parsedFrontmatterSteps.data.length > 0) {
    const steps = preserveUserBindings(normalizeStepInputs(parsedFrontmatterSteps.data), input.existingFlow)
    const name = metaName ?? extractTitleFromMarkdown(body, refBase)
    const flow = flowDefSchema.parse({
      id: input.existingFlow?.id ?? idFactory(`flow-${slugifyId(name, 'playbook')}`),
      name,
      enabled: input.existingFlow?.enabled ?? true,
      when: metaWhen ?? `${name} 相关任务`,
      workspaceMode: metaWorkspaceMode ?? inferWorkspaceMode(input.content),
      source: { kind: input.kind, ref: input.ref, hash, compiledAt: now },
      steps,
      createdAt: input.existingFlow?.createdAt ?? now,
      updatedAt: now,
    })
    validateFlows([flow])
    return { flow, cacheHit: false, method: 'frontmatter' }
  }

  // Tier 1b: Deterministic Markdown ordered list / heading extraction.
  const markdownSteps = extractMarkdownSteps(body, availableSkillNames)
  if (markdownSteps.length >= 2 || input.compileWithLlm === undefined) {
    const fallbackStep: FlowStepInput[] = markdownSteps.length > 0
      ? markdownSteps
      : [{
          id: 'execute',
          name: metaName ?? extractTitleFromMarkdown(body, refBase),
          skills: detectReferencedSkills(input.content, availableSkillNames),
          goal: body.trim().slice(0, 500) || `Follow playbook ${input.ref}`,
        }]
    const steps = preserveUserBindings(normalizeStepInputs(fallbackStep), input.existingFlow)
    const name = metaName ?? extractTitleFromMarkdown(body, refBase)
    const flow = flowDefSchema.parse({
      id: input.existingFlow?.id ?? idFactory(`flow-${slugifyId(name, 'playbook')}`),
      name,
      enabled: input.existingFlow?.enabled ?? true,
      when: metaWhen ?? `${name} 相关任务`,
      workspaceMode: metaWorkspaceMode ?? inferWorkspaceMode(input.content),
      source: { kind: input.kind, ref: input.ref, hash, compiledAt: now },
      steps,
      createdAt: input.existingFlow?.createdAt ?? now,
      updatedAt: now,
    })
    validateFlows([flow])
    return { flow, cacheHit: false, method: 'markdown' }
  }

  // Tier 2: One-shot LLM extraction for unstructured prose playbooks.
  const prompt = [
    'Convert this playbook markdown into one compact JSON Flow IR object (no markdown commentary outside JSON).',
    `Available skills you can reference in steps[].skills: ${availableSkillNames.join(', ') || '(none)'}.`,
    'JSON shape: { "name": string, "when": string, "workspaceMode": "in-place"|"worktree"|"auto", "steps": [{ "id": string, "name": string, "skills": string[], "goal": string, "readOnly"?: boolean, "onFail"?: string }] }.',
    'Playbook:',
    input.content.slice(0, 12_000),
  ].join('\n\n')
  try {
    const rawResponse = await input.compileWithLlm(prompt)
    const parsed = llmFlowExtractionSchema.parse(extractJsonObject(rawResponse))
    const stepIds = new Set(parsed.steps.map((s, i) => s.id ?? `step-${i + 1}`))
    const safeSteps = parsed.steps.map((s, i) => ({
      ...s,
      id: s.id ?? `step-${i + 1}`,
      skills: (s.skills ?? []).filter(sk => availableSkillNames.length === 0 || availableSkillNames.includes(sk)),
      ...(s.onFail !== undefined && (s.onFail === 'self' || stepIds.has(s.onFail)) ? { onFail: s.onFail } : { onFail: undefined }),
    }))
    const steps = preserveUserBindings(normalizeStepInputs(safeSteps), input.existingFlow)
    const flow = flowDefSchema.parse({
      id: input.existingFlow?.id ?? idFactory(`flow-${slugifyId(parsed.name, 'playbook')}`),
      name: metaName ?? parsed.name,
      enabled: input.existingFlow?.enabled ?? true,
      when: metaWhen ?? parsed.when,
      workspaceMode: metaWorkspaceMode ?? parsed.workspaceMode,
      source: { kind: input.kind, ref: input.ref, hash, compiledAt: now },
      steps,
      createdAt: input.existingFlow?.createdAt ?? now,
      updatedAt: now,
    })
    validateFlows([flow])
    return { flow, cacheHit: false, method: 'llm' }
  } catch {
    // Safe fallback to deterministic single-step flow when LLM extraction fails.
    const name = metaName ?? extractTitleFromMarkdown(body, refBase)
    const steps = preserveUserBindings(normalizeStepInputs([{
      id: 'execute',
      name,
      skills: detectReferencedSkills(input.content, availableSkillNames),
      goal: body.trim().slice(0, 500) || `Follow playbook ${input.ref}`,
    }]), input.existingFlow)
    const flow = flowDefSchema.parse({
      id: input.existingFlow?.id ?? idFactory(`flow-${slugifyId(name, 'playbook')}`),
      name,
      enabled: input.existingFlow?.enabled ?? true,
      when: metaWhen ?? `${name} 相关任务`,
      workspaceMode: metaWorkspaceMode ?? inferWorkspaceMode(input.content),
      source: { kind: input.kind, ref: input.ref, hash, compiledAt: now },
      steps,
      createdAt: input.existingFlow?.createdAt ?? now,
      updatedAt: now,
    })
    validateFlows([flow])
    return { flow, cacheHit: false, method: 'markdown' }
  }
}
