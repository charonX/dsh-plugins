/**
 * Web Client copy owned by the model-studio namespace.
 *
 * @module dsh-model-studio/client/locales
 */

/** English dictionary; its keys define the namespace's key domain. */
export const en = {
  compatTitle: 'Endpoint compatibility',
  compatHint: 'These switches decide how this provider sends requests. Leave a field untouched unless the gateway needs it.',
  thinkingFormat: 'Thinking format',
  thinkingFormatAuto: 'Auto (detected by the adapter)',
  supportsDeveloperRole: 'Send the system role as "developer"',
  supportsReasoningEffort: 'Send a named reasoning level',
  maxTokensField: 'Output cap field',
  probe: 'Probe this provider',
  probing: 'Probing…',
  probeHint: 'Sends a few tiny requests to find out which switches this gateway accepts. Nothing is written until one succeeds.',
  probeSucceeded: 'Detected: {format}',
  probeFailed: 'No format was accepted',
  presetTitle: 'Add a provider from a preset',
  presetHint: 'Presets fill the address, protocol, API-key variable, and endpoint compatibility for a known gateway.',
} as const

/** One dictionary key. */
export type MessageKey = keyof typeof en

/** Chinese dictionary, checked against the English key set. */
export const zh: Record<MessageKey, string> = {
  compatTitle: '端点兼容',
  compatHint: '这些开关决定该供应商怎么发请求。除非网关确实需要，不要动其他字段。',
  thinkingFormat: '思考格式',
  thinkingFormatAuto: '自动（由适配器探测）',
  supportsDeveloperRole: '用 developer 角色发送系统消息',
  supportsReasoningEffort: '发送命名推理档位',
  maxTokensField: '输出上限字段',
  probe: '探测此供应商',
  probing: '探测中…',
  probeHint: '发起几次极小请求，找出这个网关接受哪些开关。成功前不会写入任何配置。',
  probeSucceeded: '已识别：{format}',
  probeFailed: '没有找到可用的格式',
  presetTitle: '从预设添加供应商',
  presetHint: '预设会填好地址、协议、密钥变量名与端点兼容项。',
}
