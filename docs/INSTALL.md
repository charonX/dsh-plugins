# 集成到 dsh：安装与实机测试

插件有两种集成方式：**overlay（源码行）** 用于开发，**bundle（profile 安装）** 才是真实的发布路径。本文只讲后者。

## 0. 选运行时（必须与安装时一致）

| 运行时 | 命令 | 版本 |
|---|---|---|
| Desktop 注册的 `dsh` 命令 | `dsh ...`（Desktop → Manage dsh Command… 可注册） | Desktop 安装版本（当前 0.2.1-rc.5） |
| 发布版运行时 | `npx -y @deepseek-ai/dsh@0.2.2-alpha.2 ...` | 0.2.2-alpha.2 |
| 源码 harness | `cd deepseek-harness && pnpm dsh ...` | 0.2.2-alpha.2 |

`engines.dsh` 现在接受 `>=0.2.1-rc.5 <0.3.0`；安装和启动必须用同一个运行时，否则兼容性校验会拒绝或行为不一致。

## 1. 一条命令的安装验证（推荐）

```sh
cd dsh-skills-manager
pnpm verify:profile          # 9 项检查，约 30s
pnpm verify:profile -- --keep  # 保留隔离的 DSH_HOME 和 tarball 便于排查
DSH_HARNESS_DIR=/path/to/deepseek-harness pnpm verify:profile
```

它做的事：

1. `npm run build` + `npm pack`（验证 `files` 打包内容）；
2. 在临时 `DSH_HOME` 里用 `--from-default-profile web` 建一个隔离 profile；
3. `dsh plugin --profile <p> add <tarball>`；
4. 断言 profile manifest 的 `dsh.profile.bundles`、`--dump-config` 的 `# == dsh-skills-manager` 层、安装包里 `lib/index.js` / `client/client.js` / `cordis.patch.yml` 都在；
5. 启动这个 profile，验证 `/dsh-skills-manager/api/library` 和浏览器 bundle（boot graph + `__ModuleLoader__` 注册）；
6. `dsh plugin remove`，确认 bundle 与层都消失。

全程不碰 `~/.dsh`、不碰真实项目；结束时删除临时目录与 tarball（`--keep` 例外）。

前置：harness 已 `pnpm run build`；tarball 安装会从 registry 取 `@deepseek-ai/dsh-home-paths` 与 `yaml`（缓存/离线环境可用下面的 linked checkout 方式）。

## 2. 手工装进一个真实 profile

以新建的 `skills-test` 为例：

```sh
# 1) 用 Web 模板建 profile（--dump-config 只创建并打印，不启动）
dsh --profile skills-test --from-default-profile web --dump-config >/dev/null

# 2) 打包并安装（二选一）
cd /path/to/dsh-skills-manager
npm run build
npm pack                                  # 产出 dsh-skills-manager-0.1.0.tgz
dsh plugin --profile skills-test add "$PWD/dsh-skills-manager-0.1.0.tgz"
# 或者直接装 linked checkout（迭代更快，行为等价）
dsh plugin --profile skills-test add "$PWD"

# 3) 检查装配
dsh --profile skills-test --dump-config | grep -A2 "== dsh-skills-manager"
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/skills-test/package.json'))['dsh'])"
```

启动与验收：

```sh
dsh --profile skills-test --no-open --port 3099
# 打开日志里的 http://127.0.0.1:3099/?token=…，Plugins → Skills
curl -s http://127.0.0.1:3099/dsh-skills-manager/api/library
```

浏览器里按 `docs/VERIFY.md` 的 L2 清单走一遍：安装来源 → 版本/检查更新 → 关联项目（`.dsh/skills` 软链）→ 两层开关 → Resync → 冲突保护。

卸载：

```sh
dsh plugin --profile skills-test remove dsh-skills-manager
dsh --profile skills-test --dump-config | grep skills-manager || echo "layer removed"
# 可选：删除 profile 目录或 --from-default-profile web 重置
```

## 3. 装进 Desktop

当前 Desktop 是 **0.2.1-rc.5**，已落在 `engines.dsh` 范围内，不需要版本豁免。

- 方式 A（推荐）：Desktop → **Plugins → Add plugin → 本地路径**，选 `dsh-skills-manager` 目录或 tarball；安装后启用、重启（或等 HMR），Plugins 页出现 **Skills** 标签。
- 方式 B：Desktop 菜单 **Manage dsh Command…** 注册 `dsh` 命令 → 退出 Desktop → `dsh plugin --profile desktop add <tarball>`（Desktop profile 只能由 Desktop 启动，CLI 不能 boot 它）。

Desktop 的页面来自 `dsh-app://`，请求经 IPC 桥转发；自动化脚本只覆盖 `dsh web`，所以 Desktop 需要人工确认一次（标签出现、安装/关联/开关可用）。

## 4. 兼容性矩阵（实测）

| 运行时 | 安装路径 | 已验证 |
|---|---|---|
| 源码 harness `0.2.2-alpha.2` | overlay（`verify:local`）、profile（`verify:profile`） | host API、软链、两层开关、git 检查/更新、client bundle、boot |
| 发布运行时 `0.2.1-rc.5`（与当前 Desktop 同版本） | 隔离 profile + tarball | profile 安装/卸载、Web boot、`/api/library`、client bundle、mock-LLM headless 回合（`exit 0`） |
| Desktop `0.2.1-rc.5` | 应用内安装 | 待人工确认 UI（自动化未覆盖 `dsh-app://`） |

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `engines.dsh` 拒绝安装 | 运行时 < 0.2.1-rc.5；升级运行时，或用 `dsh plugin ... allow-version ... --accept-risk` |
| 安装时 peer 警告 | 正常：`@deepseek-ai/cordis`、`schemastery` 由宿主提供，不会被装进 profile |
| `--dump-config` 没有层 | 确认 `dsh.profile.bundles` 里有 `dsh-skills-manager`；`dsh plugin add` 是否用了同一个 `DSH_HOME` |
| 页面没有 Skills 标签 | 看 boot graph 是否含 `dsh-skills-manager/client.js`；再看浏览器 console；最后确认 host 半已加载（`/dsh-skills-manager/api/library` 是否 200） |
| 离线安装失败 | 用 linked checkout（`add /path/to/plugin`）避免拉取 `dsh-home-paths`/`yaml`；或预填 pnpm store |
| 安装后启动行为没变 | 安装与启动用了不同运行时（版本或路径不同） |
