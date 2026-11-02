# AGENTS.md

本目录是 **DeepSeek Harness 插件开发工作区**，本身不是 npm 包，也不参与任何构建。它只是一个容器 + 工作区级约定：每个顶层子目录都是独立的 Git 仓库，各自安装依赖、各自构建、各自提交。

## 目录与仓库角色

```
dsh/
├── AGENTS.md            # 工作区唯一权威说明（本文件），CLAUDE.md 为软链接
├── .gitignore           # 只追踪工作区级文件；顶层子目录全部为独立仓库
├── deepseek-harness/    # 上游 harness 源码 checkout（含自身 .git，分支 master，remote origin）
└── dsh-media-station/   # 自建插件项目（含自身 .git），作为 dsh bundle 开发
```

| 仓库 | 角色 | 改动方式 |
|---|---|---|
| `deepseek-harness/` | Cordis "一切皆插件" 的 agent harness 本体，`@deepseek-ai/dsh-*` 包集合，当前 `0.2.2-alpha.2` | 阅读、构建、本地开发；需要上游修复才动它，按该仓库 `AGENTS.md` 的 PR/规范流程 |
| 其他顶层目录 | 自建插件仓库，以 npm bundle 形式安装进 dsh profile | 只依赖 `@deepseek-ai/dsh-*`（peer/dev），不复制 harness 源码 |

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
  "engines": { "dsh": ">=0.2.2-0 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {},
  "peerDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-tools": "*" },
  "devDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-tools": "*" }
}
```

- **bundle vs profile**：bundle 是你要发布的包（`dsh.bundle.patch` 声明配置层）；profile 是用户运行时的组合（`dsh.profile.bundles` 有序列表，位于 `~/.dsh/profiles/<name>/package.json`）。不要手写 profile，用 `dsh plugin` 维护。
- **必须与宿主共用同一实例的 dsh 包**（`cordis`、`dsh-tools`、`dsh-agent` 等）同时放进 `peerDependencies` 和 `devDependencies`：peer 保证运行时用宿主那份，dev 供自己类型检查与独立测试。
- `cordis.patch.yml` 里用**包名**引用插件行，`config` 由插件自己的 Config schema 校验；patch 会整体替换目标行的 `config`，不是深合并。
- `engines.dsh` 声明支持的运行时区间；缺失时 dsh 退回检查 DSH peer 范围，不满足会拒绝安装/启动（`dsh plugin ... allow-version` 可豁免，需确认风险）。
- 插件模块导出 `name` / `inject` / `apply(ctx)`（也支持对象/class 形式）；所有注册走 `ctx.effect()` / `ctx.on()`，注册即 effect，disposer 自动回收。
- 面向用户/模型可见的行为要有测试；UI 文案走 locale 字典；配置项不能硬编码在插件里，部署差异走 `Config`。

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
