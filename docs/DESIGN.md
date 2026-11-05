# dsh-model-studio — 实现设计

本文是 [SPEC.md](./SPEC.md) 的实现层补充，不是它的替代品：SPEC 记录"为什么/能不能"，
本文记录"这一版做成什么样、边界在哪、错了怎么收场"。与 SPEC 冲突时以本文为准，
并把差异记在 [adr/0001](./adr/0001-no-probe-snapshot-derived-compat.md) 里。

术语见仓库根目录 [GLOSSARY.md](../GLOSSARY.md)（路由 / 网关 / 供应商 / 方言 / 兼容块 …）。

---

## 1. 形态

一个**纯客户端插件**：只有 `src/client/` 会运行，`src/index.ts`（Host 半）保持空入口，
仅用于让 bundle 的 patch 行成立。插件不注册 HTTP 路由、不读凭据、不改任何服务方法、
不写 Host 侧状态。

它补的是官方「设置 → 模型」页的两处官方缺口：

| 座位 | 组件 | 作用 |
|---|---|---|
| `settings.models.footer`（list） | `PresetPanel` | 从数据快照一键写入一条完整路由（端点 / 协议 / 密钥变量 / 代表模型 / 兼容块） |
| `settings.models.provider-card`（keyed，key = `settingsNs`） | `CompatEditor` | 逐字段编辑该路由的兼容块，或清除某一字段回到自动探测 |

官方已经具备、本插件**不碰**的：供应商增删、模型列表、`/models` 探测、API key 输入、
`reasoningEfforts` 档位编辑、上下文 / 最大输出 / 输入模态、模型选择器。

## 2. 不在这一版范围内

- **不实现探测**（SPEC §5.2）与**不实现记忆**（SPEC §5.3）。理由与回退路径见 ADR-0001。
- **不实现 M4**（每模型默认思考档位、批量套用）：它改的是会话默认行为，等前两块稳定后单独设计。
- 不新建独立设置页；插件没有自己的配置项，因此没有 `Config` schema、没有 settings 命名空间。

## 3. 事实基线（实现依赖的、已核对的上游行为）

| 事实 | 位置 |
|---|---|
| 兜底方言：`detectCompat()` 从 provider / baseURL 猜，猜不到就 `openai`；`openai` 的 `off` 什么都不发 | `pi-ai/dist/api/openai-completions.js` `detectCompat()` / `getCompat()` |
| 未命中 `isNonStandard` 的路由，`supportsDeveloperRole` 默认 `true`；一旦模型声明推理，系统消息改发 `developer` 角色 | 同上 |
| 兼容块的字段受协议 gate 限制，`thinkingFormat` 只对 `openai-completions` 生效 | `llm-pi-ai/src/catalog.ts` `resolveModelCompat()` / `compatGate()` |
| 路由级 `compat` 对不接受的模型"跳过"，但"任何协议都不提供的字段"会被拒 | 同上 |
| 兼容块的生效位置是 settings 文档 `providers.<路由>.compat`，改动热生效 | `llm-pi-ai/src/config.ts`（`providers` 为 `Volatile`） |
| 已装目录开箱即可配置 42 个供应商，官方添加流程可预填端点与凭据变量 | `llm-pi-ai/src/provider-data.generated.ts` |
| 客户端可读目录与命名空间：`ctx.remote.llm.listProviders()` / `listConfigurableProviders()`、`ctx.configForms.*` | `ui-settings-models/src/client/store.ts`、`ui-settings/src/client/config-form.ts` |

## 4. 数据管线

### 4.1 生成

`scripts/sync-models-dev.ts`（`node` 直接跑 `.ts`）：

1. 拉 `https://models.dev/api.json`（MIT）。仅供**构建期**使用，运行时不联网。
2. 过滤供应商：只保留 OpenAI 兼容端点 —— `npm` 为 `@ai-sdk/openai-compatible`（181 个）
   或 `@ai-sdk/openai` 且 `api` 形如 `…/v1`（4 个）。Anthropic 系（5 个）与拿不到 `api`
   的多租户/网关（14 个）**不生成**：协议不确定时写预设等于用猜测改配置。
3. 每供应商挑代表模型：按 `(tool_call, reasoning, last_updated)` 降序，取前 3；
   再按主导形状收敛（见 4.2 R6），允许少于 3 个。
4. 用 `src/dialect.ts` 的纯函数把形状折成 `compat` 与 `reasoningEfforts`（见 4.2）。
5. 写一个生成物并入库：`src/data/presets.generated.ts`（供应商 + 代表模型 + 预计算 compat）。
   来源、许可、快照时间、收录与排除数量都写在生成物头部的常量里，不额外维护旁挂文件。

生成物文件头固定写出：来源、许可（MIT）、快照日期、生成命令。
实测：199 个供应商、每个 ≤3 模型 → 生成物约 150KB；客户端产物 268KB（gzip 31KB）。
数量每次重算并在生成物头部注明，本文件里的数字只是采样参考。

### 4.2 预计算规则（全部在构建期完成，客户端只搬运结果）

- **R1** 只生成路由级兼容块，不生成模型级兼容块。
- **R2** 仅当形状含 `toggle` 或 `budget_tokens` 时写 `thinkingFormat`，且只在 switch 家族里取首个
  （`switchFormatOf()`，典型是 `qwen`）——即使同一模型也文档了 effort 档位，也只有 switch 家族
  给 `off` 一个线上拼写。`effort` 型**不写**：兜底 `openai` 已经会发 `reasoning_effort`，写死反而
  可能把 `together` / `openrouter` 覆盖成 `openai`。
- **R3** baseURL 命中 `detectCompat()` 已知分支的供应商（`*.deepseek.com`、`api.z.ai`、
  `open.bigmodel.cn`、`api.together.*`、`openrouter.ai`、`api.ant-ling.com`、`api.x.ai` 等）**不写**
  `thinkingFormat`，交给上游探测。反例：`zhipuai` 在快照里的形状是 `toggle`，写 `qwen` 会把它已有的
  `zai` 判型顶掉。这份 host 表是脚本里的一处常量，注释指向 pi-ai 的 `detectCompat()`，上游新增分支时同步。
- **R4** 只要写了任一模型的 `reasoningEfforts`，同一份预设里写 `supportsDeveloperRole: false`
  （SPEC §3.4 的坑：声明推理会打开 `developer` 角色）。只对**本插件新建**的路由生效。
- **R5** 形状含 `budget_tokens` 时追加 `supportsThinkingTokenBudget: true`（`thinkingTokenBudgetField`
  的别名），不额外发明字段。
- **R6** 代表模型必须与供应商主导形状一致：主导形状为 toggle/budget 时，不挑 effort-only 模型，
  避免路由级方言把该模型的档位语义改掉。没有一致模型的供应商，只挑"无推理"模型（此时不写 R4）。
- **R7** `reasoningEfforts` 一律以 `off: null` 开头（`off` 的线上拼写由 `thinkingFormat` 决定，
  不由档位名决定）。

## 5. 预设写入契约

选择供应商 → 预览要写入的内容 → 一次原子 `mutate`。

```jsonc
// 目标：llm-pi-ai 命名空间（settingsNs 由目录提供，不硬编码）
"providers.<presetId>": {
  "displayName": "<name>",
  "api": "openai-completions",
  "baseURL": "<api>",
  "apiKeyEnv": "<env>",                       // 只写引用名，密钥由官方卡片写入
  "models": [{ "id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts" }],
  "compat": { "thinkingFormat"?: "…", "supportsThinkingTokenBudget"?: true, "supportsDeveloperRole": false }
}
```

硬约束：

- **不覆盖**：`providers.<presetId>` 已在用户层、或该 id 已出现在 `listConfigurableProviders()`
  的目录里 → 拒绝并在面板内说明（覆盖一条内置路由的默认值是最坏的失败方式）。
- **单次写**：一个 `mutate(ops, snapshot.revision)`，不写两轮；冲突（`expectedRevision` 不匹配）
  按官方语义提示重载，不重试。
- **只读降级**：`snapshot.writable === false` 时面板仍可浏览，按钮禁用并说明原因。
- **不做幂等修复**：写失败即整体失败，不尝试部分写入后的补写。
- **数据集不在 UI 里猜**：面板只展示快照时间与"仅收录 OpenAI 兼容端点"的说明，不做偏好排序以外的加工。

## 6. 兼容块编辑器契约

在每张目录卡片内渲染（keyed 座位按 `settingsNs` 分发，含手写路由）。

- 字段：`thinkingFormat`（12 选一，含"自动"）、`supportsDeveloperRole`、`supportsReasoningEffort`、
  `supportsThinkingTokenBudget`、`maxTokensField`、`chatTemplateKwargs`（JSON 文本域）。
- "自动" = `unset` 该字段 → 回到 `detectCompat()`。这是所有推测的唯一撤销方式，必须显眼。
- 字段来源只按"用户层是否存在该键"判定，显示为**已显式设置 / 自动**。不引入"预设写的 / 手写的"
  标记：两者都在用户层，发明标记会污染用户配置，也无法在配置被复制到另一台机器后保持真实。
- 写入沿用官方卡片的路径：`ctx.configForms.get(ns)` → `mutate(ops, revision)`，逐字段 `set`/`unset`。
- 协议不接受的字段不渲染（按 `namespace.schema` 与该路由的 `api` 判断），避免保存时被
  `assertServiceable()` 拒。

## 7. 客户端结构

```
src/client/
├─ index.tsx            # 注册 locale；两个座位的注册与各自的 ctx→props 适配
├─ host.ts              # 唯一的服务访问层：目录、表单快照、写入（组件不接触 ctx）
├─ PresetPanel.tsx      # footer：搜索 + 列表 + 预览 + 写入
├─ CompatEditor.tsx     # 卡片内：字段编辑 / 清除
├─ ExtensionFrame.tsx   # 两个座位共用的"扩展区"外壳（见 §8）
├─ ops.ts               # 预设 / 兼容块 → path ops 的纯函数（唯一写入契约）
├─ tokens.ts            # 官方 token 的内联样式片段
└─ locales.ts           # zh / en
src/preset-pick.ts      # 构建期：快照条目 → 预设（R1–R7 全部在这里）
scripts/sync-models-dev.ts
src/data/presets.generated.ts
src/shared/preset.ts    # 生成物类型（两端共用）
```

- **座位注册**：footer 按 list 注册（`id: 'model-studio.presets'`，`order: 40`）。
  provider-card 是 keyed 槽，key 必须是确切的 `settingsNs`，所以整个注册挂在
  `ctx.inject(['remote.llm'], …)` 里等 llm Remote 就绪，再用
  `listConfigurableProviders()` 解析命名空间；读不到时退回 `'llm-pi-ai'`。
- **注入面**：`inject` 声明 `slots` / `locale` / `remote` / `remote.llm` / `configForms`，
  缺失时对应座位不渲染而不是抛错（`ctx.get()` 动态感知）。
- **不碰 React 之外的宿主实现**：按钮等用 `@deepseek-ai/dsh-client-ui-primitives`，
  不复制宿主组件，不自建样式文件（本仓库 `tsdown` 无 CSS modules 管线，样式一律 inline +
  `var(--dsw-alias-*)`）。

## 8. 扩展区视觉规范

官方页面里插进来的东西必须自证身份，否则用户无从区分。两个座位共用 `ExtensionFrame`：

- 顶部 0.5px `--dsw-alias-border-l2` 分隔线；
- 交互沿用官方"自定义设置"的 `<details>/<summary>` 折叠，**默认折叠**；
- 标签固定为 `扩展 · model-studio`（`--dsw-alias-label-tertiary`，小字号、无 Emoji），
  `title` 与 `aria-label` 给出完整句："此区域由插件 model-studio 提供，非官方功能"；
- 内容容器 `--dsw-alias-bg-layer-2`、圆角 `--dsw-radius-md`、与官方卡片同宽同内边距；
- 深浅色跟随：只用 token，不写十六进制色值。

## 9. 测试与门禁

- 纯函数必测：形状→兼容块（`dialect.ts`，已有 14 条）、代表模型挑选、预设 → ops（R1–R7、
  不覆盖判定）、兼容块字段 → ops（set/unset 成对）。
- 组件冒烟：用 `react-dom/server` 的 `renderToStaticMarkup` 断言"给定快照 → 渲染出的标签/禁用态"
  （不引入 jsdom）；交互（点了写什么 op）由纯函数测试覆盖。
- 每次改动：`pnpm typecheck`、`pnpm test`、`pnpm run build`；
  跨仓库门禁 `../check-plugins-against-harness.sh` 必须 `dsh-model-studio PASS`。
- 生成物：`pnpm run sync:models-dev` 后必须重跑 typecheck/build，并在 PR 说明里贴快照日期与
  供应商数量变化。

## 10. 失败面与已知局限

| 情况 | 结果 | 为什么可接受 |
|---|---|---|
| 快照滞后 / 网关升级 | 写进去的方言可能是错的，表现为请求 400 或思考关不掉 | 值可撤销（编辑器一键清除回到自动探测），且不覆盖已有配置 |
| 形状不唯一（同一供应商内模型形状混杂） | 只写主导形状的代表模型；其余模型可能语义不符 | R6 限制了代表模型的挑选范围，用户在官方页新增模型时可自选 |
| 供应商不在快照 / 非 OpenAI 兼容 | 面板里看不到 | 仍走官方"自定义添加"，再用本插件编辑器手填兼容块 |
| 用户改了 `llm-pi-ai` 条目 id | keyed 座位注册不上 | 动态读取目录；远端不可用时退回默认 id，最坏情况只是没有编辑器 |
| settings 只读 / profile 被锁定 | 只能看不能写 | 与官方页面同一失败面 |

## 11. 下一迭代（不在本版）

- 探测与记忆（SPEC §5.2 / §5.3）：需要重新定"临时写配置"的收敛规则，ADR-0001 记录了回退路径。
- M4：每模型默认思考档位、按快照建议 `reasoningEfforts` 与容量、整路由批量套用。
