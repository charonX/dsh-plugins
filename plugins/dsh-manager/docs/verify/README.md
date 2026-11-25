# Dsh Manager 提示词工作台与流程预设验证手册

本手册补充说明 `plugins/dsh-manager` 中提示词分层模板、契约段锁定、实时预览、历史原文回看与只读流程预设的验证入口（配合工作区顶层 [docs/verify/README.md](../../../../docs/verify/README.md) 执行）。

## 1. 必跑门禁命令

```sh
# 1. 插件宿主兼容性门禁（不可仅用单仓 typecheck 替代）
cd repos/dsh && ./check-plugins-against-harness.sh --skip-build plugins/dsh-manager

# 2. 提示词内核、Schema v2、预设、客户端与 Boot 集成测试
cd repos/dsh/plugins/dsh-manager
pnpm vitest run tests/unit/prompt-kernel.spec.ts tests/unit/team-config-core.spec.ts tests/unit/presets.spec.ts tests/client/prompt-studio.client.spec.ts tests/boot/prompt-studio.boot.spec.ts

# 3. 真实 Web 页面 E2E（启动隔离实例并验证）
pnpm run e2e
```

## 2. 真实页面核查与截图清单

1. **团队 → 提示词子视图（深浅色各 1 张）**：左侧树展示 8 个内置轮次、流水线/环节覆盖节点、只读变量目录；右侧展示来源徽标（`builtin`/`global`/`pipeline`/`stage`）、锁定段只读块及底部实时预览。
2. **锁定段与变量拦截**：`executor.report` 等锁定段无输入控件；在 `identity` 填入 `{{nope}}` 点击保存 → 二次确认后提示 `unknown variable "nope"` 且 `team-config.yaml` mtime 不变。
3. **缺值跳过与项目解耦预览**：在预览面板切换至无 `docs/verify` 的项目，观察缺失变量高亮警告（非阻断）且输出不含空行。
4. **实际下发回看**：派发工单后在工单详情展开「实际下发提示词」查看完整原文与段落来源；在运行监控 → 管家活动展开 `查看提示词` 核对轮次原文。
5. **预设复制**：在编排工作台点击「从预设复制」→ 复制「缺陷修复」，确认生成 3 个环节、自动复用或新建队员并立即可被路由规则选择。

## 3. 失败回滚

- 若在 UI 误改模板或导入异常配置：`team-config.yaml` 内所有非法写入在原子落盘前均被拒绝，不会破坏内存有效配置；
- 若需回退已保存的合法覆盖：在对应段落点击「恢复继承」或「恢复默认」并确认保存，或在「提示词」顶部使用「导入 YAML」粘贴备份内容恢复；如覆盖全部清除，配置保持整洁可重新切回内置默认。
