# Dsh Manager (`@charonx/dsh-manager`)

DeepSeek Harness 的外置 bundle：外部系统 Trigger 收集（GitLab MR/流水线、Jira）+ 主 Session 工单管理看板与团队流水线调度。

术语以 [GLOSSARY.md](GLOSSARY.md) 为准；关键决策见 [docs/adr/](docs/adr/)；规格说明见 [docs/specs/0001-dsh-manager.md](docs/specs/0001-dsh-manager.md)。

## 目录结构

```
plugins/dsh-manager/
├── cordis.patch.yml          # Cordis bundle 配置层
├── locale/                   # 国际化词典
├── src/                      # Host 域服务、Remote 定义与 Client UI
├── tests/                    # 单元测试、Client 测试与 Boot 测试
├── docs/                     # 规格、ADR 与开发记录
├── GLOSSARY.md               # 领域术语表
├── tsdown.host.config.ts     # Host 构建配置
├── tsdown.remote.config.ts   # Remote 构建配置
└── tsdown.client.config.ts   # Client CJS ModuleLoader 工厂构建配置
```

## 安装

在宿主（`deepseek-harness`）已构建的环境里，把 bundle 装进一个 profile：

```sh
# 方式一：使用工作区开发脚本自动扫描、构建并关联
./dev.sh --link-missing

# 方式二：手动从本地目录安装（pnpm 以 link 方式接入）
cd deepseek-harness
pnpm dsh plugin --profile web add ../plugins/dsh-manager

# 或打包后安装
cd plugins/dsh-manager && pnpm pack
cd ../../deepseek-harness
pnpm dsh plugin --profile web add ../plugins/dsh-manager/charonx-dsh-manager-0.1.0.tgz
```

安装成功后 profile 的 `dsh.profile.bundles` 会列出 `@charonx/dsh-manager`。启动 `dsh --profile web` 后，侧边栏出现对应管理面板入口（看板 `board` / 团队 `team` / 策略 `policy` / 运行监控 `monitor` / 设置 `settings`）。

## 开发

```sh
# 在仓库根目录安装 workspace 依赖
pnpm install

# 构建 / 类型检查 / 测试（在 plugins/dsh-manager 下）
pnpm run build     # 构建 Host、Remote 与 Client 产物到 lib/（boot 测试加载 lib/）
pnpm run typecheck # 类型检查
pnpm run test      # 全量测试

# 使用本地 deepseek-harness 构建产物做联调校验
./check-plugins-against-harness.sh plugins/dsh-manager
```

要求：宿主环境可用、`Node >= 24.9`、全平台兼容（Windows/macOS/Linux，不依赖 tmux 等平台专属工具）。真实 API 测试需要 `DEEPSEEK_API_KEY`（可放根目录 `.env`），CI 无 key 自动跳过。
