/**
 * Web Client copy owned by the immersive-translate namespace.
 *
 * @module dsh-immersive-translate/client/locales
 */

/** English dictionary; its keys define the namespace's key domain. */
export const en = {
  nav: 'Translate',
  title: 'Immersive translate',
  subtitle: 'Translate any surface in this window with the model this Harness already serves.',
  fabOpen: 'Open translation panel',
  fabClose: 'Close translation panel',
  fabLabel: 'Translate',
  settingsTitle: 'Translation engine',
  settingsSubtitle: 'Choose the destination language and which model translates. Providers and credentials are configured in the Harness model settings.',
  targetLanguage: 'Destination language',
  followDefaultModel: 'Follow the Harness default model',
  followDefaultHint: 'Uses the model this Harness gives new sessions. Session-level choices apply once the translation pane is bound to a session.',
  model: 'Model',
  modelHint: 'Only models the Harness already serves are listed here. Add or edit providers in Settings, Models.',
  modelUnavailable: 'No model is available yet.',
  cannotDisableThinking: 'Thinking cannot be turned off on this model, so translation runs slower.',
  thinkingSlowHint: 'Translations still work: the model reasons first and the answer follows. Pick a non-thinking model here, or declare this model non-reasoning in the provider configuration.',
  canDisableThinking: 'Thinking is turned off for translation.',
  effortsLabel: 'Adapter-reported efforts',
  effortsNone: 'none — this route advertises no reasoning metadata, so no effort can be selected',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Could not save preferences',
  sampleTitle: 'Try a batch',
  samplePlaceholder: 'Paste text to translate',
  translate: 'Translate',
  translating: 'Translating…',
  result: 'Result',
  emptySample: 'Nothing to translate yet.',
  engine: 'Engine',
  loading: 'Loading…',
  loadFailed: 'Could not read the translation state',
} as const

/** One dictionary key. */
export type MessageKey = keyof typeof en

/** Chinese dictionary, checked against the English key set. */
export const zh: Record<MessageKey, string> = {
  nav: '翻译',
  title: '沉浸式翻译',
  subtitle: '用这个 Harness 已经接好的模型，翻译窗口里的任意界面。',
  fabOpen: '打开翻译面板',
  fabClose: '关闭翻译面板',
  fabLabel: '翻译',
  settingsTitle: '翻译引擎',
  settingsSubtitle: '选择目标语言和用于翻译的模型。Provider 与凭据在 Harness 的模型设置里配置。',
  targetLanguage: '目标语言',
  followDefaultModel: '跟随 Harness 默认模型',
  followDefaultHint: '使用 Harness 为新会话提供的默认模型。绑定会话后，会话级选择会生效。',
  model: '模型',
  modelHint: '这里只列出 Harness 已经接好的模型。新增或修改 provider 请到「设置 → 模型」。',
  modelUnavailable: '当前还没有可用模型。',
  cannotDisableThinking: '该模型无法关闭思考，翻译会更慢。',
  thinkingSlowHint: '意思仍然译得出来：模型会先思考再给答案。可以在这里换一个非思考模型，或在 provider 配置里把该模型声明为非推理模型。',
  canDisableThinking: '翻译时会关闭思考。',
  effortsLabel: 'Adapter 上报的档位',
  effortsNone: '无 —— 该路线没有上报 reasoning 元数据，因此任何档位都无法选择',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存偏好失败',
  sampleTitle: '试译一段',
  samplePlaceholder: '粘贴要翻译的文字',
  translate: '翻译',
  translating: '翻译中…',
  result: '译文',
  emptySample: '还没有要翻译的内容。',
  engine: '引擎',
  loading: '加载中…',
  loadFailed: '读取翻译状态失败',
}
