# AGENTS.md

本目录是 **DeepSeek Harness 插件开发工作区**，本身不是 npm 包，也不参与任何构建。它只是一个容器 + 工作区级约定：每个顶层子目录都是独立的 Git 仓库，各自安装依赖、各自构建、各自提交。

## 目录与仓库角色

```
dsh/
├── AGENTS.md            # 工作区唯一权威说明（本文件），CLAUDE.md 为软链接
├── .gitignore           # 只追踪工作区级文件；顶层子目录全部为独立仓库
├── check-plugins-against-harness.sh  # harness 更新后校验全部插件（见「更新后的插件检查」）
├── deepseek-harness/    # 上游 harness 源码 checkout（含自身 .git，分支 master，remote origin）
├── dsh-autoloop/        # 自建插件项目：确定性自动化中台与调度大屏（见其 README.md）
├── dsh-media-station/   # 自建插件项目（含自身 .git），作为 dsh bundle 开发
└── dsh-skills-manager/  # 自建插件项目：技能库管理（Host + Web Client 半，见其 docs/DESIGN.md）
```

| 仓库 | 角色 | 改动方式 |
|---|---|---|
| `deepseek-harness/` | Cordis "一切皆插件" 的 agent harness 本体，`@deepseek-ai/dsh-*` 包集合，当前 `0.2.2-alpha.2` | 阅读、构建、本地开发；需要上游修复才动它，按该仓库 `AGENTS.md` 的 PR/规范流程 |
| 其他顶层目录 | 自建插件仓库，以 npm bundle 形式安装进 dsh profile | 只依赖 `@deepseek-ai/dsh-*`（peer/dev），不复制 harness 源码 |

已有插件仓库的入口文档：`dsh-skills-manager/README.md`（用法与 API）、`dsh-skills-manager/docs/DESIGN.md`（方案与阶段）；`dsh-media-station` 尚未实现。

插件仓库内**不要**复制或改写 harness 包源码；需要新增/修改上游能力时，在 `deepseek-harness/` 内开分支实现并走上游流程，插件侧继续通过公开扩展点接入。反之，harness 仓库里也不提交个人插件（官方 bundle 才进 `packages/bundle/`）。

## 环境

- Node.js >= 24.9（本机 v24.18.0），pnpm 11.28.5（由 `package.json` 的 `packageManager` 固定，必要时先 `corepack enable`），Git >= 2.26。
- 仅 ESM（`"type": "module"`），TypeScript `strict`，源码中相对导入带 `.ts` 后缀。
- 已安装的 Desktop 版：`/Applications/DeepSeek Harness.app`；home 为 `~/.dsh`，profile 位于 `~/.dsh/profiles/{web,desktop}`。
- Artifact 目录与 `node_modules` 都**不要**跨机器/跨仓库复用：插件仓库自己 `pnpm install`。

## deepseek-harness 仓库命令

以下命令都在 `deepseek-harness/` 内执行：

```sh
pnpm install            # 首次/依赖变更后
pnpm run build          # build:artifacts + build:check；源码启动前必须跑过一次
pnpm dsh web            # 从源码启动 Web UI（需已 build），或 pnpm run dev:web 边改边重建 client
pnpm run test           # 单元测试（CI 覆盖率门禁是 test:coverage）
pnpm run typecheck      # 类型检查
pnpm run lint           # oxlint
pnpm run hygiene        # 发布/依赖/workspace 一致性
pnpm run test:docs      # 文档快速门禁，doc-sync 为完整门禁
```

- 只有 `dsh` profile 能启动受支持的 Node 应用；不要新增 package bin / SDK argv 入口。
- `pnpm dsh <args>` 源码启动走 `node --import tsx/esm`，被它加载的模块必须保持 ESM。
- 真实 API 的 e2e/demo 依赖 `DEEPSEEK_API_KEY`（`deepseek-harness/.env` 或同目录 root `.env`）；无 key 时自动跳过。凭据永不入库。
- 文档与规范入口（改动前先读）：
  - `deepseek-harness/AGENTS.md`（仓库级硬规则：extension point、effect、session、类型、文案、提交检查）
  - `docs/architecture.md`、`docs/development.md`、`docs/testing.md`
  - `docs/cookbook/`（加 tool / 加 plugin / 加 LLM adapter / 持久化变更）
  - `docs/user/develop/`（外部插件教程：`basic/index.md`、`basic/tool.md`、`basic/config.md`、`basic/publish.md`）
  - `docs/defensive-patterns/README.md`（改 package 表面、生命周期、并发、子进程前必读）

## 插件仓库约定（bundle）

插件是 npm 包 + 配置层，两者都写在同一份 `package.json` 里：

```json
{
  "name": "dsh-media-station",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
  "engines": { "dsh": ">=0.2.2-alpha.2 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {},
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.6-alpha.1",
    "@deepseek-ai/dsh-tools": ">=0.2.2-alpha.2 <0.3.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.6-alpha.1",
    "@deepseek-ai/dsh-tools": ">=0.2.2-alpha.2 <0.3.0"
  }
}
```

- **bundle vs profile**：bundle 是你要发布的包（`dsh.bundle.patch` 声明配置层）；profile 是用户运行时的组合（`dsh.profile.bundles` 有序列表，位于 `~/.dsh/profiles/<name>/package.json`）。不要手写 profile，用 `dsh plugin` 维护。
- **必须与宿主共用同一实例的 dsh 包**（`cordis`、`dsh-tools`、`dsh-agent` 等）同时放进 `peerDependencies` 和 `devDependencies`：peer 保证运行时用宿主那份，dev 供自己类型检查与独立测试。
- `cordis.patch.yml` 里用**包名**引用插件行，`config` 由插件自己的 Config schema 校验；patch 会整体替换目标行的 `config`，不是深合并。
- `engines.dsh` 声明支持的运行时区间；缺失时 dsh 退回检查 DSH peer 范围，不满足会拒绝安装/启动（`dsh plugin ... allow-version` 可豁免，需确认风险）。
- 插件模块导出 `name` / `inject` / `apply(ctx)`（也支持对象/class 形式）；所有注册走 `ctx.effect()` / `ctx.on()`，注册即 effect，disposer 自动回收。
- 面向用户/模型可见的行为要有测试；UI 文案走 locale 字典；配置项不能硬编码在插件里，部署差异走 `Config`。

### 插件开发核心硬规则（UI 规范与宿主能力复用）

1. **严格遵循 DSH 原生样式（严禁自建孤立视觉体系）**：
   - 所有 UI 组件必须消费 DSH 官方 Design Tokens（`var(--dsw-alias-*)`），严禁自写孤立色板或硬编码十六进制颜色（如 `#ffffff`、`#111827`、`#2563eb` 等）：
     - 容器与图层：`--dsw-alias-bg-layer-1`（大屏/底层容器）、`--dsw-alias-bg-layer-2`（卡片/弹窗/表单底色）、`--dsw-alias-bg-layer-3`（悬浮层/嵌套卡片）。
     - 文本与排版：`--dsw-alias-label-primary`（主标题与正文）、`--dsw-alias-label-secondary`（说明/辅助文本）、`--dsw-alias-label-tertiary`（占位/弱化文本）。
     - 边框与圆角：`--dsw-alias-border-l1` ~ `l4` 分级边框；`--dsw-radius-sm` (6px)、`--dsw-radius-md` (8px)、`--dsw-radius-lg` (12px)。
     - 品牌与状态：`--dsw-alias-brand-primary`（品牌蓝）、`--dsw-alias-label-primary-foreground`（品牌前景色）、`--dsw-alias-state-error-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-success-primary`。
     - 投影与动效：`--dsw-elevation-panel`、`--dsw-elevation-overlay`。
   - 保证插件在 DSH 的深色与浅色模式之间无缝自适应切换，交互与视觉体验与宿主完全一致。
2. **保持专业极简排版（严禁在 UI 与文案中滥用 Emoji）**：
   - UI 界面、按钮、标签、状态提示、下拉菜单及日志中**严禁使用 Emoji 表情**（如 🚀、🐛、🌙、⚡、💬、🧠 等）。
   - 状态与层级区分统一使用文字标签、DSH 原生徽标、边框及语义状态颜色（`--dsw-alias-state-*`），保持与宿主一致的克制、严谨工业级风格。
3. **最大化复用 DSH 原生功能与接口（严禁脱离宿主重复实现）**：
   - 优先通过 Context 消费宿主已具备的各类核心服务与数据，严禁在插件内自编模拟数据或硬编码伪选项：
     - 模型目录与选择：消费 `ctx.sessionController.modelCatalog()`、`ctx.agentDefaultModel.currentSelection()`、`ctx.llm.listProviders()` / `listModels()`，动态读取宿主可用模型及默认配置，禁止手写固定下拉。
     - 工作区与会话：消费 `ctx.workspaceRegistry`、`ctx.sessions`、`ctx.sessionTitle` 等，动态读取工作区目录与会话历史，保持与左侧会话树联动。
     - Agent 执行与隔离：消费 `ctx.agents.create()`、`ctx.worktrees.create()`、`ctx.permissionPresets` 等，直接接入宿主真实调度与沙箱能力。
   - 依赖声明走动态感知与渐进降级（`ctx.get(...)` 或 `ctx.inject(['service'], ...)`），避免因强依赖声明阻塞插件初始化。

### 三种本地联调方式

1. **最快（源码插件 + overlay）**：在 harness 内启动，patch 用**绝对路径**指向插件源码：
   ```sh
   cd deepseek-harness
   pnpm dsh web --patch ./path/to/cordis.yml   # 行内 name: /abs/path/to/plugin/src/index.ts
   ```
2. **接近真实（linked checkout 装进 profile）**：用同一个 `dsh` 运行时管理 profile：
   ```sh
   dsh plugin --profile dev add ./dsh-media-station
   dsh --profile dev --dump-config    # 确认出现 "# == dsh-media-station" 层
   dsh --profile dev
   ```
   源码运行对应 `pnpm dsh plugin --profile dev add ...` / `pnpm dsh --profile dev`（需已 build）。安装/启动 profile 用的运行时必须与安装插件时的运行时版本一致。
3. **发布前**：升 version + 校验 `engines.dsh`，`npm pack` 检查 `files` 里确实含 `lib/index.js`、`cordis.patch.yml`、类型声明，再发布（可选：给仓库打 `dsh-plugin` GitHub topic 便于发现）。

### 版本与兼容

- harness 的公开 API 是 **pre-stable**，minor 甚至 patch 都可能破坏；插件侧把 dsh 依赖收窄到实际验证过的区间，并在升级 harness 后重跑插件测试。
- 插件可见的一切"模型能看到的东西必须能从 session log 重建"：新增模型可见输入要加 session event。
- 工具注册用 `defineTool`（类型化，`parameters` 推断 args，`output.schema` + `output.render` 决定模型可见内容）；拦截用 `tools/pre-execute` 等 waterfall，**必须调用 `next()`** 才不会短路。

### harness 更新后的插件检查（必做）

`deepseek-harness/` 拉到新代码后，顺序固定：

1. `cd deepseek-harness && pnpm run build`。完成判据：构建门禁全 PASS；构建不过就不存在可信基线（源码启动与插件联调都读构建产物）。
2. `./check-plugins-against-harness.sh`。完成判据：summary 每行 `PASS`（尚未实现 client 半的仓库显示 `WIP`），失败行会带出报错尾部。
3. 按失败项改插件，回到第 2 步，直到全 `PASS`。
4. 起一次真实 UI（`pnpm dsh web` 或 Desktop），按下面清单点一遍——类型检查覆盖不到运行时服务形状。

**为什么必须用脚本而不是各仓库的 `pnpm typecheck`**：发布的 `@deepseek-ai/dsh-client-*` 不声明同级类型包依赖（`dsh-client-store`、`dsh-client-shortcuts`、`dsh-api-workspace-controller` 等），插件 tsconfig 开 `skipLibCheck` 时这些 import 解析失败被降级成 `any`，整条 slot 组合类型链失效 → 插件自己的类型门禁**假绿**。脚本把每个 `@deepseek-ai/*` 依赖 `link:` 到 checkout 的已构建产物，插件与宿主处于同一实例（与运行时一致），类型检查才有意义。这条假绿曾经掩盖过真实不兼容：组件把 `t` 标成 `(key: string) => string`，与宿主注入的 `TranslateNS<'ns'>` 冲突。

人工确认的运行时面（类型层面看不出来）：

- 左侧栏：插件面板图标仍出现、可点进内页、More 菜单能列出并 pin/unpin、窄屏 drawer 模式无遮挡。`sidebar.panellist` 现由 `sidebar.panel.icon` factory 声明，注册代码不变但断点位置换了。
- 主面板：进入插件页、切回会话都正常（`main` keyed 注册未变）。
- 宿主服务名与形状：`webServer.register`、`skills.registerProvider`、`workspaceRegistry.list`、`agents`/`worktrees`/`agentDefaultModel`/`sessionTitle`。插件里 `ctx.get(...) ?? (ctx as any).x` 的兜底会把缺失静默降级，必须真实调用一次。
- 依赖宿主数据的选择器（模型/权限/工作区）仍有值，不是空列表。

版本纪律：

- harness 升版只改插件的 `devDependencies`（类型基线）和 `dependencies`；`peerDependencies` 与 `engines.dsh` 下限保持「仍要支持的最旧运行时」，不要随手跟着抬——抬了旧 Desktop 会拒绝加载插件。
- `cordis` / `schemastery` 的 dev 版本跟 harness `vendor/` 走（当前 `~4.0.6-alpha.2`、`~3.18.6-alpha.2`）；peer 写成覆盖宿主实际版本的区间。
- 升级只动 `@deepseek-ai/*` 版本号，不顺手升 react / typescript / vitest。

## 工作流要求（对 agent）

1. 动手前先确认改哪个仓库：读该仓库相关 README / AGENTS / docs，`git status` 确认工作树干净后再改。
2. 最小改动。不做未被要求的重构、格式化、依赖升级；跨仓库改动先说明理由并确认。
3. 每个仓库独立提交，不把插件改动混进 harness 提交，反之亦然；不 `git push`、不建 PR、不改 git 配置，除非明确要求。
4. 收工前按改动面跑窄检查（类型 + 相关测试 + 该仓库的门禁），报告**实际执行过的命令**与结果，不臆测通过：
   - harness：`pnpm run typecheck`、定向 `pnpm vitest run <path>`、文档改动加 `pnpm run test:docs`
   - 插件仓库：`pnpm typecheck`、`pnpm test`（初次搭建后需先补上这两个脚本）
5. 不提交密钥、token、`.env`、`node_modules`、构建产物；日志与临时文件放各仓库忽略路径。
6. 注释与文档写契约、失败行为、时序、所有权，不写推理过程；文件结尾保留且仅保留一个换行。
7. 面向用户的回复用中文；代码标识符、命令、路径保持原文。

## 新建插件项目 checklist

1. 目录名与包名统一：`dsh-<name>`（scope 视发布渠道自定），单独 `git init`。
2. `package.json`：`type: module`、`main`/`exports`/`types`、`files`、`dsh.bundle.patch`、`engines.dsh`、peer+dev 依赖、`scripts`（`build`/`typecheck`/`test`）。
3. `cordis.patch.yml`：`- insert:` 下按 `id` / `name` / `config` 写入插件行。
4. `src/index.ts` 导出 `name` / `inject` / `apply`；`tsconfig.json` 继承 harness 的 `tsconfig.base.json` 或自带等价 `strict` 配置。
5. `README.md`：用途、配置项、扩展点、已知限制；`LICENSE`；`.gitignore`（`node_modules/`、`lib/`、`*.log`、`.env`）。
6. 第一次跑通后再提交；提交信息说明该插件提供的能力与扩展点。

## 常见坑

- 忘记 `pnpm run build` 就 `pnpm dsh web`：源码启动使用已构建产物，会直接失败或行为陈旧。
- patch 里写相对路径引用 TS 源码：源码行必须绝对路径；包名行必须在 profile 的 `dependencies` 里解析得到。
- 在 profile 的 `cordis.patch.yml` 只覆盖部分 `config` 键：整段 config 被替换，需重述全部键。
- 把 `desktop` profile 当普通 profile：Electron 独占 `~/.dsh/profiles/desktop`，CLI 不能启动也不能改它的插件，只能用 Desktop 安装的命令在应用退出时管理。
- 用 `latest` 标签的 dsh 运行时安装 alpha 插件（或反之）导致版本不匹配：统一用同一运行时版本做安装与启动。
- 在插件里 `import '@deepseek-ai/dsh-xxx/src/...'` 之类深路径：只能依赖公开 `exports`。
- 在插件前端自建独立色板或硬编码十六进制颜色（如 `#ffffff`、`#111827`）：导致深浅色模式切换时视觉割裂/文字不可读，必须统一使用 `--dsw-alias-*` token。
- 在插件内写死模型、工作区、会话等下拉选项：必须通过 DSH 宿主服务（`ctx.llm` / `ctx.agentDefaultModel` / `ctx.workspaceRegistry` 等）动态读取。
- 插件仓库 `pnpm typecheck` 全绿不等于兼容宿主：`skipLibCheck` + 客户端类型包缺依赖会把组合类型降级成 `any`，用 `./check-plugins-against-harness.sh` 复核。
- 把 `engines.dsh` 下限跟着 `devDependencies` 一起抬高：插件在仍要支持的旧运行时（如 Desktop 自带版本）上会被拒绝加载。
- harness 构建产物过期（`src` 比 `lib/index.js` 新）时做联调：跑的是旧行为，排查方向全错；脚本会检测并拒绝在过期产物上给结论。
- 在 UI 文案、标签或状态中滥用 Emoji 表情：破坏原生整洁度与严谨专业风格，应统一使用纯文本标签或原生徽标。
