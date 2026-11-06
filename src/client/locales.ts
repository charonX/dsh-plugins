/**
 * Web Client copy owned by the model-studio namespace.
 *
 * The English dictionary defines the key domain; the Chinese one is checked
 * against it. Nothing here is concatenated at runtime, so a missing key fails
 * the build instead of rendering a blank label.
 *
 * @module dsh-model-studio/client/locales
 */

/** English dictionary; its keys define the namespace's key domain. */
export const en = {
  extension: 'Extension',
  extensionOwner: 'model-studio',
  extensionHint: 'This area is provided by the model-studio plugin, not by the built-in Models page.',
  close: 'Close',

  presetsTrigger: 'Add a provider from presets',
  presetsTitle: 'Add a provider from presets',
  presetsHint: 'A preset writes the endpoint, protocol, API-key variable, representative models, and endpoint compatibility. Enter the API key in the provider card afterwards.',
  presetsSnapshot: 'Data snapshot {snapshot} · source models.dev ({license})',
  presetsScope: '{count} gateways are listed. {excluded} more are omitted because their protocol is not OpenAI-compatible.',
  presetsSearch: 'Search by name, endpoint, or variable',
  presetsEmpty: 'No gateway matches that search.',
  presetsMore: '{count} more matches — keep typing to narrow it down.',
  presetsKnown: 'already configured',
  presetsUnavailable: 'The provider directory is unavailable, so presets cannot be checked for conflicts.',

  presetApply: 'Write this provider',
  presetApplying: 'Writing…',
  presetCancel: 'Cancel',
  presetWritten: 'Wrote {name}. Enter its API key in the provider card to start chatting.',
  presetExists: 'Route "{id}" already exists — nothing was changed.',
  presetFailed: 'Write failed: {message}',
  presetReadOnly: 'This configuration is read-only; presets can be inspected but not written.',
  presetModels: 'Representative models',
  presetCompat: 'Endpoint compatibility',
  presetCompatNone: 'none — auto-detection decides',
  presetRoute: 'Route id',
  presetEndpoint: 'Endpoint',
  presetProtocol: 'Protocol',
  presetCredential: 'API-key variable',
  presetDocs: 'Documentation',

  compatTitle: 'Endpoint compatibility',
  compatHint: 'These switches decide how this provider sends requests. Leaving a field on "auto" hands it back to the adapter; changes apply without a restart.',
  compatFieldFormat: 'Thinking format',
  compatFieldMaxTokens: 'Output cap field',
  compatFieldDeveloperRole: 'Send the system prompt as "developer"',
  compatFieldReasoningEffort: 'Send a named reasoning level',
  compatFieldThinkingBudget: 'Send a thinking token budget',
  compatFieldKwargs: 'chat_template_kwargs (JSON object)',
  compatAuto: 'Auto (detected by the adapter)',
  compatEnabled: 'Enabled',
  compatDisabled: 'Disabled',
  compatSave: 'Save',
  compatSaving: 'Saving…',
  compatSaved: 'Saved.',
  compatClear: 'Clear all',
  compatCleared: 'Cleared — every field is back to auto-detection.',
  compatInvalidKwargs: 'chat_template_kwargs must be a JSON object.',
  compatFailed: 'Save failed: {message}',
  compatUnavailable: 'The settings namespace of this provider is not served, so its compatibility cannot be edited.',
  compatSourceExplicit: 'explicit',
  compatSourceAuto: 'auto',
} as const

/** One dictionary key. */
export type MessageKey = keyof typeof en

/** Localizer handed to this plugin's surfaces. */
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** Chinese dictionary, checked against the English key set. */
export const zh: Record<MessageKey, string> = {
  extension: '扩展',
  extensionOwner: 'model-studio',
  extensionHint: '此区域由插件 model-studio 提供，不属于官方模型页功能。',
  close: '关闭',

  presetsTrigger: '从预设添加提供商',
  presetsTitle: '从预设添加提供商',
  presetsHint: '预设会写入端点、协议、密钥变量、代表模型与端点兼容项。密钥请写入该供应商卡片，预设不会碰任何密钥。',
  presetsSnapshot: '数据快照 {snapshot} · 来源 models.dev（{license}）',
  presetsScope: '共 {count} 个网关；另有 {excluded} 个因协议不是 OpenAI 兼容而未收录。',
  presetsSearch: '按名称、地址或变量名搜索',
  presetsEmpty: '没有匹配的网关。',
  presetsMore: '还有 {count} 个匹配项，继续输入关键词可缩小范围。',
  presetsKnown: '已配置',

  presetsUnavailable: '读不到供应商目录，无法检查冲突，暂不提供写入。',

  presetApply: '写入该供应商',
  presetApplying: '写入中…',
  presetCancel: '取消',
  presetWritten: '已写入 {name}。到该供应商卡片内填入 API key 即可对话。',
  presetExists: '路由「{id}」已存在，未做任何修改。',
  presetFailed: '写入失败：{message}',
  presetReadOnly: '当前配置不可写：可以浏览预设，但无法写入。',
  presetModels: '代表模型',
  presetCompat: '端点兼容',
  presetCompatNone: '不写入（交给自动探测）',
  presetRoute: '路由标识',
  presetEndpoint: '端点',
  presetProtocol: '协议',
  presetCredential: '密钥变量',
  presetDocs: '文档',

  compatTitle: '端点兼容',
  compatHint: '这些开关决定该供应商怎么发请求。留空即交还给适配器自动探测，改完无需重启。',
  compatFieldFormat: '思考格式',
  compatFieldMaxTokens: '输出上限字段',
  compatFieldDeveloperRole: '用 developer 角色发送系统消息',
  compatFieldReasoningEffort: '发送命名推理档位',
  compatFieldThinkingBudget: '发送思考 token 预算',
  compatFieldKwargs: 'chat_template_kwargs（JSON 对象）',
  compatAuto: '自动（由适配器探测）',
  compatEnabled: '启用',
  compatDisabled: '关闭',
  compatSave: '保存',
  compatSaving: '保存中…',
  compatSaved: '已保存。',
  compatClear: '全部清除',
  compatCleared: '已清除，所有字段回到自动探测。',
  compatInvalidKwargs: 'chat_template_kwargs 必须是 JSON 对象。',
  compatFailed: '保存失败：{message}',
  compatUnavailable: '该供应商所属的设置命名空间不可用，无法编辑兼容项。',
  compatSourceExplicit: '已显式设置',
  compatSourceAuto: '自动',
}
