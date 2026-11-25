# Web 启动与侧栏面板渲染

## Sub-features

- `dsh web` 启动后页面正常加载、无未捕获控制台/运行时异常
- 侧边栏展示已关联的自建插件图标（`dsh-manager`、`skills-manager`、`model-studio`、`system-dashboard`、`immersive-translate`）并支持点击进入与切回会话
- 深色/浅色主题切换时，自建插件遵循 `--dsw-alias-*` token 且无不可读文字或遮挡

## How to get to it (user POV)

启动 `dsh web` 后在浏览器打开服务地址（默认 `http://127.0.0.1:3080/`，需有效会话或本地访问权限），依次点击左侧栏图标并在顶部或设置中切换主题。

## Driving it

1. 通过 Playwright / 浏览器自动化工具打开 `http://127.0.0.1:3080/`。
2. 监听页面 `console.error` 与 `pageerror`。
3. 依次点击侧栏中的 `dsh-manager`（验证 `board`、`team`、`policy`、`briefings`、`settings` 标签页切换）及其他自建插件图标，并截图保存至证据目录。

## Gotchas

- 实测插件 UI 变更前需确认对应 `exports['./client']`（如 `lib/client.js` 或 `client/client.js`）为最新构建产物；若刚执行过构建且页面已打开，`dsh-client-hmr` 约 0.5s 热替换，必要时硬刷新确认。
- 截取或保存 URL/页面信息时不得包含鉴权 `token` 参数。
