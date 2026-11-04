/**
 * Intent Router (inspired by yetone/magpie).
 * Dynamically infers task intent, model tier, priority, execution timing,
 * and operational skills from event metadata with an auditable triage log.
 *
 * @module @charonx/dsh-autoloop/core/router
 */

import type {
  IngressEvent,
  PriorityLevel,
  RouterTriage,
  ScheduleMode,
  TaskCategory,
  TicketMandate,
} from '../shared/types.js'
import { SecurityGuard } from './security.js'

export interface RouterOptions {
  defaultWorkspacePath: string
  flagshipModel?: { provider?: string; model?: string }
  fastModel?: { provider?: string; model?: string }
}

export const CATEGORY_LABELS: Record<string, string> = {
  bugfix: '缺陷修复',
  feature: '功能开发',
  refactor: '架构治理',
  testing: '测试验证',
  documentation: '文档运维',
  review: '审查调研',
  general: '通用任务',
}

export const SOURCE_LABELS: Record<string, string> = {
  'manual-ui': '中台手动创建',
  feishu: '飞书工单',
  github: 'GitHub',
  sentry: 'Sentry 告警',
  cron: '定时巡检',
  webhook: '外部 Webhook',
}

export class IntentRouter {
  constructor(private readonly options: RouterOptions) {}

  /** Route an IngressEvent into a TicketMandate with comprehensive Triage */
  route(event: IngressEvent): TicketMandate {
    const text = `${event.summary} ${JSON.stringify(event.payload ?? {})}`.toLowerCase()
    const matchedRules: string[] = []

    // 1. Resolve Intent / Category
    let intent: TaskCategory = 'general'
    const explicitCategory = event.payload?.category
    if (typeof explicitCategory === 'string' && explicitCategory && explicitCategory !== 'auto') {
      intent = explicitCategory
      matchedRules.push(`用户指定分类: ${CATEGORY_LABELS[intent] || intent}`)
    } else {
      if (/error|exception|fail|crash|bug|fix|panic|sentry|报错|异常|崩溃|修复|缺陷|失败|500/.test(text)) {
        intent = 'bugfix'
        matchedRules.push('匹配缺陷与异常关键词 (error/crash/bug/修复/报错)')
      } else if (/refactor|governance|reorganize|structure|cleanup|debt|重构|治理|解耦|坏味|精简/.test(text)) {
        intent = 'refactor'
        matchedRules.push('匹配架构治理关键词 (refactor/重构/治理/解耦)')
      } else if (/test|spec|e2e|unit test|coverage|vitest|jest|测试|单测|用例|覆盖率|回归/.test(text)) {
        intent = 'testing'
        matchedRules.push('匹配质量测试关键词 (test/spec/测试/用例/回归)')
      } else if (/doc|readme|markdown|deploy|ci|cd|ops|流水线|文档|部署|发布|配置/.test(text)) {
        intent = 'documentation'
        matchedRules.push('匹配文档运维关键词 (doc/deploy/ci/文档/部署)')
      } else if (/review|audit|diff|pr|research|investigate|审查|评估|调研|对比|巡检/.test(text)) {
        intent = 'review'
        matchedRules.push('匹配审查调研关键词 (review/audit/审查/调研/评估)')
      } else if (/feat|implement|create|build|develop|add|enhance|新增|实现|开发|支持|功能|改进/.test(text)) {
        intent = 'feature'
        matchedRules.push('匹配功能演进关键词 (feat/add/新增/实现/功能)')
      } else {
        intent = 'general'
        matchedRules.push('未匹配特定意图规则，归入通用任务')
      }
    }

    // 2. Resolve Operational Skills
    let skills: string[] = []
    switch (intent) {
      case 'bugfix':
        skills = ['diagnosing-bugs']
        break
      case 'refactor':
        skills = ['codebase-design']
        break
      case 'testing':
        skills = ['tdd']
        break
      case 'documentation':
        skills = ['codebase-design']
        break
      case 'review':
        skills = ['code-review', 'research']
        break
      case 'feature':
        skills = ['codebase-design', 'tdd']
        break
      default:
        skills = []
        break
    }

    // 3. Resolve Priority (P0, P1, P2, P3)
    let priority: PriorityLevel = 'p2'
    const explicitPriority = event.payload?.priority
    if (typeof explicitPriority === 'string' && explicitPriority && explicitPriority !== 'auto') {
      priority = explicitPriority as PriorityLevel
      matchedRules.push(`用户显式指定优先级: ${priority.toUpperCase()}`)
    } else {
      if (/crash|panic|sentry|p0|紧急|致命|严重|阻断|线上|宕机/.test(text) || event.source === 'sentry') {
        priority = 'p0'
        matchedRules.push('检测到致命告警/紧急阻断指标 -> P0 紧急')
      } else if (intent === 'bugfix' || intent === 'feature') {
        priority = 'p1'
        matchedRules.push(`核心研发类别 (${CATEGORY_LABELS[intent]}) -> P1 高优`)
      } else if (/nightly|夜间|闲时|低峰|不急|低优/.test(text)) {
        priority = 'p3'
        matchedRules.push('意向为低峰/闲时处理 -> P3 低优')
      } else {
        priority = 'p2'
        matchedRules.push('常规研发与支持类别 -> P2 普通')
      }
    }

    // 4. Resolve Execution Schedule (immediate, nightly, scheduled)
    let scheduleMode: ScheduleMode = 'immediate'
    let scheduledAt: number | undefined = undefined
    const explicitSchedule = event.payload?.scheduleMode
    if (typeof explicitSchedule === 'string' && explicitSchedule) {
      scheduleMode = explicitSchedule as ScheduleMode
      matchedRules.push(`用户显式指定执行时机: ${scheduleMode === 'nightly' ? '夜间低峰' : scheduleMode === 'scheduled' ? '定时执行' : '立即执行'}`)
    } else if (/nightly|夜间|晚上|低峰|闲时|节省token|非工作时间/.test(text)) {
      scheduleMode = 'nightly'
      matchedRules.push('提示词中包含夜间/低峰关键词 -> 研判为夜间低峰执行')
    } else {
      scheduleMode = 'immediate'
      matchedRules.push('默认调度策略 -> 立即调度执行')
    }

    if (typeof event.payload?.scheduledAt === 'number' && event.payload.scheduledAt > 0) {
      scheduledAt = event.payload.scheduledAt
    }

    // 5. Model Selection
    let model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }
    if (event.payload?.model && typeof event.payload.model === 'object') {
      const m = event.payload.model as { provider?: string; model?: string }
      if (m.model && m.model !== 'default') {
        model = { provider: m.provider, model: m.model }
        matchedRules.push(`用户手动指定模型: ${m.model}`)
      }
    } else if (intent === 'feature' || intent === 'refactor' || intent === 'review') {
      model = this.options.flagshipModel ?? { provider: 'deepseek-official', model: 'deepseek-reasoner' }
      matchedRules.push(`复杂逻辑/架构治理任务 -> 推荐旗舰推理模型 (${model.model})`)
    } else {
      matchedRules.push(`轻量/诊断任务 -> 推荐高速通用模型 (${model.model})`)
    }

    // 6. Security & Workspace Permissions
    const permissionPreset = (typeof event.payload?.permissionPreset === 'string' && event.payload.permissionPreset) || 'workspace-write'
    const agentPreset = typeof event.payload?.agentPreset === 'string' ? event.payload.agentPreset : undefined

    let candidatePath = this.options.defaultWorkspacePath
    if (typeof event.payload?.workspacePath === 'string' && event.payload.workspacePath.trim()) {
      candidatePath = event.payload.workspacePath.trim()
    }

    const workspacePath = SecurityGuard.validateWorkspace(
      candidatePath,
      this.options.defaultWorkspacePath,
    )

    const instruction = SecurityGuard.constructSafeInstruction({
      summary: event.summary,
      intent,
      payload: event.payload,
    })

    // 7. Synthesize Triage Reasoning Narrative
    const categoryLabel = CATEGORY_LABELS[intent] || intent
    const sourceLabel = SOURCE_LABELS[event.source] || event.source
    const scheduleDesc = scheduleMode === 'nightly'
      ? '已排入「🌙 夜间低峰时段 (23:00~07:00)」自动批处理，可显著节省 Token 费用；期间支持随时手动一键唤醒。'
      : scheduleMode === 'scheduled'
      ? `已设定为「🕒 定时执行」(计划时间: ${scheduledAt ? new Date(scheduledAt).toLocaleString() : '待定'})。`
      : '设定为「⚡ 立即执行」，工单创建后自动分配 Agent 实时运行。'

    const reasoning = [
      `【任务意图研判】：根据输入内容，研判归属为「${categoryLabel}」。`,
      `【来源与优先级】：任务来源为「${sourceLabel}」，综合紧迫度评定为「${priority.toUpperCase()}」。`,
      `【执行时机决策】：${scheduleDesc}`,
      `【资源技能装配】：模型配置为 [${model.model ?? '系统默认'}]，安全沙箱设为「${permissionPreset}」，挂载专业技能 [${skills.join(', ') || '通用基础'}]。`,
    ].join('\n')

    const triage: RouterTriage = {
      intent,
      categoryLabel,
      priority,
      scheduleMode,
      scheduledAt,
      reasoning,
      matchedRules,
      recommendedModel: model.model ?? 'default',
      recommendedSkills: skills,
      permissionPreset,
      evaluatedAt: Date.now(),
    }

    return {
      intent,
      workspacePath,
      model,
      skills,
      instruction,
      permissionPreset,
      agentPreset,
      priority,
      scheduleMode,
      scheduledAt,
      triage,
    }
  }
}
