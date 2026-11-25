# Dsh Manager 团队与流程配置热更新

## Sub-features

- 声明式 YAML 单一事实源（`<DSH_HOME>/dsh-manager/team-config.yaml`）：统一承载队员（Crew）、流水线（Pipeline）与路由规则（RouteRule），首次启动自动迁移旧 `storage-domain` 数据
- `fs.watch` 防回环热加载 + 全量原子校验：非法语法或跨实体引用断链时保留上一份有效内存配置，在 Team 页顶部展示告警条并支持一键重载恢复
- 对话与第三方 CLI MCP 注入：`dsh_manager_team_config_get`、`dsh_manager_team_config_replace`、`dsh_manager_team_member_upsert`、`dsh_manager_flow_config_upsert` 注册于全局 `ctx.tools`，自动由 `external-agents` 的 `HostToolsMcpBridge` 注入 `claude` / `codex` / `agy` / `pi`（`plan` 模式只放行只读工具）
- 在途流程（`FlowRun`）动态推进：`advanceFlow` / `applyReview` / `flowTimelineOf` / `flows/*.md` 镜像读取实时流水线定义与阶段数，不被接单时 `stageCount` 快照截断

## How to get to it (user POV)

进入左侧栏 `dsh-manager` 面板的 `团队` 标签页，查看/编辑队员、流水线、路由规则；或直接在对话（含接入 MCP 的外部 Agent）中修改 `~/.dsh/dsh-manager/team-config.yaml`。

## Driving it

1. 文件热加载与错误自愈：`pnpm --filter @charonx/dsh-manager test`（`tests/unit/team-config-core.spec.ts`、`tests/boot/team-config.boot.spec.ts`）。
2. 在途流程扩编/缩短：`tests/boot/flow-hot-reload.boot.spec.ts`。
3. 对话工具与第三方 CLI MCP 注入：`tests/boot/team-config-tools.boot.spec.ts` 及 `pnpm --filter @charonx/external-agents test`（`tests/adapters.spec.ts`、`tests/mcp-bridge.spec.ts`）。
4. 前端实时同步与告警条：`tests/client/team-config-sync.client.spec.ts` 及 `pnpm --filter @charonx/dsh-manager e2e`。
5. 宿主一致性门禁：在 `repos/dsh` 执行 `./check-plugins-against-harness.sh --skip-build plugins/dsh-manager plugins/external-agents`。

## Gotchas

- `team-config.yaml` 更新采用原子写替换与内容哈希去重；外部直接编辑保存后通常在 100ms 内生效，Team 页面以 2s 周期同步版本与错误状态。
- 校验失败不会中断或重置当前运行中的 Steward / Executor，修复文件保存后错误横幅自动清除。
