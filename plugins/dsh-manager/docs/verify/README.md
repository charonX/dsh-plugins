# Dsh Manager Skill-Driven Flow IR 验证手册

本手册说明 `plugins/dsh-manager` 中 Schema v3 Flow IR、Playbook 一次编译与 Hash 缓存、Skill 目录聚合、薄管家推进与单步通用执行兜底的验证入口（配合工作区顶层 [docs/verify/README.md](../../../../docs/verify/README.md) 执行）。

## 1. 必跑门禁命令

```sh
# 1. 插件宿主兼容性门禁（不可仅用单仓 typecheck 替代）
cd repos/dsh && ./check-plugins-against-harness.sh dsh-manager

# 2. 类型检查、构建与全量单元测试 / 客户端 Slot 测试 / Boot 集成测试
cd repos/dsh/plugins/dsh-manager
pnpm run typecheck && pnpm run build && pnpm run test

# 3. 真实 Web 页面 E2E（启动隔离实例并验证）
pnpm run e2e
```

## 2. 真实页面核查与截图清单

1. **团队与流程 → 流程编排 / 可用技能（深浅色各 1 张）**：顶层 5 个 Tab（`看板 / 团队与流程 / 策略 / 运行监控 / 设置`），`团队与流程` 下仅保留「流程编排」与「可用技能」两个子视图，无 `队员名册` / `提示词` 冗余入口。
2. **Playbook 一次识别与缓存徽标**：通过「从 Playbook 识别」或 `可用技能` 列表的「识别为流程」按钮导入含步骤说明的 Skill / Markdown，验证拓扑图立即展示完整步骤链表、挂载技能、失败打回（`onFail`）回环及 `已缓存 #<hash>` 来源标记。
3. **首次自动建流与工作区 Playbook 优先覆盖**：
   - 全新空白 `DSH_HOME`（无 `team-config.yaml` 且无旧版 storage domain）启动后，系统自动编译工作区 `skills/playbooks/*.md`（缺省时回退插件随包内置 `playbooks/*.md`）生成 `code-dev`、`bug-fix`、`knowledge-creation`（`in-place` 挂载 `how`/`writing`）与 `refactoring`；
   - 点击「从预设复制」弹窗可看到发现来源标记（`工作区` / `内置默认`）与 `#<hash>` 摘要，支持刷新扫描与一键复制；
   - 将 `team-config.yaml` 清空为 `flows: []` 后重启，系统保留用户改动不再强制塞回默认 Flow，并回归「单步通用执行」兜底。
4. **单步通用执行兜底**：未配置/未启用任何流程时，「流程编排」展示单步通用执行提示；向 Steward 提交需求不再生成阻塞性的 `[none]` 人工补充规则等待项。
5. **YAML 热更新与校验拦截**：写入非法 `onFail` 引用到 `team-config.yaml`，页面顶部持续展示校验错误横幅并保留上一份有效 Flow；修复并点击「重新加载」后恢复正常。

## 3. 失败回滚

- 若在 UI 误改流程或导入异常 YAML：`team-config.yaml` 内所有非法写入在原子落盘前均被校验拦截（`validateFlows`），内存保留上一份有效配置；
- 若升级前存在 v1/v2 `team-config.yaml`（含 `crew` / `pipelines` / `routes`），`parseTeamConfigYaml` 与 `migrateLegacyDomainsToFlows` 会在加载时自动转换为 v3 `flows[]`；通过「YAML 配置」弹窗可随时导出备份与回滚。
