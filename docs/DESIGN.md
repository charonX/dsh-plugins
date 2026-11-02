# dsh-skills-manager 设计方案

面向 DeepSeek Harness（下称 dsh）的 **Skill 管理插件**：把 workstation 里验证过的 skill 管理能力（技能库、来源安装/更新/删除、启用开关、分类与备注）重做成 dsh 原生的 bundle（Host 半 + Web Client 半）。

参考实现：`/Users/zhanglei/charon/code/workspace/workstation/src/services/skillService.js`、`src/http/routes/skills.js`、`src/renderer/pages/Skills.jsx`、`src/cli/commands/skill.js`，以及该仓库的 ADR-003/004/011。

## 1. 目标与非目标

### 目标

1. **技能库**：一个受管目录，存放若干「来源」（一个 git clone 或一份本地拷贝），每个来源可含多个 skill。
2. **安装/更新/删除**：从 git URL（https/ssh/scp）或本地目录安装；git 来源可 `pull --ff-only` 更新；删除来源时清理其内容。
3. **开关**：按来源/按 skill 启用或停用；停用的 skill 不再进入 `ctx.skills` 目录，模型与 `/` 菜单都看不到。
4. **可视化管理**：Web UI 里的 Plugins 页新增 **Skills** 标签页，浏览来源、安装、更新（带实时日志）、删除、开关、搜索。
5. **原生接入**：技能通过自定义 `SkillProvider` 进入 `ctx.skills`，因此直接享有既有能力——模型 `skill` 工具、`/name` 用户调用、`skill` 工具卡片、会话级技能目录缓存与失效。

### 非目标（本阶段）

- 不做插件市场式的在线 registry；不做账号/云端同步。
- 不接管 `~/.dsh/skills`（那是 `dsh-skill-filesystem` 的 `user-dsh` root），避免两个 provider 重复发现同一目录。
- 不实现项目级软链分发（Phase 3，见 §9）。

## 2. 参考实现 → dsh 能力映射

| workstation 能力 | 本插件落点 |
|---|---|
| `settings.skillRepoPath` 技能库目录 | 插件 `Config.libraryDir`，默认 `$DSH_HOME/skills-manager/library` |
| git clone / 本地拷贝安装（异步 job + 实时日志） | 同一模型：`POST /sources/install` → `{jobId}`，轮询 `GET /jobs/:id`，`job.log` 流式增长 |
| `git pull --ff-only` 更新、失败保留原始输出 | 同；失败时 `job.log` 保留 git stdout/stderr |
| 删除来源 | 删除来源目录 + 清理状态记录 |
| 来源发现（root `SKILL.md` / `skills/<name>` / `skills/<cat>/<name>`） | 同三种布局（保留 workstation v1.1 的嵌套分类） |
| frontmatter `name`/`description` 校验、脏数据跳过 | 同；但脏数据在 UI 里显示为 `invalid` 行并给出原因，不再静默 |
| 状态文件（enabled/disabled、分类、备注） | `$DSH_HOME/skills-manager/manager-state.json`，稀疏存储（只记非默认值） |
| 项目关联（软链进各 agent skills 目录） | Phase 3：软链进 `<project>/.dsh/skills/<name>`（`project-dsh` root），复用 filesystem provider |
| CLI `skill list/install/update/remove` | Phase 3：`/skills` 会话命令 + 可选模型工具；**不新增 bin**（dsh 只允许 profile 启动应用） |
| SSE 安装日志 | 轮询 job（`cache-control: no-store`），避免为一次性进度引入长连接 |
| 多 agent 目录聚合（claude/codex/agents…） | Phase 3：只读外部来源（`~/.claude/skills` 等），可导入到库 |

## 3. 架构

```
                    Web Client (browser)                     Host (Node)
┌──────────────────────────────────────────┐   HTTP    ┌─────────────────────────────────────────┐
│ plugins.tab "Skills"                     │  same-    │ skills-manager (src/index.ts)           │
│  ├ SkillsTab (来源卡片 / skill 行 / 搜索) │  origin   │  ├ Config (schemastery)                 │
│  ├ InstallDialog (git|local + 进度日志)   │ ────────▶ │  ├ Library (扫描/解析/版本)             │
│  └ api.ts (fetch + job 轮询)              │           │  ├ StateStore (state.json, 原子写)      │
└──────────────────────────────────────────┘           │  ├ Jobs (内存 job + log)                │
                                                        │  ├ Installer (git/local/update/remove)  │
                     ctx.skills ◀────────────────────── │  ├ SkillProvider (rank=450)             │
                     (registry)                         │  └ HTTP routes (prefix)                 │
                                                        └─────────────────────────────────────────┘
```

- **Host 半**是 `apply(ctx, config)`：注册 provider、注册 HTTP 前缀路由。全部注册走 `ctx.effect`。
- **Client 半**是 `dsh.client` 声明的浏览器 bundle（tsdown 打成 `window.__ModuleLoader__.load` 工厂），向 `plugins.tab` 注册「Skills」标签页，向 `ctx.locale` 注册 zh/en 字典。
- 两端只通过同源 HTTP 通信，不引入 Typert remote（对外部插件过重）。

## 4. 数据模型

### 4.1 技能库布局

```
$DSH_HOME/skills-manager/
├── library/
│   ├── <slug>/SKILL.md                     # 单技能来源（slug 即技能名）
│   ├── <slug>/skills/<name>/SKILL.md       # 常规多技能来源
│   └── <slug>/skills/<category>/<name>/SKILL.md   # 嵌套分类（仅一层）
└── manager-state.json
```

- `slug` 只允许 `[A-Za-z0-9._-]`，不接受 `.`/`..`/分隔符/空白/控制字符。
- 隐藏目录（`.git`、`.linked-skills` 等）不参与发现。
- 来源发现结果为空 → 视为无效来源（安装时回滚、扫描时标注 problem）。

### 4.2 状态文件

```jsonc
{
  "version": 1,
  "sources": { "mattpocock-skills": { "enabled": false, "category": "engineering", "note": "内部约定" } },
  "skills":  { "mattpocock-skills/ask-matt": { "enabled": false, "note": "" } }
}
```

- 默认值不落盘：`enabled: true`、空 note/category 一律省略，文件保持最小。
- 写入采用「临时文件 + rename」原子替换；解析失败按空状态处理并告警（一个坏文件不能让插件起不来）。
- 状态键：来源 = `slug`；技能 = `slug + "/" + skillName`（skillName 是目录名，稳定于 frontmatter 改动）。

### 4.3 Job

```ts
interface Job { id: string; status: 'pending'|'running'|'success'|'error'; error: {code,message}|null; log: string|null }
```

- 进程内 Map；`log` 只在安装进行中/失败时累积（成功保留最后一次也不清理，便于调试，重启即丢）。
- 未知 job → 404。并发安装用 slug 冲突检测（同一 slug 已存在时 git 自动加 `-2` 后缀，local 需 `force`）。

## 5. SkillProvider

`ctx.skills.registerProvider(control => provider)`，`provider.name = config.providerName`（默认 `skills-manager`）。

- `rank = config.rank`（默认 **450**）：项目级（100/200）优先于技能库，技能库优先于 `user-agents`（500）/bundled（600）。
- `source = 'skills-manager'`：目录里能看出技能来自受管技能库。
- `list()`：每次实时扫描库（真实磁盘为唯一真相）+ 状态过滤；`candidates` 带 `locator = { dir }`、`resourceBase = { kind: 'directory', path: dir }`。
- `get(candidate)`：重新读 `SKILL.md`，解析 frontmatter 与正文，返回 `SkillDefinition`；文件消失返回 `undefined`。
- **过滤规则**（顺序）：来源启用 && skill 启用 && frontmatter 合法（`name` kebab-case、`description` 非空）&& 调用策略（`disable-model-invocation` / `user-invocable` 按 dsh 语义）。
- 失效：安装/更新/删除/改开关后调用 `control.invalidate()`，下一次 `list()` 重新发现；不额外引入 watcher（Phase 3 可选，用于外部改动）。
- 与 `dsh-skill-filesystem` 的关系：两者并存互不冲突（库目录不在其扫描 root 内）；同名 skill 由 rank 决定胜者，registry 语义不变。

## 6. HTTP API

前缀：`config.routePrefix`，默认 `/dsh-skills-manager`。全部 JSON，`cache-control: no-store`。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/library` | 库快照：`{ libraryDir, sources: ManagedSource[] }`（含每个 skill 的 enabled/valid/note） |
| POST | `/api/sources/install` | `{ sourceType: 'git'\|'local', identifier, force? }` → 202 `{ jobId }` |
| GET | `/api/jobs/:jobId` | `{ id, status, error, log }` |
| POST | `/api/sources/:slug/update` | git 来源 → 202 `{ jobId }`；local → 400 `SKILL_UPDATE_UNSUPPORTED` |
| DELETE | `/api/sources/:slug` | 删除来源目录与状态 → `{ removed: slug }` |
| PUT | `/api/sources/:slug` | `{ enabled?, category?, note? }` → 状态 |
| PUT | `/api/sources/:slug/skills/:skill` | `{ enabled?, note? }` → 状态 |

错误形状：`{ error: { code, message } }`；主要 code：`SKILL_IDENTITY_INVALID`、`SKILL_SOURCE_INVALID`、`SKILL_SLUG_CONFLICT`、`SKILL_FETCH_FAILED`、`SKILL_UPDATE_FAILED`、`SKILL_UPDATE_UNSUPPORTED`、`NOT_FOUND`、`GIT_UNAVAILABLE`、`UNTRUSTED_REQUEST`。

### 安全

- **同源/防 DNS rebinding**：写操作校验 `Host` 为 loopback 或 `connection.trustedHosts` 声明的 authority；`sec-fetch-site: cross-site` 拒绝；带 `Origin` 时必须与 `Host` 同 authority（loopback 允许省略端口）。Host/Origin 缺失按「非浏览器客户端」放行（与 dsh 核心 fence 一致，Desktop 代理会剥掉这些头）。
- **git 标识符白名单**：`https://`、`ssh://`、`user@host:path`、`file://`（可用 `allowFileProtocol: false` 关闭）；拒绝 `ext::`、`-` 开头的参数与其它传输。
- **命令执行**：全部 `execFile`/`spawn` 参数化，绝不经过 shell；clone 用 `--` 终止选项解析。
- **路径**：slug / skill 名先校验字符集，再拼路径并用 `path.relative` 确认仍在技能库内；本地来源禁止与库目录互相包含。
- **请求体**：上限 64 KiB；未知路由 404；方法不允许 405。

## 7. Web UI

`plugins.tab` 列表槽（Plugins 页，与 Installed/Discover 并列），`id: skills-manager`、`order: 40`。

- **头部**：标题、来源数/技能数、搜索框、`+ 安装技能来源` 按钮。
- **来源卡片**：slug、`git`/`local` 徽标、版本（package.json version 或 git short hash）、git remote、来源级开关、`更新`/`删除`（local 无更新）。
- **技能行**：目录名、frontmatter `name` + `description`、调用策略标记（model/user）、开关；无效行显示原因（橙色）。
- **安装对话框**：来源类型单选（Git 仓库 / 本地目录）、标识符输入、本地覆盖 `force` 复选；安装中显示实时日志（轮询 job）、成功后刷新。
- **反馈**：错误条（带 code）、更新失败可展开原始 git 日志、删除二次确认、busy 时按钮禁用。
- **文案**：`ctx.locale.register('skills-manager', { zh, en })`，组件通过 `t` 注入面取词；英文 sentence case。
- **样式**：内联样式 + `tokens.css` 变量（`--ch-*`）；不引入 ui-primitives 之外的新依赖，不在 bundle 里处理 CSS 文件。

## 8. 配置

```yaml
- id: skills-manager
  name: dsh-skills-manager
  config:
    libraryDir: ~/.dsh/skills-manager/library   # 默认
    statePath: ~/.dsh/skills-manager/manager-state.json # 默认
    linksPath: ~/.dsh/skills-manager/links.json         # 默认
    updatesPath: ~/.dsh/skills-manager/updates.json     # 默认
    providerName: skills-manager
    rank: 450
    routePrefix: /dsh-skills-manager
    allowFileProtocol: true
```

所有值可在 `cordis.yml`/profile patch 覆盖；默认值来自 `resolveDshHome()`，不硬编码 `~`。

## 9. 阶段计划

**P0（本次）Host 内核**
- Config / 库扫描 / 状态存储 / job / installer / provider / HTTP API
- 单测：布局发现、frontmatter、状态稀疏化与原子写、git 标识符白名单、slug 冲突、local 安装、update 失败日志、HTTP 方法/错误码、provider 过滤与 rank

**P1（本次）Web UI**
- 客户端 bundle + `plugins.tab` 标签页 + zh/en 字典 + 安装/更新/删除/开关/搜索
- 构建：tsc（host）+ tsdown（client CJS 工厂）；`npm run build` 产物包含 `lib/` 与 `client/client.js`

**P2 兼容与打磨**
- 来源排序/拖拽、分类编辑、备注编辑、来源内搜索高亮、空态引导、`/skills` 命令

**P3 分发与扩展**
- 项目软链（`<project>/.dsh/skills`）、外部 agent 目录只读聚合与导入、在线检查 git remote 新提交、模型工具 `skill_manager`（搜索/安装/启用）

## 10. 风险与取舍

- **pre-stable API**：`ctx.skills.registerProvider`、`ctx.webServer.register`、client slot 名称与 locale API 都可能变；`engines.dsh` 收窄到验证过的 `>=0.2.2-alpha.2 <0.3.0`，升级后需要重跑测试。
- **Client 构建格式**：bundle 必须输出 `window.__ModuleLoader__.load(...)` 工厂，外部依赖只能是 host 模块表里的 specifier（react 系）。本插件只依赖 `react`，把风险控制在最小。
- **git 可用性**：安装 git 来源要求系统 git；缺失时 503 `GIT_UNAVAILABLE`，本地来源不受影响。
- **不做目录监听**：外部手工改动需要下次 `list()`（registry 缓存失效）或重启；P3 再评估 watcher。
- **不复制 workstation 的 SSE/大而全 UI**：先保证语义与安全，UI 交互保持单一页面可完成。

## 11. 实现状态与验证

**P0 / P1 已实现**（本仓库第一版）：

- Host：`src/{config,library,frontmatter,state,jobs,installer,provider,http,index}.ts`
- Client：`src/client/{index,SkillsTab,api,locales}.tsx|ts`，构建为 `client/client.js`（`window.__ModuleLoader__.load` 工厂，仅 `react`/`react/jsx-runtime` 为外部依赖）
- 项目开关：`links.json` 的 `entries[].enabled` + `PUT /api/links`；全局启停改为 detach/restore，删除才丢弃记录。
- 版本/检查：`src/updates.ts`（`git fetch` + `HEAD...@{u}` 比较、`updates.json`、`POST /api/sources/:slug/check`）；UI 来源卡片展示 `behind/dirty/远端版本/检查时间`。
- 链接：`src/{agent-registry,links}.ts`（项目软链分发、resync、断链/错指修复、外部保护、禁用/删除级联）；HTTP 增加 `/api/agents`、`/api/links`、`/api/links/resync`。
- 测试：`tests/` 共 76 项，覆盖布局发现、frontmatter、状态稀疏化/原子写、git 标识符白名单、本地安装与冲突、真实 git clone/pull、真实软链（建链/幂等/冲突/断链/错指修复/级联）、HTTP 路由/错误码/同源校验、provider 过滤，以及**与真实 `ctx.skills` registry 的集成**（目录可读、`get()` 正文、`invalidate()` 失效、rank 冲突）。

已执行的验证：

```sh
pnpm run typecheck && pnpm test && pnpm run build
pnpm smoke:client                       # 校验 bundle 注册形状（locale + plugins.tab）
cd ../deepseek-harness && pnpm dsh web --patch ../dsh-skills-manager/dev/overlay.example.yml
# curl /dsh-skills-manager/api/library、POST install、GET jobs/:id、PUT/DELETE 均按契约返回
```

未验证：Desktop 壳（`dsh-app://` 下的 fetch 与同源头）、真实模型对话里的 catalog 呈现（无 API key）、旧 Harness 版本。

**默认状态文件**使用 `manager-state.json`，避免覆盖早期实验留在 `~/.dsh/skills-manager/state.json` 的旧格式数据。

**后续（P2/P3）**：分类/备注编辑 UI、来源排序与拖拽、外部 agent 目录只读聚合与导入、其他 agent 的全局目录分发、在线检查远端新提交、`/skills` 命令与模型工具。

## 11. 实现状态与验证

**P0 / P1 已实现**（本仓库第一版）：

- Host：`src/{config,library,frontmatter,state,jobs,installer,provider,http,index}.ts`
- Client：`src/client/{index,SkillsTab,api,locales}.tsx|ts`，构建为 `client/client.js`（`window.__ModuleLoader__.load` 工厂，仅 `react`/`react/jsx-runtime` 为外部依赖）
- 项目开关：`links.json` 的 `entries[].enabled` + `PUT /api/links`；全局启停改为 detach/restore，删除才丢弃记录。
- 版本/检查：`src/updates.ts`（`git fetch` + `HEAD...@{u}` 比较、`updates.json`、`POST /api/sources/:slug/check`）；UI 来源卡片展示 `behind/dirty/远端版本/检查时间`。
- 链接：`src/{agent-registry,links}.ts`（项目软链分发、resync、断链/错指修复、外部保护、禁用/删除级联）；HTTP 增加 `/api/agents`、`/api/links`、`/api/links/resync`。
- 测试：`tests/` 共 76 项，覆盖布局发现、frontmatter、状态稀疏化/原子写、git 标识符白名单、本地安装与冲突、真实 git clone/pull、真实软链（建链/幂等/冲突/断链/错指修复/级联）、HTTP 路由/错误码/同源校验、provider 过滤，以及**与真实 `ctx.skills` registry 的集成**（目录可读、`get()` 正文、`invalidate()` 失效、rank 冲突）。

已执行的验证：

```sh
pnpm run typecheck && pnpm test && pnpm run build
pnpm smoke:client                       # 校验 bundle 注册形状（locale + plugins.tab）
cd ../deepseek-harness && pnpm dsh web --patch ../dsh-skills-manager/dev/overlay.example.yml
# curl /dsh-skills-manager/api/library、POST install、GET jobs/:id、PUT/DELETE 均按契约返回
```

未验证：Desktop 壳（`dsh-app://` 下的 fetch 与同源头）、真实模型对话里的 catalog 呈现（无 API key）、旧 Harness 版本。

**默认状态文件**使用 `manager-state.json`，避免覆盖早期实验留在 `~/.dsh/skills-manager/state.json` 的旧格式数据。

**后续（P2/P3）**：分类/备注编辑 UI、来源排序与拖拽、外部 agent 目录只读聚合与导入、其他 agent 的全局目录分发、在线检查远端新提交、`/skills` 命令与模型工具。

## 12. 与 workstation 参考实现的逐项对照（软链 + 开源 registry）

工作区参考实现在 `workstation/src/services/skillService.js`、`agentRegistryService.js`、`scripts/sync-agent-registry.mjs`，以及 ADR-003 / ADR-004 / ADR-011。

| 维度 | workstation | 本插件 |
|---|---|---|
| 分发模型 | **软链直指技能库**：安装时把 `<project>/<agent 原生 skills 目录>/<skill>` 指向库内技能目录，库更新即时生效 | 一致：同一软链模型；默认目标是 `dsh`（`<project>/.dsh/skills`，即 DSH 的 `project-dsh` root，rank 100） |
| agent 目录约定 | 构建期从 **`vercel-labs/skills@1.5.20`** 的 `src/agents.ts` 提取 75 种约定做 JSON 快照；运行时不调用该库 | 同源**数据**快照（`src/agent-registry.ts`，75 行 + 本地 `dsh` 一行），运行时不调用该库；获取/建链/修复全部自持 |
| 为什么不用库的运行时 | ADR-011：库的 canonical 固定 `~/.agents/skills` 会全局泄露、项目级软链指向项目内副本而非中央库、零编程导出只能 spawn CLI | 同意该结论，沿用其取舍：只取数据，不取实现 |
| 关联意图记录 | 库内 `.linked-skills/<projectId>.json`（视图以磁盘为准，记录只用于修复） | 数据目录 `links.json`：`{ project: { agents, entries } }`，同一分工 |
| 收敛/修复 | agentTypes 变更时收敛；resync 重建、修错指、清断链；外部实体不碰 | 同：link/unlink/resync；缺失重放、错指修复、断链清理、冲突/外部条目只报告不修改 |
| 冲突保护 | 非 workstation 创建的条目、外部软链 → 跳过并表面化 | 同：真实文件/目录、外部软链 → `conflict`/`external`，不删除 |
| 来源删除 | 先级联删链再删目录 | 同：`forgetSource()` → 删目录 |
| 开关语义 | 无全局启停 | 额外提供**全局启停**：禁用的技能不进 catalog，并级联删除其项目软链（"停用"在任何 agent 中都不可见） |
| 全局可用 | 仅项目分发（另有 builtin CLI skills 特例） | DSH 通过 provider 全局可用；项目软链用于跨 agent / 项目内收敛；其他 agent 的全局目录暂不分发 |
| 更新传播 | `git pull --ff-only`；软链使所有项目即时生效 | 同（spawn，无 shell） |
| 跨 agent 全局泄露风险 | 明确禁止把库放在 `~/.agents/skills` 等扫描目录 | 库在 `~/.dsh/skills-manager/library`，不在任何 agent 的扫描 root 内；只有显式 link 才进入项目目录 |

结论：参考实现的两点核心——**软链分发**与**开源 registry 只作数据源**——本插件都已按同一原则实现；差异只在"全局启停"和"DSH 原生 catalog 接入"两点上更贴近 dsh 的插件模型。

## 13. 链接实现细节（本插件）

- 目标目录由 `agent-registry.ts` 的 `skillsDir` 展开为 `<project>/<skillsDir>`；多个 agent 共享同一目录时（如 `.agents/skills` 被 19 个 universal agent 使用）只建一条链，状态行里列出全部 agent。
- Windows 使用 `junction`，其他平台用目录软链。
- 健康判定：`realpath(link) === realpath(期望技能目录)`；解析失败 → `broken`；指向库内其它技能/库外 → `external`；非软链 → `conflict`。
- `resync` 只修复"名字等于记录的技能名、且目标在库内"的链接；外部条目永不改写。
- 状态比较全部经过 `realpath` 规范化（覆盖 macOS `/tmp → /private/tmp` 这类差异）。
- 记录文件与状态文件一样采用临时文件 + rename 原子写；读失败按空记录处理并告警。
- 禁用技能/来源、删除来源都会级联清理链接；重新启用不会自动重建，需要用户点 **Resync**（避免"停用"被隐式撤销）。

## 14. 版本号与更新检查（与 workstation 对齐）

参考实现的版本/更新语义（`skillService.readSourceVersion`、`requestSourceUpdate`）：

| 能力 | workstation | 本插件 |
|---|---|---|
| 版本来源 | `package.json.version` → `git rev-parse --short HEAD` | `package.json.version` → `git describe --tags --always --dirty`（更易读，含 tag 与 dirty 标记） |
| 更新动作 | `git pull --ff-only`，失败保留原始输出 | 同（spawn，无 shell，保留 `job.log`） |
| 更新检查 | 无（只提供手动更新） | 新增：`git fetch --tags --prune origin` 后比较 `HEAD...@{u}`，记录 `behind/ahead/dirty/remoteCommit/remoteVersion` |
| 检查结果存储 | — | `updates.json`（原子写），随 `GET /api/library` 返回，UI 在来源卡片上展示 |
| 本地来源 | `force` 重新添加覆盖 | 同；检查返回 `SKILL_UPDATE_UNSUPPORTED` |
| 远端异常 | 更新失败进 job.error | 检查失败记录为 `check.error`（不抛给 UI，也不阻塞列表） |

为什么不引入 `vercel-labs/skills`：它只做"往 agent 目录安装 + `skills-lock.json`"，没有中央库、版本管理和更新检查；唯一可复用的是 agent 目录约定数据，已按 ADR-011 的方式做成构建期快照（`src/agent-registry.ts`）。因此版本/检查/更新全部自持，与参考实现同构。

## 15. 两层开关语义（全局 vs 项目）

| 层级 | 载体 | 关闭时 | 重新打开时 |
|---|---|---|---|
| 全局（库） | `manager-state.json` 的 `sources/skills.enabled` | 移出 `ctx.skills` catalog；同时 **detach** 所有项目软链，但保留 `links.json` 记录 | 恢复 catalog；**restore** 各项目中该条目仍为 `enabled` 的链接（项目侧关闭的条目保持关闭） |
| 项目 | `links.json` 的 `entries[].enabled` | 删除该项目内该技能的软链，记录保留（项目视图显示为 disabled） | 校验全局可用后重建软链 |
| 删除 | `DELETE /api/sources/:slug` | 删目录 + 删记录（真正移除） | — |

因此同一个技能可以「项目 A 开、项目 B 关」，而全局关闭表示"任何地方都不可用"；这与参考实现"关联即生效"相比多了一层，但保留了其「磁盘为准 + 记录用于修复」的分工。

实现：`LinkManager.setEnabled`（项目开关）、`detach` / `restore`（全局开关的级联与恢复）、`forget*`（删除）；HTTP `PUT /api/links`；UI 项目面板每个条目一个 Switch + 取消。
