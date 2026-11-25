# DSH 验证手册（`repos/dsh`）

本手册供通用 `/verify` Skill 在 `repos/dsh` 工作区内执行实证验证时读取。所有操作遵守 [repos/dsh/AGENTS.md](../../AGENTS.md) 的安全边界：**严禁在输出、日志或证据文件中打印任何 `.env`、会话 token、密码或凭据。**

## 1. Surface（验证表面）

- **主表面**：`dsh web`（Cordis Host + Web UI + 插件 HTTP API + Cordis Remote RPC，默认端口 `3080`）。
- **门禁表面**：`deepseek-harness` 构建产物一致性 + `./check-plugins-against-harness.sh` + 插件 `vitest` 单元测试。

## 2. Doctor（只读前置体检）

在驱动 UI 或接口前，先运行只读体检脚本：

```sh
./docs/verify/scripts/doctor.sh
```

脚本检查四项前置条件（任一失败或产品过期均应先修复再测）：
1. `deepseek-harness` 关键产物存在且不比 `src/**/*.ts` 旧；
2. 工作区插件（`dsh-manager`、`external-agents`、`skills-manager` 等）的 `lib/` 与各自 `exports['./client']` 产物不比 `src/` 旧；
3. `~/.dsh/profiles/web/package.json` 的 `link:` 路径均指向当前 `repos/dsh` 下的对应插件目录；
4. 本机 `127.0.0.1:3080`（可通过 `DSH_VERIFY_PORT` 覆盖）服务存活状态及核心只读路由可达性。

再跑宿主类型与构建对齐门禁（不可用单仓 `pnpm typecheck` 替代）：

```sh
./check-plugins-against-harness.sh --skip-build
```

## 3. Launch（启动与隔离约定）

- **构建并启动（或热重载已运行实例）**：
  ```sh
  ./dev.sh -a -p web --port 3080
  ```
  - 若 `127.0.0.1:3080` 已在运行，仅重新构建改动插件并用 `./dev.sh --reload-only` 触发 Host 半重载（客户端由 `dsh-client-hmr` 自动热替换）。
  - 若需后台新起实例做隔离验证，先确认端口未被他人占用，记录启动的 PID 以便在 Cleanup 阶段精确终止；不要使用 `pkill` 按进程名误杀用户主会话。
- **直接源码启动命令**（`dev.sh` 底层等价命令）：
  ```sh
  cd deepseek-harness && pnpm dsh web --port 3080
  ```

## 4. Drive（功能驱动入口）

按 [features/README.md](features/README.md) 索引逐一驱动并验证用户视角行为。驱动真实界面可使用已配置的浏览器工具或 Playwright，HTTP 接口需注意脱敏且不记录认证 query token。

## 5. Evidence（脱敏证据落盘）

- 证据保存至：`../../scratch/tasks/<yyyy-mm-dd>-<slug>/verify/`（即 `home-repos/scratch/tasks/.../verify/`，脱离 Worktree 生命周期）。
- 建议保存文件：`doctor.txt`、`compat-check.txt`、接口脱敏响应摘要 `api-checks.json`、页面截图 `*.png` 与控制台错误摘录。

## 6. Cleanup（清理规则）

- 删除本次验证在看板中创建的临时测试任务/工单，以及临时新建的测试 Worktree；
- 仅终止本次验证启动且记录了 PID 的后台进程；
- **绝不清理** `home-repos/scratch/tasks/<slug>/verify/` 下的证据文件（由人工验收后随 `clean-scratch.sh` 按 7 天 TTL 自动过期）。
