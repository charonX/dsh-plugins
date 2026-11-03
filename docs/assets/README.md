# 截图清单 / Screenshot checklist

README.md（英文）和 README.zh.md（中文）引用下面 5 张图。截好后放进本目录，文件名保持一致即可。

| 文件 | 对应 README 区块 | 必需 |
|---|---|---|
| `skills-page.png` | 顶部主图 | 是 |
| `link-projects.png` | Screenshots → Link to multiple projects（待补拍，见文末） | 是 |
| `linked-projects.png` | Screenshots → Per-project state | 是 |
| `scan-import.png` | Screenshots → Import what other agents installed | 是 |

## 通用要求 / General

- 浅色主题、100% 缩放、窗口宽度尽量一致（建议 1600–2000 px 宽，PNG）。
- 语言用中文或英文都行（两版 README 共用同一组图）；界面右上角的 token 不要出现在截图里。
- 用演示数据，避免真实私人路径 / 会话名：例如项目路径 `/Users/demo/code/my-app`，来源 `demo-skills`。
- 只保留相关区域，不要整屏桌面；必要时裁掉浏览器地址栏。
- 单张控制在 ~500 KB 内（可用 `sips -Z 1600 xxx.png` 压缩尺寸）。

## 1. `skills-page.png` — 技能主页

- 左栏可见 **插件 / 自动化任务 / 技能**，且「技能」处于选中态。
- 页面头部：标题、`N 个来源 · M 个技能`、副标题。
- 工具栏可见：搜索、刷新、全部展开、全部收起、扫描已安装技能、+ 添加技能来源。
- **一个展开的来源**（显示版本、来源地址、3–5 个技能行：名称、描述、关联按钮、开关）。
- **一个收起的来源**（显示技能数摘要）。
- 可以顺带露出顶部「已添加 …。」的成功提示。

## 2. `link-projects.png` — 一次关联多个项目

- 「关联到项目」弹窗。
- 项目下拉展开（或多选后的 chips 可见），至少选中 **两个项目**。
- agent 列表里勾选 **DeepSeek Harness + Claude Code + Codex**（露出 `universal` 之类的标记更好）。
- 底部可见「关联 / 取消」。

## 3. `linked-projects.png` — 已关联项目的条目行

- 「已关联项目」区块展开，至少 **两个项目**。
- 每个项目下 2–3 个条目：`source/skill` + 项目开关 + 状态，状态形如 **`已关联 dsh · claude-code`**。
- 项目头部可见状态计数、`重新同步`、`全部取消`。
- 项目路径用演示路径（或打码）。

## 4. `scan-import.png` — 扫描与导入

- 「扫描已安装技能」弹窗。
- 按来源分组：至少一组里有技能（例如 Codex 1 个），另有几组显示 `0 个技能 / 不存在`。
- 顶部可见搜索、`已选 N 个`、「覆盖此前由本插件导入的同名副本」、`扫描目录 2/8 个存在`。
- 底部可见「导入所选」。
- 如果方便，让其中一行显示「同名冲突」更有说明力（非必需）。

## 待补拍：`link-projects.png`

当前这张只打开了项目下拉、没有勾选项目，agent 列表也滚到了 Antigravity/AstrBot，展示不出「多选」和「已选 agent」。补拍时请：

- 勾选 **≥2 个项目**（chips 可见）；
- agent 列表滚到顶部，勾选 **DeepSeek Harness + Claude Code + Codex**；
- 若不想暴露真实路径，可先把项目路径换成 `/Users/demo/...`，或告诉我需要打码的区域。
