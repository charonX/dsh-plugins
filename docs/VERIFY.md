# 本地验证指南

插件的验证分四层：能自动跑的尽量自动跑，只有「浏览器里看起来对不对」和「Desktop 壳」需要人眼确认。

| 层级 | 命令 | 证明什么 | 成本 |
|---|---|---|---|
| L0 静态 + 单测 | `pnpm typecheck && pnpm test && pnpm run build && pnpm run smoke:client` | 类型、业务语义、真实 git/软链/HTTP、bundle 注册形状 | ~5s |
| L1 一键联调 | `pnpm verify:local` | 从源码起一个真实 `dsh web`，跑通安装→软链→开关→更新检查→客户端 bundle | ~40s |
| L2 手工 UI | 见下文 | 浏览器里的交互、文案、布局、`/` 菜单和 `skill` 工具 | 几分钟 |
| L3 profile 安装 | `dsh plugin add` | 发布路径：`dsh.bundle` / `dsh.client` 清单被 profile 正确加载 | 几分钟 |
| L4 Desktop | 手工 | Electron 壳（`dsh-app://` 源、IPC 桥） | 手工 |

## L0 静态与单元

```sh
pnpm typecheck      # host / client / tests 三套 tsc
pnpm test           # vitest：库扫描、frontmatter、状态、git 安装更新、软链、HTTP、provider、registry
pnpm run build      # tsc → lib/，tsdown → client/client.js
pnpm run smoke:client
```

`smoke:client` 会在 Node 里执行打包后的 `client/client.js`，断言它向 `window.__ModuleLoader__` 注册了 `dsh-skills-manager`、注册了 locale 字典和 `plugins.tab`——不需要浏览器。

## L1 一键联调（改完代码先跑这个）

```sh
pnpm verify:local                # 默认在 ../deepseek-harness 找 harness
DSH_HARNESS_DIR=/path/to/harness pnpm verify:local
pnpm verify:local -- --keep      # 失败排查时保留临时目录、overlay 路径
```

前置条件：

- harness checkout 已 `pnpm run build`（脚本会检查 `packages/skill/skill/lib/index.js`）；
- 系统有 `git`（git 来源的版本/检查/更新用例需要）；
- Node ≥ 24。

脚本做的事：

1. 重新构建本插件；
2. 在系统临时目录生成隔离 fixture：`library/`、`project/`、本地来源（alpha + beta）、本地 git 远端（tag `v1.0.0`）；
3. 写一份 overlay（`libraryDir/statePath/linksPath/updatesPath` 全部指向临时目录）；
4. 用 `node --import tsx/esm apps/cli/src/bin.ts web --patch <overlay> --no-open --port 0` 起真实宿主，从日志里取地址和 token；
5. 断言 8 项：

| # | 断言 |
|---|---|
| 1 | 构建产出 `lib/index.js` 与 `client/client.js` |
| 2 | 宿主带 overlay 启动成功 |
| 3 | 本地来源安装 job 成功，列表里 2 个技能 |
| 4 | 关联项目后 `.dsh/skills/<skill>` 是指向库的软链 |
| 5 | 项目开关关闭：只撤该技能的链，记录保留 |
| 6 | 全局开关关闭：所有链撤掉、记录保留；重新开启恢复（项目关闭的仍保持关闭） |
| 7 | git 来源版本 `v1.0.0`；远端新提交后 `behind = 1`；`update` 后 `behind = 0` |
| 8 | 浏览器 bundle 出现在 boot graph 且可通过 `/plugins/…` 取到，包含 `__ModuleLoader__` 注册 |

脚本结束时销毁子进程并删除临时目录（`--keep` 例外），**不会读写 `~/.dsh` 或你的真实项目**。

常见失败：

| 现象 | 原因 / 处理 |
|---|---|
| `Harness build artifacts are missing` | 先去 harness 跑 `pnpm run build` |
| `dsh web did not print a URL` | 端口/tsx 问题；加 `--keep` 后用打印的 overlay 手工复现 |
| `job failed: SKILL_FETCH_FAILED` | 临时 git 远端初始化失败（缺 git 或用户身份），脚本已设置本地 user.name/email |
| 结束后仍有进程 | 脚本直接 spawn `node`，SIGTERM 会终止；如有残留 `pkill -f 'apps/cli/src/bin.ts web'` |

## L2 手工 Web UI 检查清单

起一个开发宿主（推荐复用 `--keep` 打印的 overlay，或 `dev/overlay.example.yml`）：

```sh
cd ../deepseek-harness
pnpm dsh web --patch /path/to/overlay.yml --no-open --port 3099
# 打开日志里的 http://127.0.0.1:3099/?token=…
```

左栏 **Skills**（在 Plugins、自动化任务下方）逐项确认：

- [ ] 左栏出现带图标的 **Skills** 入口，点击后进入独立页面（不再挂在 Plugins 页签里）
- [ ] 来源卡片与「已关联项目」默认**收起**；点行首箭头/整行展开；工具栏与项目区各有「全部展开/全部收起」
- [ ] 项目行的每个条目只显示状态 + agent 名（如 `已关联 dsh`），不显示 `.dsh/skills/...` 路径
- [ ] 「关联到项目」的项目字段是多选下拉：可选多个工作区或添加自定义路径，一次关联多个项目
- [ ] 「扫描已安装技能」列出全局来源与状态；导入后库中出现 `imported-<来源>`；同名不同内容显示「同名冲突」，勾选覆盖只替换此前导入的副本
- [ ] 安装本地目录（含 `skills/<name>/SKILL.md`）：进度日志、失败码（`.dsh/…` 路径、冲突 `409`）
- [ ] 安装 git 源：clone 日志、版本号（tag / short hash）
- [ ] **检查更新**：`已是最新`；给远端加提交后再次检查显示 `有 N 个新提交`；更新后回到 `0`
- [ ] 关联项目：路径可直接从 DSH 工作区点选；`ls -l <project>/.dsh/skills` 看到软链指向库
- [ ] 项目开关：关掉某技能 → 只该项目的链消失、记录保留（重开恢复）
- [ ] 全局开关：关掉来源 → 所有项目链消失、记录保留；重开自动恢复
- [ ] **Resync**：手工删一个链后能补回；把链改指到别的库内技能后能修回
- [ ] 冲突保护：在 `<project>/.dsh/skills/<name>` 放一个真实目录后再关联，界面显示 `冲突`，目录内容不被改
- [ ] 断开/删除：删除来源后项目链与记录一起清理

模型与用户侧（同一个页面即可验证）：

- [ ] 输入 `/` 能看到技能并插入；`/name` 直接调用
- [ ] 让模型调用 `skill` 工具，卡片能展开 `Instructions`
- [ ] 切换到该项目工作区，项目会话能看到已关联技能（`project-dsh` rank 100），停用的不可见

状态文件（默认在 `~/.dsh/skills-manager/`）：

```sh
ls -l ~/.dsh/skills-manager/{library,manager-state.json,links.json,updates.json}
```

## L2b 模型侧（无 API key）

只验证「插件不破坏一次完整模型回合」时，用仓库自带 mock LLM：

```sh
cd ../deepseek-harness
pnpm run mock:llm --port 8123 --api-key mock-key --sequence success
# 另开终端
DEEPSEEK_BASE_URL=http://127.0.0.1:8123/v1 DEEPSEEK_API_KEY=mock-key \
  pnpm dsh --profile headless --patch /path/to/overlay.yml "say hi"
```

`skill` 目录本身已由 `tests/registry-integration.spec.ts` 用真实 `ctx.skills` 断言（list / get / invalidate / rank）；UI 的 `/` 菜单是最直观的人工确认。

## L3 以 bundle 方式安装（发布路径）

一键版：

```sh
pnpm verify:profile            # tarball：打包 → 隔离 DSH_HOME → 建 profile → 安装 → 启动 → API/bundle → 卸载，9 项
pnpm verify:profile -- --linked  # 同样 9 项，但装 linked checkout（不打包）
```

手工版（真实 profile）与 Desktop 步骤见 [INSTALL.md](INSTALL.md)。要点：

```sh
# 需要一个 dsh 命令：Desktop 安装的命令，或 harness 源码里的 pnpm dsh
dsh plugin --profile dev add /abs/path/to/dsh-skills-manager
dsh --profile dev --dump-config | grep -n "skills-manager"
dsh --profile dev web --no-open          # 或 dsh --profile dev（GUI）
dsh plugin --profile dev remove dsh-skills-manager
```

要点：

- 安装与启动要用**同一个运行时版本**（`engines.dsh` 会校验）；
- `--dump-config` 应出现 `# == dsh-skills-manager` 层；
- 客户端半通过 `dsh.client` 声明被扫进 boot graph；如果页面没有 Skills 标签，先看 `dsh --profile dev --dump-config` 是否启用了该行。

## L4 Desktop

Plugins → **Add plugin** → 本地路径安装，然后在同一页面验证 Skills 标签、软链、开关。注意 Desktop 的页面来自 `dsh-app://`，请求经 IPC 桥转发；本仓库的自动化验证目前只覆盖 `dsh web`，Desktop 需要人工确认（已知限制）。

## 排错速查

| 现象 | 排查 |
|---|---|
| Skills 标签不出现 | boot graph 里有没有 `dsh-skills-manager/client.js`；`dsh.client` 清单；浏览器 console |
| 宿主报配置错误 | `routePrefix` 需以 `/` 开头；`libraryDir`/`linksPath` 是否可写 |
| 技能不出现在 `/` 菜单 | 全局是否启用；frontmatter `name` 是否 kebab-case；来源是否在库内 |
| 关联后项目看不到技能 | 项目根是否真的在该目录（DSH 用最近 `.git` 祖先）；`ls -l` 确认软链；项目会话是否已切换工作区 |
| 更新检查报错 | 远端协议白名单；`file://` 是否被 `allowFileProtocol` 允许；`git fetch` 的原始错误会显示在卡片上 |
