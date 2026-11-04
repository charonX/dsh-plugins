/**
 * Intent Router (inspired by yetone/magpie).
 * Acts as an intelligent triage role: dynamically infers task categories (development, design, ops,
 * marketing, etc.), extracts sources from text/metadata without rigid hardcoding,
 * identifies domain tags, and resolves priority and schedule timing.
 *
 * @module @charonx/dsh-autoloop/core/router
 */

import type {
  IngressEvent,
  OffpeakWindow,
  PriorityLevel,
  RouterTriage,
  ScheduleMode,
  TaskCategory,
  TicketMandate,
} from '../shared/types.js'
import { DEFAULT_OFFPEAK_WINDOW, describeOffpeak, resolveSchedule } from '../shared/schedule.js'
import { SecurityGuard } from './security.js'

export interface RouterOptions {
  defaultWorkspacePath: string
  flagshipModel?: { provider?: string; model?: string }
  fastModel?: { provider?: string; model?: string }
  /** Configured quiet-hours window; narration reads it instead of a literal. */
  offpeak?: OffpeakWindow
}

export interface DynamicCategoryRule {
  id: string
  label: string
  pattern: RegExp
  skills: string[]
  preferReasoner?: boolean
}

/** Open semantic category classification rules covering dev, design, ops, and business */
export const CATEGORY_RULES: DynamicCategoryRule[] = [
  {
    id: 'bugfix',
    label: '缺陷修复',
    pattern: /bug|error|exception|crash|panic|fail|sentry|故障|缺陷|报错|崩溃|异常|修复|500/i,
    skills: ['diagnosing-bugs'],
  },
  {
    id: 'ppt',
    label: 'PPT设计',
    pattern: /ppt|powerpoint|slide|幻灯片|演示文稿|演示/i,
    skills: ['codebase-design'],
    preferReasoner: true,
  },
  {
    id: 'ui_design',
    label: '视觉设计',
    pattern: /ui|壁纸|图标|动画|设计|界面|前端样式|css|排版|视觉|主题/i,
    skills: ['codebase-design'],
  },
  {
    id: 'operation',
    label: '运营策略',
    pattern: /运营|推广|策略|活动|营销|用户增长|转化|扫码/i,
    skills: ['research'],
  },
  {
    id: 'ops',
    label: '运维部署',
    pattern: /部署|发布|上线|运维|服务器|nginx|docker|k8s|电脑配置|机器/i,
    skills: ['codebase-design'],
  },
  {
    id: 'data',
    label: '数据分析',
    pattern: /数据|统计|分析|报表|埋点|指标|看板|人数/i,
    skills: ['research'],
  },
  {
    id: 'refactor',
    label: '架构治理',
    pattern: /refactor|governance|reorganize|structure|cleanup|debt|重构|治理|解耦|坏味|精简|契约/i,
    skills: ['codebase-design'],
    preferReasoner: true,
  },
  {
    id: 'testing',
    label: '测试验证',
    pattern: /test|spec|e2e|unit test|coverage|vitest|jest|测试|单测|用例|覆盖率|回归|验收/i,
    skills: ['tdd'],
  },
  {
    id: 'documentation',
    label: '文档方案',
    pattern: /doc|readme|markdown|文档|手册|方案|规范|纪要/i,
    skills: ['codebase-design'],
  },
  {
    id: 'review',
    label: '审查调研',
    pattern: /review|audit|diff|pr|research|investigate|审查|评估|调研|对比|巡检/i,
    skills: ['code-review', 'research'],
    preferReasoner: true,
  },
  {
    id: 'feature',
    label: '功能开发',
    pattern: /feat|implement|create|build|develop|add|enhance|新增|实现|开发|支持|功能|改进|接入/i,
    skills: ['codebase-design', 'tdd'],
    preferReasoner: true,
  },
]

export class IntentRouter {
  constructor(private readonly options: RouterOptions) {}

  /** Route an IngressEvent into a TicketMandate with comprehensive Triage */
  route(event: IngressEvent): TicketMandate {
    const text = `${event.summary} ${JSON.stringify(event.payload ?? {})}`.toLowerCase()
    const matchedRules: string[] = []
    const tags: string[] = []

    // 1. Dynamic Domain Tag Extraction (e.g. [PPT 标准化], [组件契约], [官网])
    const bracketMatches = event.summary.match(/\[([^\]]+)\]/g)
    if (bracketMatches) {
      for (const m of bracketMatches) {
        const clean = m.slice(1, -1).trim()
        if (clean && !tags.includes(clean)) {
          tags.push(clean)
          matchedRules.push(`提取标题标签: [${clean}]`)
        }
      }
    }

    // 2. Open Category Detection (Supports custom string or semantic pattern matching)
    let intent: TaskCategory = 'general'
    let categoryLabel = '常规任务'
    let skills: string[] = []
    let preferReasoner = false

    const explicitCategory = event.payload?.category
    if (typeof explicitCategory === 'string' && explicitCategory && explicitCategory !== 'auto') {
      intent = explicitCategory
      categoryLabel = explicitCategory
      matchedRules.push(`用户指定分类: ${categoryLabel}`)
    } else {
      // Evaluate open category rules
      let matched = false
      for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(text)) {
          intent = rule.id
          categoryLabel = rule.label
          skills = [...rule.skills]
          preferReasoner = Boolean(rule.preferReasoner)
          matchedRules.push(`命中分类规则: ${rule.label}`)
          matched = true
          break
        }
      }
      if (!matched) {
        intent = 'general'
        categoryLabel = '常规任务'
        matchedRules.push('未命中预设规则，自动分配为开放常规任务')
      }
    }

    // 3. Dynamic Source Auto-Detection (Never locked to a rigid list)
    let detectedSource = '中台创建'
    const rawSource = typeof event.payload?.source === 'string' ? event.payload.source : event.source

    if (typeof rawSource === 'string' && rawSource && rawSource !== 'manual-ui' && rawSource !== 'auto') {
      detectedSource = rawSource
      matchedRules.push(`任务来源设定: ${detectedSource}`)
    } else {
      // Auto-identify source from context/URL/keywords
      if (/feishu|lark|飞书/i.test(text)) {
        detectedSource = '飞书'
        matchedRules.push('上下文识别来源: 飞书渠道')
      } else if (/github/i.test(text)) {
        detectedSource = 'GitHub'
        matchedRules.push('上下文识别来源: GitHub')
      } else if (/gitlab/i.test(text)) {
        detectedSource = 'GitLab'
        matchedRules.push('上下文识别来源: GitLab')
      } else if (/sentry/i.test(text)) {
        detectedSource = 'Sentry'
        matchedRules.push('检测到告警监控: Sentry')
      } else if (/jira/i.test(text)) {
        detectedSource = 'Jira'
        matchedRules.push('上下文识别工单: Jira')
      } else if (/tapd/i.test(text)) {
        detectedSource = 'TAPD'
        matchedRules.push('上下文识别工单: TAPD')
      } else if (/dingtalk|钉钉/i.test(text)) {
        detectedSource = '钉钉'
        matchedRules.push('上下文识别来源: 钉钉')
      } else if (/wecom|企业微信|企微/i.test(text)) {
        detectedSource = '企业微信'
        matchedRules.push('上下文识别来源: 企业微信')
      } else if (/slack/i.test(text)) {
        detectedSource = 'Slack'
        matchedRules.push('上下文识别来源: Slack')
      } else if (/cron|timer|定时|巡检/i.test(text)) {
        detectedSource = '定时巡检'
        matchedRules.push('上下文识别来源: 定时巡检')
      } else if (/官网|小灶/i.test(text)) {
        detectedSource = '官网业务'
        matchedRules.push('识别为官网业务任务')
      } else {
        detectedSource = '中台交互'
      }
    }

    // 4. Dynamic Priority Resolution (P0, P1, P2, P3)
    let priority: PriorityLevel = 'p2'
    const explicitPriority = event.payload?.priority
    if (typeof explicitPriority === 'string' && explicitPriority && explicitPriority !== 'auto') {
      priority = explicitPriority as PriorityLevel
      matchedRules.push(`指定优先级: ${priority.toUpperCase()}`)
    } else {
      if (/crash|panic|sentry|p0|紧急|致命|严重|阻断|线上|宕机/i.test(text) || detectedSource === 'Sentry') {
        priority = 'p0'
        matchedRules.push('检测到紧急阻断指标 -> P0 紧急')
      } else if (intent === 'bugfix' || intent === 'feature' || /核心|关键|重点|p1/i.test(text)) {
        priority = 'p1'
        matchedRules.push(`核心研发/业务类别 (${categoryLabel}) -> P1 高优`)
      } else if (/壁纸|闲时|夜间|优化图标|不急|低优|p3/i.test(text)) {
        priority = 'p3'
        matchedRules.push('低频或闲时处理意向 -> P3 低优')
      } else {
        priority = 'p2'
        matchedRules.push('常规优先级标准 -> P2 普通')
      }
    }

    // 5. Execution Timing: the configured window plus an optional committed instant.
    const offpeak = this.options.offpeak ?? DEFAULT_OFFPEAK_WINDOW
    const offpeakLabel = describeOffpeak(offpeak)
    const explicitSchedule = event.payload?.scheduleMode
    let requestedMode: unknown = explicitSchedule
    if (typeof explicitSchedule === 'string' && explicitSchedule) {
      matchedRules.push(`指定执行时机: ${explicitSchedule}`)
    } else if (/offpeak|nightly|夜间|低峰|闲时|节省\s*token|非工作时间/i.test(text)) {
      requestedMode = 'offpeak'
      matchedRules.push(`检测到闲时意图 -> 排入配置窗口 ${offpeakLabel}`)
    } else {
      requestedMode = 'immediate'
      matchedRules.push('默认调度策略 -> 立即调度执行')
    }

    // Rejects an unknown mode and a missing or past instant, so no ingress path
    // can persist a timing the kernel would never honor.
    const schedule = resolveSchedule(requestedMode, event.payload?.scheduledAt, Date.now())
    const scheduleMode: ScheduleMode = schedule.mode
    const scheduledAt = schedule.scheduledAt

    // 6. Model Selection
    let model = this.options.fastModel ?? { provider: 'deepseek-official', model: 'deepseek-chat' }
    if (event.payload?.model && typeof event.payload.model === 'object') {
      const m = event.payload.model as { provider?: string; model?: string }
      if (m.model && m.model !== 'default') {
        model = { provider: m.provider, model: m.model }
        matchedRules.push(`用户指定模型: ${m.model}`)
      }
    } else if (preferReasoner || intent === 'feature' || intent === 'refactor' || intent === 'review') {
      model = this.options.flagshipModel ?? { provider: 'deepseek-official', model: 'deepseek-reasoner' }
      matchedRules.push(`深度逻辑或创作设计任务 -> 推荐旗舰推理模型 (${model.model})`)
    } else {
      matchedRules.push(`高速处理任务 -> 推荐通用高速模型 (${model.model})`)
    }

    // 7. Security & Workspace Permissions
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

    // 8. Synthesize Human-Readable Triage Narrative
    const scheduleDesc = scheduleMode === 'offpeak'
      ? `已排入配置的执行窗口「${offpeakLabel}」（窗口外保持排队，支持随时一键立即执行）。`
      : scheduleMode === 'scheduled'
      ? `已设定为「定时执行」(时间: ${new Date(scheduledAt ?? Date.now()).toLocaleString()})。`
      : '设定为「立即执行」，创建后自动分发至 Agent 实时运行。'

    const reasoning = [
      `【Router 智能研判日志】`,
      `• 任务分类：智能研判为「${categoryLabel}」`,
      `• 来源判定：识别任务渠道为「${detectedSource}」`,
      `• 业务标签：${tags.length > 0 ? tags.map(t => `#${t}`).join(' ') : '常规'}`,
      `• 优先级评定：评定为「${priority.toUpperCase()}」(${priority === 'p0' ? '紧急阻断' : priority === 'p1' ? '核心任务' : priority === 'p3' ? '闲时低优' : '常规标准'})`,
      `• 执行时机：${scheduleDesc}`,
      `• 算力装配：模型分配 [${model.model ?? '系统默认'}]，安全沙箱「${permissionPreset}」，技能 [${skills.join(', ') || '基础通用'}]。`,
    ].join('\n')

    const triage: RouterTriage = {
      intent,
      categoryLabel,
      detectedSource,
      tags,
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
      tags,
      triage,
    }
  }
}
