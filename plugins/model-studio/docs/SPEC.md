# dsh-model-studio — 构建规格

本文件是新 session 的唯一权威交接材料。它记录：为什么做这个插件、dsh 现在缺什么、
可以接哪些缝、模型兼容的真相与证据、数据从哪来、以及分阶段的验收标准。
动手前请按第 7 节核对 seam，按第 9 节确认本阶段范围。

工作区：`/Users/zhanglei/charon/code/workspace/dsh`（每个顶层目录是独立 git 仓库）。
本仓库：`dsh-model-studio`。

> 第一版的实现设计见 [`DESIGN.md`](./DESIGN.md)，术语见 [`../GLOSSARY.md`](../GLOSSARY.md)。
> 本版**不实现**本文 §5.2（探测）与 §5.3（记忆），兼容块改为由构建期快照推导，
> 理由与回退路径见 [`adr/0001`](./adr/0001-no-probe-snapshot-derived-compat.md)；
> 里程碑顺序以 `DESIGN.md` 为准。

---

## 1. 目标与非目标

### 目标

一个插件解决模型层的三件事，全部发生在官方「设置 → 模型」页内：

1. **供应商扩展**：常见网关（含中转）一键预设添加，而不是纯手填。
2. **思考等级扩展**：每模型 `reasoningEfforts` 的建议填充、默认档位、批量套用。
3. **端点兼容（compat）**：编辑 + **探测** + **记忆**，让任意未知网关都能被识别。

### 非目标（明确不做）

- 不覆盖官方已有能力：provider 增删改、模型列表、`/models` 探测、API key 输入、
  `reasoningEfforts` 的档位编辑、上下文/输出上限/输入模态（这些官方页都已具备）。
- 不 patch 任何其他服务的方法（禁止 `ctx.llm.resolveModelInfo = ...` 之类）；
  参考实现 `cinob/dsh-plugin-custom-provider-enhancer` 就是这么干的，不要照抄。
- 不替换官方模型选择器菜单（那属于 `HanaAyane/dsh-reasoning-effort` 一类插件）。
- 不接管 fetch 层、不改 User-Agent、不内置任何密钥。
- 不新建独立设置页：只用官方 `settings.section` 内部的扩展座位。
- 不做"上下文/容量覆盖官方已填值"——只填空缺或经确认的建议。

---

## 2. 官方现状盘点

`ui-settings-models`（官方「模型」页）已有：

| 能力 | 位置 |
|---|---|
| 手动添加自定义 provider（显示名称/API 地址/API 协议/密钥） | `CustomProviderCard.tsx` |
| 模型目录、`/models` 探测（「获取可用模型」） | `packages/llm/llm-pi-ai` 的 `registerModelDiscovery` |
| 每模型 `reasoningEfforts`（档位 + API 参数值） | `ModelReasoningEfforts.tsx` |
| 每模型上下文窗口 / 最大输出 / 输入模态 | 卡片内字段 |
| 两个扩展座位（专为仓库外插件预留） | `src/client/slot-contract.ts`，见第 7 节 |

官方**没有**的（本插件要补）：

- `compat` 整块字段（`thinkingFormat`、`supportsDeveloperRole`、`supportsReasoningEffort`、
  `maxTokensField`、`chatTemplateKwargs`、`thinkingTokenBudgetField` 等）；
- 常见网关预设（添加流程完全手填）；
- 每模型「默认思考档位」（新会话直接沿用）；
- 方言探测与记忆（未知网关只能靠猜或写 YAML）；
- 批量/整条 route 的一致性操作。

---

## 3. 核心事实：`off` 为什么不一定真的关掉思考

### 3.1 机制

pi-ai 的 `off` 从不"直接关闭思考"，它只是**不提供推理强度**；真正的关闭表达由
`thinkingFormat` 决定，而 `thinkingFormat` 来自两处：

1. 显式 `compat.thinkingFormat`；
2. `detectCompat()` 从 provider 名 / baseURL 自动探测，**兜底是 `openai`**。

`detectCompat()` 只能探测出：`deepseek` / `zai` / `together` / `openrouter` / `ant-ling`，
其余一律 `openai`。**它永远不产出 `qwen` / `qwen-chat-template` / `chat-template` /
`baseten` / `string-thinking`**，所以凡是靠 `enable_thinking` / `chat_template_kwargs`
表达开关的网关（SiliconFlow、自建 vLLM、各类模板网关），都会落到 `openai` 兜底：
`off` = 什么都不发 = 网关用自身默认（多半是开思考）。

### 3.2 各格式的 `off` 实际发出什么

源码：`packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:627-730`

| `thinkingFormat` | `off` 时发出的内容 | 是否真关 |
|---|---|---|
| `deepseek` | `thinking: { type: 'disabled' }` | 是 |
| `zai` | `thinking: { type: 'disabled' }` | 是 |
| `together` | `reasoning: { enabled: false }` | 是 |
| `openrouter` | `reasoning: { effort: 'none' }` | 是 |
| `qwen` | `enable_thinking: false` | 是 |
| `qwen-chat-template` | `chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }` | 是 |
| `chat-template` | 按配置的 kwargs 生成 | 取决于配置 |
| `baseten` | `chat_template_args` | 取决于配置 |
| `string-thinking` | `thinking: 'none'`（可配置） | 是 |
| `ant-ling` | 仅在非 off 档位发 effort | 否（只能靠默认） |
| **`openai`（兜底）** | 什么都不发 | **否** |

另外：官方 UI 的 `off` 行**允许填"API 参数值"**；在 `openai` 兜底分支里，若 `off`
带了字符串值，会发成 `reasoning_effort: <值>`（`openai-completions.js:728`）。
所以"网关用正向 `reasoning_effort` 表达关闭"的场景，UI 单独就能搞定。

### 3.3 实测证据（在本机 0.2.2-alpha.3 上做过）

同一路由 `siliconflow / Qwen/Qwen3-8B`，同一个请求，只改配置：

| 配置 | 译文 | `reasoned` |
|---|---|---|
| `reasoningEfforts: { off: null, low, medium, high }`，无 compat | 电脑 | **true** |
| 同上，但 `off: none`（UI 能填的参数值） | 计算机 | **true** |
| 同上 + `compat.thinkingFormat: qwen` | 计算机 | **false** |
| 再加 `compat.supportsDeveloperRole: false` | 键盘 | **false** |

结论：
- `off` 留空 → 只在有明确关闭语义的方言里成立；
- `off` 填值 → 值会发出，但网关可能不认（SiliconFlow 不认 `reasoning_effort: none`）；
- **只有 `thinkingFormat` 正确时才真关**；
- 改这些字段**热生效**，不需要重启（`llm-pi-ai` 的 config 字段是 volatile）。

### 3.4 另一个必踩的坑：`developer` 角色

`openai-completions.js:905`：

```js
const instructionRole = model.reasoning && compat.supportsDeveloperRole ? 'developer' : 'system'
```

`supportsDeveloperRole` 对未被 `isNonStandard` 命中的自定义 provider 默认 **true**。
于是：**一旦某模型被声明为"支持推理"（`reasoningEfforts` 非空），该路由上所有带系统消息
的请求都会以 `role: 'developer'` 发出**；只认 `system/user/assistant/tool` 的网关会
直接 400（SiliconFlow 报 `Input tag 'developer' found ... does not match any of the
expected tags`）。这条同样影响普通对话，不只影响辅助请求。

→ 所以"给模型补 `reasoningEfforts`"这个动作本身就有副作用，本插件在写入时必须联动检查
`supportsDeveloperRole`。

---

## 4. 数据层：供应商与模型事实从哪来

### 4.1 三个候选来源（已实测拉取）

| 来源 | 许可 | 体量 | 提供什么 | 用途 |
|---|---|---|---|---|
| [models.dev](https://github.com/anomalyco/models.dev) | **MIT** | 235 providers、`api.json` 约 5.7MB | provider：`id` / `name` / `api`(baseURL) / `env`(密钥变量名) / `doc`；model：`limit{context,output}` / `modalities` / `attachment` / `tool_call` / `reasoning` / **`reasoning_options`** / `interleaved.field` / `cost` | **主数据源** |
| [LiteLLM](https://github.com/BerriAI/litellm) | 标注 NOASSERTION | 4743 条 | 容量 / 价格 / `supports_reasoning` | 可选兜底，仅数据 |
| [new-api](https://github.com/QuantumNous/new-api) | **AGPL-3.0** | 60 个渠道 + 每渠道 adaptor | 每个供应商怎么发 thinking 的实践 | **只借鉴思路，不复制代码** |

### 4.2 models.dev 关键字段样例

```
siliconflow → api=https://api.siliconflow.com/v1, env=['SILICONFLOW_API_KEY'], 57 models
deepseek    → api=https://api.deepseek.com,        env=['DEEPSEEK_API_KEY']
openrouter  → api=https://openrouter.ai/api/v1,    env=['OPENROUTER_API_KEY'], 378 models
zhipuai / alibaba / moonshotai / togetherai / groq … 共 235 个
```

模型条目字段（实测）：`attachment, canonical_model_id, cost, description, family, id,
interleaved, last_updated, limit{context,output}, modalities, name, open_weights,
reasoning, reasoning_options, release_date, temperature, tool_call`。

### 4.3 `reasoning_options` 形态分布（全库实测）

| 形态 | 条目数 | 含义 | 候选方言（见第 5 节） |
|---|---|---|---|
| `effort` | 4034 | 有命名档位 | `openai` / `together` / `openrouter` / `ant-ling` / `baseten` |
| 无 | 3220 | 不推理 | 不探测 |
| `toggle` | 732 | 布尔开关 | `qwen` / `zai` / `deepseek` / 模板类 |
| `effort + toggle` | 349 | 两者都有 | 先 effort |
| `budget_tokens + toggle/effort` | 400 | 额外有 token 预算 | 追加 `supportsThinkingTokenBudget` |

注意：`budget_tokens` 是**额外能力**，不改变格式选择。SiliconFlow 在 models.dev 里
正是 `budget_tokens` 型（`min 128 / max 32768`），对应 pi-ai 的
`supportsThinkingTokenBudget` + `thinkingTokenBudgetField`。

### 4.4 落地方式：构建期快照，运行时离线

1. `scripts/sync-models-dev.ts`（Node 24 直接跑 `.ts`，无需 tsx）：
   拉 `https://models.dev/api.json` → 裁剪 → 生成 `src/data/providers.generated.ts`
   与 `src/data/models.generated.ts`；
2. 生成物入库，文件头写明来源、许可（MIT）、快照日期与上游 commit/时间戳；
3. 运行时零网络依赖；设置页提供显式「刷新供应商目录」按钮（可选联网，写插件缓存）；
4. 目录里没有的网关（私有 OneAPI、内网 vLLM）→ 走探测，不依赖任何表。

---

## 5. 方言模型与探测算法

### 5.1 已实现的第一块：`src/dialect.ts`

纯函数，已带 14 条单测（`tests/dialect.spec.ts`），是 M3 探测器的输入层：

- `profileOf(options)` → `{ shapes: ['toggle'|'effort'|'budget'], effortValues, budget }`
- `candidateFormats(profile)` → 有序候选（effort 型先试 effort 方言，toggle 型先试开关方言）
- `compatSuggestion(profile)` → 首候选 + 预算标志
- `reasoningEffortsOf(profile)` → `{ off: null, ...档位 }`

**继续用它**，不要另起一套。

### 5.2 探测：两个信号

| 信号 | 能判什么 |
|---|---|
| HTTP 400 的错误文本 | 有些网关指名道姓：`Input tag 'developer' ...` → `supportsDeveloperRole: false`；`unknown field enable_thinking` → 格式错了 |
| **响应里是否出现 reasoning** | 唯一能识别"网关接受了请求但忽略了关闭参数"的手段（SiliconFlow 就是这种） |

判定顺序：
1. 按 `candidateFormats()` 取候选；
2. 对每个候选：写入 route 级 compat → 发一次极小请求（几个 token）→ 同时看两件事：
   - 请求是否成功（失败时读错误文本，能直接推出 `supportsDeveloperRole` 之类的开关）；
   - 是否出现 reasoning（`finish` 前有 `reasoning-delta` 或完整 `reasoning` 块）；
3. 命中（无 reasoning 且 200）即停，**此时才把这一份 compat 落盘**；
4. 全失败 → 明确报告"该路由无法关闭思考"，不写入任何配置。

实现要点：
- 复用 `ctx.llm.prepareCall({ provider, model, maxTokens: 16 }, signal, configure)` + 流式读取；
- 探测请求**必须**与真实调用走同一条 `compat`（`compat` 是 route 级配置，不能按请求覆盖），
  所以探测期间会临时改配置——因此只在用户显式点击时进行，且结束时必须收敛：
  成功写入命中值，失败恢复探测前的快照；
- 一次探测约 3~6 个小请求，成本可忽略，但要在 UI 上说明"将发起 N 次探测请求"。

### 5.3 记忆

成功的方言按**注册域**（`api.siliconflow.cn`）记进插件自己的配置文件，而不是硬编码进代码：

```jsonc
{
  "gateways": {
    "api.siliconflow.cn": { "thinkingFormat": "qwen", "supportsDeveloperRole": false, "probedAt": "2026-…" },
    "my-gw.internal:8443": { "thinkingFormat": "chat-template", "chatTemplateKwargs": { } }
  }
}
```

新模型/新 route 命中同一注册域 → 直接套用，无需再探测。这样"未知"只会未知一次。

### 5.4 漂移巡检（M4，可选）

翻译/对话请求后回报"这次是否出现 reasoning"，长期仍出现就提示重探（网关升级会改行为）。
我方 `dsh-immersive-translate` 已有该观测能力（`TranslateResponseBody.reasoned`），
若要做跨插件联动，用一个 Host 服务或事件，不要直接依赖对方实现。

---

## 6. 兼容参数的写入位置：route 级 vs 模型级

- **方言是供应商级**，不是模型级 → `compat` 写在 `providers.<id>.compat`（route 级）；
- 个别模型特殊时，才在 `models[i].compat` 覆盖；
- pi-ai 的解析：`resolveModelCompat()`（`packages/llm/llm-pi-ai/src/catalog.ts`）按
  route 默认 + 模型逐字段覆盖；
- `reasoningEfforts` 只能写在 **模型级**（`models[i].reasoningEfforts`）。

---

## 7. dsh 接缝清单

### 可用（本插件只允许用这些）

| 接缝 | 位置 | 用途 |
|---|---|---|
| `settings.models.provider-card`（keyed，key = `ProviderDirectoryEntry.settingsNs`） | `packages/client/ui-settings-models/src/client/slot-contract.ts` | provider 卡内的 compat 编辑区（M2） |
| `settings.models.footer`（list） | 同上 | 「从预设添加供应商」面板（M1） |
| `ctx.configForms.get<T>(ns)` / `.whileServed([ns], register)` | `packages/client/ui-settings/src/client/config-form.ts:236` | 读写设置文档（`getSnapshot/subscribe/mutate/set/unset`，见 `config-form-types.ts:36`） |
| `SettingsPathOpView`：`{op:'set',path:[...],value}` / `{op:'unset',path}` | `packages/settings/settings/src/types.ts:52` | 写入形状 |
| `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` | `packages/llm/llm/src/index.ts` | 读路由与能力（`reasoning.efforts`） |
| `ctx.llm.prepareCall(config, signal, configure)` | 同上 `:956`；`ConfigureCall` 见 `call-config.ts:45` | 探测请求 |
| `ctx.llm.registerModelDiscovery(ns, fn)` | 同上 `:569` | 如需自建发现（一般不需要） |
| `ctx.llm.registerAdapter` | 同上 `:401` | **不用**（仅当 pi-ai 表达不了某协议时才考虑） |

### 禁用

- 覆写任何 `ctx.*` 服务方法（monkey-patch）；
- 直接写 `~/.dsh/profiles/*/cordis.patch.yml`（用户配置由 settings 服务持有）；
- 依赖 `node_modules/@earendil-works/pi-ai` 内部路径（它不是本仓库依赖）。

### 关键校验点（实现时会踩到）

- 运行时对不支持的 effort 抛 `UNSUPPORTED_REASONING_EFFORT`（`packages/llm/llm/src/index.ts:921-938`）；
- 模型没有 reasoning 元数据时传任何 effort 也会抛 → 只能"不传"；
- `reasoningInfo()` 对 `!model.reasoning` 的路由**不上报** `reasoning` 字段
  （`packages/llm/llm-pi-ai/src/adapter.ts:210`），所以"没有元数据"≠"不能关思考"；
- `detectCompat()` 的兜底是 `openai`（见 3.1）。

---

## 8. 架构与文件布局

```
dsh-model-studio/
├─ src/
│  ├─ index.ts              # Host 入口：数据层、探测执行器、设置写入
│  ├─ dialect.ts            # ✅ 已实现：profile → 候选方言 → compat/efforts 建议
│  ├─ presets.ts            # M1：预设目录（由生成物驱动）+ 组装 provider 配置
│  ├─ probe.ts              # M3：候选矩阵 → 极小请求 → 收敛结果
│  ├─ memory.ts             # M3：按注册域记忆方言（插件配置文件）
│  ├─ data/
│  │  ├─ README.md          # ✅ 生成物说明
│  │  ├─ providers.generated.ts   # M1：来自 models.dev 的 provider 目录
│  │  └─ models.generated.ts      # M4：模型事实（容量/模态/推理形态）
│  └─ client/
│     ├─ index.tsx          # ✅ 已注册字典；M1/M2 加两个座位
│     ├─ locales.ts         # ✅ zh/en（含 M2 需要的文案）
│     ├─ PresetPanel.tsx    # M1：footer 面板
│     ├─ CompatEditor.tsx   # M2：provider-card 内编辑区
│     └─ ProbePanel.tsx     # M3：探测 UI
├─ scripts/sync-models-dev.ts   # M1：生成 src/data/*.generated.ts
├─ tests/                       # 纯函数单测（dialect 已有 14 条）
└─ docs/SPEC.md                 # 本文件
```

Host 与 Client 之间不要共享运行时值：类型放各自模块，或放 `src/shared/`（仅类型）。

---

## 9. 里程碑与验收

### M1 · 预设添加（`settings.models.footer`）

- `scripts/sync-models-dev.ts` 生成 `providers.generated.ts`（含快照日期/许可头注释）；
- footer 面板列出预设（先覆盖：DeepSeek、SiliconFlow、OpenRouter、Together、Z.AI、
  Moonshot、DashScope、OneAPI、NewAPI、LiteLLM、vLLM、Ollama）；
- 选中后通过 `configForms.mutate` 写入 `providers.<id>`：`displayName`、`baseURL`、
  `api`、`apiKeyEnv`、`compat`（来自 `compatSuggestion`）、`models[]`（1~2 个常见模型，
  带 `reasoningEfforts`）；密钥不由插件写入，提示到官方卡片填；
- 幂等：已存在的 provider id 不覆盖，改为提示。

**验收**：在干净 profile 上，从 footer 添加 SiliconFlow 预设 → 官方卡片出现该 provider →
填 key → 可对话、且请求带 `enable_thinking: false`（用 `dsh-immersive-translate` 的
`reasoned` 或抓包验证）。

### M2 · compat 编辑（`settings.models.provider-card`）

- 按 `settingsNs` 注册；读取 `ProviderDirectoryEntry` 的 route id；
- 字段：`thinkingFormat`（11 选一 + 自动）、`supportsDeveloperRole`、
  `supportsReasoningEffort`、`maxTokensField`、`chatTemplateKwargs`（JSON 文本域）；
- 写 route 级 `compat`，逐字段 `set`/`unset`（`unset` = 回到自动探测）；
- 显示来源：内置表 / 已探测 / 手动。

**验收**：在 SiliconFlow 卡上把 `thinkingFormat` 设为 `qwen`、`supportsDeveloperRole`
关掉，保存即生效（热生效，无需重启）。

### M3 · 探测与记忆

- `probe.ts` 实现 5.2；`memory.ts` 实现 5.3；
- UI：provider 卡上「探测此供应商」按钮 + 结果（成功格式 / 失败原因 / 本次请求次数）；
- 写入前需用户确认；失败必须恢复原配置。

**验收**：对一条目录里没有的私有网关，点探测后得到可用的 compat，并把结果写进记忆；
下次同域新增模型自动套用；对探测不出来的路由明确显示"无法关闭思考"。

### M4 · 建议与批量

- 每模型「默认思考档位」；
- 按 models.dev 的 `reasoning_options` + `limit` 建议 `reasoningEfforts` 与容量（标注来源与置信度，不覆盖已填值）；
- 整条 route 批量套用。

---

## 10. 测试与门禁

- 纯函数（dialect / presets 组装 / probe 计划 / memory 合并）必须有单测；
- UI 组件测"给定 settings 快照 → 渲染出什么 + 点了写什么 op"；
- 每次改动跑：`pnpm typecheck`、`pnpm test`、`pnpm run build`；
- 跨仓库门禁：`/Users/zhanglei/charon/code/workspace/dsh/check-plugins-against-harness.sh`
  （必须 `dsh-model-studio PASS`）；
- 开发循环：`cd .. && ./dev.sh`（构建 → 客户端半热替换 → Host 半靠 patch 标记重载）。

---

## 11. 风险与注意事项

1. **写用户配置是高风险动作**：预设添加与探测都会改 settings 文档。要求：显式触发、
   幂等、可撤销、失败回滚，且不覆盖已存在的 provider id。
2. **声明 `reasoningEfforts` 会打开 `developer` 角色**（见 3.4）：凡是写入 reasoning 档位，
   必须同时检查/建议 `supportsDeveloperRole: false`（当网关不支持该角色时）。
3. **方言推断靠数据 + 探测，不靠域名硬表**：内置表只用于排候选顺序。
4. **models.dev 是外部数据**：可能滞后或缺失；生成物要带日期，UI 要能显示"数据快照时间"。
5. **版本纪律**：`engines.dsh` 下限是"仍要支持的最旧运行时"，不要跟着 devDependencies 抬。
   当前基线 `0.2.2-alpha.3`；Desktop 自带 `0.2.1-rc.5`，若要支持需单独验证后再降下限。
6. **生态里已有同类插件**（见第 12 节）：优先复用自己的实现，不引入它们的代码；
   AGPL 的 new-api 只能借鉴思路。

---

## 12. 生态参考（已完成调研，勿重复）

| 仓库 | 许可 / 体量 | 做了什么 | 与本插件的关系 |
|---|---|---|---|
| `HaoyueQin/dsh-better-reasoning-effort` | MIT，v0.5.4，65★ | 坐在官方 `provider-card` 内写 `reasoningEfforts` + 「端点兼容」+ 知识库自动适配；peer 上限 `^0.2.1-alpha.1` | **最接近的先例**，可参考交互；不要在 0.2.2-alpha.3 上假设它可用 |
| `HanaAyane/dsh-reasoning-effort` | MIT，v0.9.1，264★ | 原生模型菜单里的档位滑块；缺档位时给**可复制的 YAML**（不写配置）；只支持 RC 版本 | 证明社区同样认为 compat 需手写；不提供写入能力 |
| `yuioi666/dsh-plugin-model-capability` | MIT，v1.4.0 | 独立设置页 + presets 写 `compat.thinkingFormat` | 我们的做法（官方座位内）更贴近 dsh 规范 |
| `cinob/dsh-plugin-custom-provider-enhancer` | MIT，v1.0.0 | 从 models.dev 自动补容量/模态/`reasoningEfforts`；**monkey-patch** `llm.resolveModelInfo`、`settings.mutate` | 只借鉴数据源思路；其 patch 手法明确禁止 |
| `QuantumNous/new-api` | **AGPL-3.0** | 60 渠道 + 每渠道 adaptor | 只读代码理解方言差异，不复制 |

---

## 13. 附：本仓库的绿灯基线

当前已通过（0.2.2-alpha.3 基线）：

```
pnpm typecheck   # host / client / tests 三套
pnpm test        # 14 用例（tests/dialect.spec.ts）
pnpm run build   # lib/*.js + client/client.js
cd .. && ./check-plugins-against-harness.sh   # dsh-model-studio PASS
```

`src/dialect.ts` 是本仓库已交付的第一块逻辑，后续所有探测与建议都应建立在它之上。
