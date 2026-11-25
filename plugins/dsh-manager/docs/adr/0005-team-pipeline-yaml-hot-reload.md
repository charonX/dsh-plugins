# 0005: 团队、流水线与路由配置的声明式 YAML 单一事实源与热更新

日期: 2026-11-24
状态: accepted
关联: ADR-0003（副作用队列与领域存储选型）

## 背景

ADR-0003 将 `dsh-manager` 的全部领域状态统一落在宿主 `storage-domain`（启动时一次性 `loadAll` 进内存，之后内存为权威，外置编辑磁盘 JSON 不被感知）。但在团队协作与编排场景下：

1. 用户经常通过对话（内置会话或接入 MCP 的第三方 CLI）让 Agent 直接检视或调整队员角色、流水线环节和路由规则；
2. 人工也希望以人可读、可版本化的格式直接查看和编辑这些编排配置，并在保存后立即对 UI 与后续派工/推进生效，无需重启 DSH；
3. 与此同时，`Board`（工单、派工、评估、Attention）、`Effects`、`Connections`、`Policy` 等高频运行态或高一致要求的状态仍需保留 `storage-domain` 的写链语义。

## 决策

### 1. 将 Crew / Pipeline / Route 迁出 `storage-domain`，收敛至单一声明式 YAML

- 默认文件路径：`<DSH_HOME>/dsh-manager/team-config.yaml`（可通过 `BundleConfig.teamConfigPath` 覆盖）。
- 首次启动且 `team-config.yaml` 不存在时，只读打开旧 `dsh_manager_{crew,pipeline,route}` domain 导出迁移并清理孤立引用，随后关闭旧 domain；此后以 YAML 文件为唯一事实源（SSOT）。
- `DshManagerCrew`、`DshManagerPipeline`、`DshManagerRoute` 保留原有对外 `@Remote` 接口与服务名不变，内部读写均路由至 `DshManagerTeamConfig` 单写链。

### 2. 全量原子校验（All-or-Nothing）与防回环热加载

- 文件写入使用同目录临时文件 + `rename` 原子替换，并记录内容 SHA-256 指纹，避免 `fs.watch` 产生自触发重读循环。
- 每次加载（无论来自启动、文件监听还是工具写入）均执行「YAML 语法 → Zod schema → ID 唯一性 → 跨实体引用完整性（`stage.memberId` 存在、`rule.pipelineId` 存在）」全量校验。
- 非法文件变更**绝不覆盖内存有效配置**，保留上一份有效配置继续服务在途流程，并通过 `teamConfigStatus()` 的 `lastError` 字段与日志/UI 提示用户修复。

### 3. 在途流程（FlowRun）安全热生效

- 已完成或正在运行中的 Executor Session 不强制打断重启；
- 下一步 `advanceFlow`、里程碑投影与流程 Markdown 镜像改为实时读取当前 `Pipeline` 的最新 `stages.length`、`name` 与队员卡片，解除接单时 `ticketFlow.stageCount` 快照截断限制。

## 后果

- **正向**：人工编辑 YAML、UI 表单修改、对话工具 / 第三方 CLI MCP 调用三条路径统一落入同一校验与热生效管线；前端与运行中流程同步感知最新编排。
- **约束**：因强约束 YAML 内引用完整性，UI 二次确认强制删除队员或流水线时，会同步清理引用它的环节/规则，保证落盘 YAML 始终自洽。
