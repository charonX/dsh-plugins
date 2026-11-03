# 调试指南

按「UI → API → 宿主」三层定位，比反复点界面快。

## 1. 先看浏览器里的证据

打开 DevTools（`dsh web` 用浏览器打开最好调试；Desktop 用菜单里的 Toggle Developer Tools / `Cmd+Opt+I`）：

- **Network** 过滤 `dsh-skills-manager`：每次操作都会有一条请求。点「关联」没有任何请求 = 请求前就被拦住了（见下）。
- **Console**：关联失败会打印 `[skills-manager] link failed: <CODE> <message>`；同时弹窗里显示同样的红字。
- **Payload**：确认 `project` 是**绝对路径**、`agents` 是 registry key（如 `dsh`、`claude-code`，不是显示名）。

已知的“点了没反应”：

| 现象 | 原因 | 现在/处理 |
|---|---|---|
| 点「关联」无请求、无提示 | 之前项目路径为空时按钮被静默禁用 | 已改为**点击即提示**「请先选择或输入项目目录。」 |
| 请求返回 400 `PROJECT_INVALID` | 路径不存在 / 不是绝对路径 / 位于技能库内 | 选一个已存在的项目目录（工作区下拉可直接选） |
| 请求返回 409 `SKILL_SOURCE_DISABLED` / `SKILL_DISABLED` | 技能或来源被全局停用 | 先启用再关联 |
| 请求返回 400 `AGENT_INVALID` | 宿主老版本没有该 agent key | 用 `GET /api/agents` 返回的 key |
| 请求 403 `UNTRUSTED_REQUEST` | 跨站/代理改写了 Host/Origin | 用同源页面操作；反向代理需声明 `--trusted-host` |
| 请求 200 但“看不到变化” | 「已关联项目」在页面下方且默认收起 | 现在关联成功会自动展开该项目并滚动过去，同时顶部提示「已向 … 写入 N 个链接位置」 |

## 2. 直接打 API 复现

```sh
API=http://127.0.0.1:3099/dsh-skills-manager/api
curl -s "$API/library" | python3 -m json.tool | head -40
curl -s -X POST "$API/links" \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3099' \
  -d '{"project":"/absolute/project","source":"owner-repo","agents":["dsh","claude-code"]}' \
  | python3 -m json.tool
```

返回体里的 `counts` 和 `project.targets[].state` 能直接说明每个 agent 目录的结果（`linked` / `missing` / `broken` / `conflict` / `external`）。想看现有记录：`curl -s "$API/links"`。

## 3. 一条命令重放整个 UI 流程

仓库自带 Playwright 调试脚本（不是依赖，按需安装）：

```sh
npm i -D playwright && npx playwright install chromium
node scripts/debug-ui.mjs "http://127.0.0.1:3099/?token=…" /absolute/project --agents "Claude Code,AdaL"
node scripts/debug-ui.mjs "http://127.0.0.1:3099/?token=…" --empty-project
```

它会：打开 Skills 页 → 展开来源 → 打开关联弹窗 → 填写项目 → 勾选 agent → 提交，并打印**每一条请求/响应、console 警告、弹窗内错误、提交的 JSON**，最后保存 `debug-ui.png`。适合把“点了没反应”变成可复现的证据。

## 4. 宿主日志

- 插件告警会带 `skills-manager:` 前缀（无效 SKILL.md、软链冲突、不可读的状态文件等），位置在 `~/.dsh/logs/startup-*.log`。
- 4xx 是契约内拒绝（不写日志），5xx 会记录堆栈；路由层未捕获异常统一返回 `INTERNAL_ERROR`。

## 5. 回归验证

```sh
pnpm verify:local    # 宿主 + API + 软链 + bundle（8 项）
pnpm verify:profile  # 真实 profile 安装路径（9 项）
```

两者都不依赖浏览器，能先排除后端问题；剩下的再按第 1、3 步看 UI。
