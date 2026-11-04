# dsh-media-station 设计方案

面向 DeepSeek Harness（下称 dsh）的 **自媒体创作工作台插件（Media Station）**：将 `/Users/zhanglei/charon/code/workspace/workstation`（OPC Workstation）中成熟验证的自媒体全流程能力（信源采集、文章排重、AIHOT 热点挖掘与双打分、自媒体切入视角提炼、知识库规范脚手架、一键立项草稿与大盘指标）重构为 dsh 原生的 bundle（Host 半 + Web Client 半 + Agent 工具集）。

---

## 1. 目标与非目标

### 1.1 核心目标

1. **自媒体内容知识库规范脚手架（Scaffold）**：
   - 为当前工作区一键初始化标准知识库目录结构：`00_Inbox/topics/`（每日精选与台账）、`10_Raw/`（原始素材）、`20_Wiki/`（知识库）、`30_Outputs/drafts/`（草稿箱）、`99_System/prompts/`（Prompt 提示词）。
   - 自动内置并维护 `99_System/prompts/media-style.md` 自媒体行文规范指南（黄金 3 秒 Hook、读者收益第一、一屏一焦点排版节奏）。
2. **多源信源管理与排重采集（Sources & Fingerprinting）**：
   - 支持 RSS / Atom 订阅管理、OPML 导入/导出、预设信源一键加载与连通性检测。
   - 内置基于 SHA-256 URL 哈希的文章指纹秒级排重库（`media_fingerprints`），杜绝重复抓取与资讯过载。
   - 支持正文残缺时的二段深度抓取与补全（优先 Crawl4AI / Firecrawl，未配置时保底 Jina Reader）。
3. **AIHOT 智能评估引擎（Scoring & Clustering）**：
   - 双独立打分维度：**爆款潜力分（virality 0~100）** 与 **专业深度分（depth 0~100）**，加权计算 **综合热度分（heat_score）**。
   - 跨多信源事件聚类（Clustering）：将同一事件的多篇资讯智能合并，汇总全部参考来源。
   - 强中文硬约束：无论原始资讯是何种语种，聚类提炼输出的标题、核心摘要与切入视角必须为地道流畅简体中文。
   - 启发式规则保底：当 LLM 不可用或超载时自动优雅降级，并对外显式标记 `degraded: true`，绝不静默装成功。
4. **自媒体切入视角提炼（Hooks & Angles）**：
   - 为每个热点选题自动提炼 2~3 个犀利的自媒体写作切入角度（如痛点共鸣、反差揭秘、实操避坑、商业思考、架构解构）。
   - 支持异步深度提炼任务（Task ID 追踪、可查进度与终态、断点续跑）。
5. **一键立项写作与草稿生成（Drafting & Lifecycle）**：
   - 选题完整生命周期状态机：`candidate`（候选） ➔ `planned`（已规划） ➔ `drafted`（已立项） ➔ `published`（已发布） / `archived`（已归档）。
   - 一键生成标准化 YAML Frontmatter 草稿 Markdown 文件并定位到草稿目录，无缝联动 Agent 协同写作。
6. **自媒体专属 Agent 工具集（DSH Agent Tools）**：
   - 按照 DSH Tools DSL 注册模型可见工具（`media_init_scaffold`、`media_list_topics`、`media_create_draft`、`media_refine_topic`、`media_ingest_articles`）。
   - 支持 PTC 模式（Programmatic Tool Calling）调用，支持专用 UI Card 渲染（Diff 卡片 / 预览卡片）。
7. **可视化工作台界面（Web Client UI）**：
   - 注册左侧主导航图标（`sidebar.panellist`，order=30）与独立主页面（`main` 槽位，key=`media-station`）。
   - 包含两大视图：
     - **选题看板（Topics Board）**：信息流视图（Stream）与大盘统计视图（Dashboard），支持热度排序、分类过滤、Hooks 抽屉与一键立项。
     - **信源抽屉（Sources Drawer）**：信源启停、批量导入、抓取测试。
   - 采用 DSH 原生 Design Tokens（`--dsw-alias-*`）与多语言体系（`zh`/`en`）。

### 1.2 非目标（Out of Scope）

- **不替代第三方社交媒体发布平台**：不直接调用微信公众号、知乎、小红书等平台私有发文接口（发文与分发由后续发布扩展或外部自动化流承接）。
- **不重造工作流引擎**：本插件不内置完整 DAG 可视化编排画布（React Flow），而是提供标准 Webhook 接口与 N8N 工作流模版，由 N8N 或 DSH 内置定时调度器承担流水线触发。

---

## 2. Workstation 能力 ➔ DSH 能力映射

| Workstation 模块 | 原始实现（workstation） | DSH 插件落点（dsh-media-station） |
|---|---|---|
| **自媒体目录脚手架** | `src/services/scaffoldService.js` | `src/host/scaffold.ts` + 工具 `media_init_scaffold` |
| **行文规范指南** | `DEFAULT_MEDIA_STYLE_PROMPT` | 模板嵌入 `src/host/prompts/media-style.md`，脚手架初始化时写入 |
| **选题存储与排重** | `src/db.js` (`project_topics`, `topic_crawl_fingerprints`) | `src/host/db.ts`（使用 Node 24 原生 `node:sqlite`，数据保存在 `$DSH_HOME/media-station/media.db`） |
| **AIHOT 打分与聚类** | `src/services/topicService.js` (`evaluateAndClusterArticlesAIHOT`) | `src/host/aihot.ts`（利用 DSH LLM 调用/档位路由 + 启发式兜底算法） |
| **自媒体切入视角提炼** | `src/services/topicRefine.js` | `src/host/refine.ts` + 异步任务队列 `TaskRegistry` |
| **信源管理与抓取** | `src/services/contentSourceService.js`, `feedFetcherService.js`, `crawlService.js` | `src/host/sources.ts`, `src/host/fetcher.ts`, `src/host/crawler.ts` |
| **草稿一键生成** | `createDraftFromTopic()` | `src/host/draft.ts` + 工具 `media_create_draft` |
| **外部流水线对接** | `renderMediaTopicWorkflowTemplate()`, `deployMediaTopicFlow()` | `src/host/integrations/n8n.ts` + Webhook 端点 `/api/topics/ingest` |
| **HTTP API 路由** | `src/http/routes/projects.js` | `src/host/http.ts` 注册在 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-media-station', handler })` |
| **Web 页面** | `src/renderer/pages/TopicsBoard.jsx`, `Sources.jsx` | `src/client/MediaStationPage.tsx`, `TopicsBoard.tsx`, `SourcesDrawer.tsx` |
| **UI 导航入口** | 内部 React Router 路由 | 注册到 `slots.inject('sidebar.panellist')` 与 `slots.inject('main')` |
| **设计系统与主题** | `TopicsBoard.css` 等组件样式 | 严格使用 DSH 宿主 CSS 变量（`--dsw-alias-*`），不写死颜色，深浅色自适应 |
| **Agent 工具** | 未统一接入 Agent Tools DSL | 注册 5 个 `@deepseek-ai/dsh-tools` 类型化工具 |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Web Client (Browser)                                    │
│  ┌─────────────────────────────┐   ┌──────────────────────────────────────────────────┐ │
│  │ sidebar.panellist           │   │ main ("media-station")                           │ │
│  │ (自媒体创作中心图标)        │   │  ├─ 顶部大盘指标条 (7天事件数 / 今日热度 / 转化率)│ │
│  └──────────────┬──────────────┘   │  ├─ 选题看板 (Stream 流式视图 / Dashboard 卡片)  │ │
│                 │ 激活激活          │  │   ├─ 热度/分类过滤 + 搜索                    │ │
│                 ▼                  │   ├─ 自媒体切入视角 (Hooks) 展开卡片             │ │
│  ┌─────────────────────────────┐   │   └─ 一键立项写作 (创建草稿 Markdown)            │ │
│  │ ctx.locale: 'media-station' │   │  ├─ 信源抽屉 (Sources Drawer: RSS / OPML 导入)   │ │
│  │ (中/英文字典切换)           │   │  └─ N8N 自动化采集流水线配置弹窗                 │ │
│  └─────────────────────────────┘   └─────────────────────────┬────────────────────────┘ │
└──────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                               │ 同源 HTTP / Webhook
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               Host Plugin (Node.js / Cordis)                            │
│                                                                                         │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ HTTP Router (Prefix: /dsh-media-station)                                          │  │
│  │  ├─ GET  /api/topics (大盘/今日精选/历史流)                                       │  │
│  │  ├─ POST /api/topics/ingest (外部 N8N / 采集脚本 Webhook 摄取)                    │  │
│  │  ├─ POST /api/topics/refine (启动深度提炼任务)                                    │  │
│  │  ├─ POST /api/topics/:id/draft (一键立项草稿)                                     │  │
│  │  ├─ GET/POST/PUT/DELETE /api/sources (信源 CRUD 与健康检查)                       │  │
│  │  └─ GET  /api/metrics (大盘指标统计)                                              │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                         │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Agent Tools (ctx.tools.register)                                                  │  │
│  │  ├─ media_init_scaffold   : 工作区知识库脚手架与行文指南初始化                    │  │
│  │  ├─ media_list_topics     : 查询近期自媒体高热选题与 Hooks                        │  │
│  │  ├─ media_create_draft    : 将选题立项并生成草稿 Markdown 文件                    │  │
│  │  ├─ media_refine_topic    : 对单条资讯深度挖掘自媒体切入角度                      │  │
│  │  └─ media_ingest_articles : 批量导入资讯并执行 AIHOT 打分与聚类                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                         │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────────────────┐  │
│  │ AIHOT Engine         │  │ Crawl & Enrich       │  │ Scaffold & Draft Engine       │  │
│  │ (双打分 + 聚类 + 降级)│  │ (RSS 解析 + 二段补全)│  │ (00_Inbox ~ 99_System 规范落盘)│ │
│  └──────────┬───────────┘  └──────────┬───────────┘  └───────────────┬───────────────┘  │
│             │                         │                              │                  │
│             ▼                         ▼                              ▼                  │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 本地存储层                                                                        │  │
│  │  ├─ SQLite ($DSH_HOME/media-station/media.db) : 选题元数据、指纹排重、信源配置    │  │
│  │  └─ 工作区文件系统 (<workspace>/) : 00_Inbox/topics/ 存档、30_Outputs/ 草稿文件    │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 数据模型与存储架构

### 4.1 混合存储哲学（Hybrid Storage）

遵循 **Local-First（本地优先）与纯文本知识管理** 理念：
- **高频检索、排重与指标统计**：由 SQLite 数据库承载，确保毫秒级指纹去重与多维聚合统计。
- **创作正文、大纲与历史归档**：以结构化 Markdown 和 JSONL 文件落盘于当前活动工作区，用户在 Obsidian、VS Code 或 DSH 编辑器中可直接阅读、检索和 Git 版本管理。

### 4.2 SQLite 数据库架构（Node 24 原生 `node:sqlite`）

数据库文件位于 `$DSH_HOME/media-station/media.db`，由 Node 24 原生 `DatabaseSync` 驱动，零外部编译依赖：

```sql
-- 1. 自媒体选题表
CREATE TABLE IF NOT EXISTS media_topics (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,       -- 绑定的工作区绝对路径
  batch_date TEXT NOT NULL,           -- 批次日期 YYYY-MM-DD
  title TEXT NOT NULL,                -- 提炼后的中文标题
  summary TEXT NOT NULL,              -- 核心事实与影响摘要
  heat_score INTEGER NOT NULL,        -- 综合热度分 0~100
  virality_score INTEGER,             -- 爆款潜力分 0~100
  depth_score INTEGER,                -- 专业深度分 0~100
  category TEXT DEFAULT 'tech',       -- 分类：tech | ai | indie | tools | business
  angles_json TEXT NOT NULL DEFAULT '[]',     -- 切入视角数组 (Hooks)
  references_json TEXT NOT NULL DEFAULT '[]', -- 参考来源对象数组 [{ title, url, source, pubDate }]
  status TEXT NOT NULL DEFAULT 'candidate',   -- 状态：candidate | planned | drafted | published | archived
  draft_path TEXT,                    -- 关联的草稿文件相对路径 (30_Outputs/drafts/...)
  refine_status TEXT DEFAULT 'pending',       -- 提炼状态：pending | running | done | failed
  refined_at INTEGER,                 -- 提炼完成时间戳
  created_at INTEGER NOT NULL,        -- 创建时间戳
  updated_at INTEGER NOT NULL         -- 更新时间戳
);
CREATE INDEX IF NOT EXISTS idx_media_topics_ws_date ON media_topics(workspace_path, batch_date);
CREATE INDEX IF NOT EXISTS idx_media_topics_heat ON media_topics(workspace_path, heat_score DESC);

-- 2. 抓取文章指纹去重表（毫秒级精准排重）
CREATE TABLE IF NOT EXISTS media_fingerprints (
  url_hash TEXT PRIMARY KEY,          -- SHA-256(cleanUrl).slice(0, 32)
  workspace_path TEXT NOT NULL,       -- 工作区标识
  url TEXT NOT NULL,                  -- 清洗后的规范 URL (剔除 utm 等跟踪参数)
  title TEXT NOT NULL,                -- 原始标题
  source_name TEXT,                   -- 信源名称
  published_at TEXT,                  -- 原始发文时间
  created_at INTEGER NOT NULL         -- 记录时间戳
);
CREATE INDEX IF NOT EXISTS idx_media_fp_ws ON media_fingerprints(workspace_path);

-- 3. 内容信源表
CREATE TABLE IF NOT EXISTS media_sources (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,                -- 为空表示全局信源，非空表示工作区私有信源
  name TEXT NOT NULL,                 -- 信源名称
  type TEXT NOT NULL DEFAULT 'rss',   -- 类型：rss | atom | site
  feed_url TEXT NOT NULL,             -- RSS Feed 链接
  category TEXT DEFAULT 'tech',       -- 默认分类
  tags_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1, -- 是否启用 (1=是, 0=否)
  last_fetched_at INTEGER,            -- 上次抓取时间
  last_status TEXT,                   -- ok | error
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- 4. 绑定的自动化流水线配置 (如 N8N 集成)
CREATE TABLE IF NOT EXISTS media_pipelines (
  workspace_path TEXT PRIMARY KEY,
  pipeline_type TEXT NOT NULL,        -- n8n | cron | custom
  workflow_id TEXT,
  workflow_name TEXT,
  editor_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  deployed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 4.3 工作区文件系统规范目录（Knowledge Scaffold）

执行脚手架初始化后，在用户工作区根目录下创建：

```
<workspace>/
├── 00_Inbox/
│   └── topics/
│       ├── YYYY-MM-DD.md             # 每日精选选题存档 Markdown
│       └── .seen_history.jsonl       # 文章指纹历史台账
├── 10_Raw/                           # 原始参考素材、PDF、抓取快照
├── 20_Wiki/                          # 创作者沉淀的专业概念与背景知识
├── 30_Outputs/
│   └── drafts/                       # 立项生成的文章草稿
│       └── YYYY-MM-DD-<slug>.md      # 结构化 Frontmatter 草稿文件
└── 99_System/
    └── prompts/
        └── media-style.md            # 自媒体行文规范指南
```

### 4.4 `media-style.md` 行文规范契约

内置的规范指南由提示词工程提炼而成，核心约束包括：
- **黄金 3 秒 Hook 与痛点开篇**：前 3 行决定留存，第一句话直击读者核心痛点、认知偏差或制造悬念；拒绝冗长前戏。
- **自媒体切入视角（Angles）**：争议点/博弈面、降维解读、落地启示。
- **排版段落与阅读节奏**：手机阅读环境下，一屏一焦点，段落控制在 2~3 行内；关键结论金句单独成段；善用 Bullet Points 清单。

---

## 5. AIHOT 智能评估引擎与算法

### 5.1 双独立打分与综合热度计算

AIHOT（AI Hotspot & Opportunity Tracker）引擎从两个独立正交的维度量化候选资讯：

1. **爆款潜力分（virality, 0~100）**：
   - 衡量资讯在大众社群与朋友圈层中的传播势能。
   - 关注：大众好奇心、认知反差、利益关联、商业争议、行业洗牌、知名人物/大厂动向。
2. **专业深度分（depth, 0~100）**：
   - 衡量资讯在行业从业者与工程师眼中的技术价值与干货厚度。
   - 关注：硬核技术原理、架构演进、开源源码、实操避坑、性能评测基准。
3. **综合热度公式**：
   $$\text{heat\_score} = \text{round}(0.6 \times \text{virality} + 0.4 \times \text{depth})$$
   - 爆款权重占 60%，深度权重占 40%，确保筛选出的选题既有阅读点击率，又具备扎实的内容厚度。

### 5.2 轻量增量更新探针与空转熔断（Update Check & Short-Circuit）

为了支持高频调度（如每小时轮询一次）而**不浪费 Token、不产生无意义的空会话**，系统设计了轻量增量更新探针：

1. **毫秒级零 Token 探针（Probe）**：
   - 抓取各信源的最新 Feed，提取 URL 列表并规范化（去除追踪参数）。
   - 批量比对 SQLite `media_fingerprints` 表中的 URL SHA-256 哈希。
   - 快速计算新增文章数：`newArticles = candidates.filter(!seen)`。
2. **空转熔断守卫（Short-Circuit Guard）**：
   - 若 `newArticles.length === 0`：探针直接写入心跳日志并安全退出，**不唤醒大模型、不创建 Agent 会话、Token 消耗为 0**。
   - 若 `newArticles.length > 0`：将新文章摄取入库，并唤醒 Agent 启动采编研读会话。

### 5.3 跨信源事件聚类（Clustering）

- 抓取阶段通过标题词袋与关键实体匹配，将来自不同媒体（如 36氪、InfoQ、GitHub Trending、HackerNews）关于同一事件的报道聚合成同一个 Topic 事件。
- 聚类后的 Topic 汇总所有来源至 `references` 列表中，标明来源渠道与原报道链接。

### 5.4 强中文硬约束与输出 Schema

```json
{
  "type": "object",
  "properties": {
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "吸引眼球但拒绝低俗党标题的中文标题" },
          "summary": { "type": "string", "description": "100~300 字核心事实与影响深度解读（地道简体中文）" },
          "virality_score": { "type": "number", "minimum": 0, "maximum": 100 },
          "depth_score": { "type": "number", "minimum": 0, "maximum": 100 },
          "heat_score": { "type": "number", "minimum": 0, "maximum": 100 },
          "category": { "type": "string", "enum": ["tech", "ai", "indie", "tools", "business"] },
          "angles": {
            "type": "array",
            "items": { "type": "string" },
            "description": "2~3 个自媒体切入角度（如痛点争议、实操避坑、商业思考）"
          },
          "references": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "title": { "type": "string" },
                "url": { "type": "string" },
                "source": { "type": "string" },
                "pubDate": { "type": "string" }
              },
              "required": ["url"]
            }
          }
        },
        "required": ["title", "summary", "heat_score", "angles"]
      }
    }
  },
  "required": ["events"]
}
```

### 5.4 启发式降级保底机制（Heuristic Fallback）

当网络中断、模型无响应或未配置 API Key 时：
1. 关键词矩阵扫描（爆款词汇池：`重磅`、`开源`、`突破`、`颠覆`、`正式推出`、`DeepSeek`、`Agent`...；深度词汇池：`架构`、`底层`、`源码`、`微调`、`推理`、`吞吐`...）。
2. 计算基础 virality 与 depth 分值。
3. 聚类相近标题词。
4. 返回保底事件列表，并**显式返回 `degraded: true`**，看板上显示“启发式规则保底”提示，保障系统永远不宕机。

---

## 6. Agent 专属工具集（DSH Agent Tools）

在 `apply(ctx)` 中通过 `ctx.tools.register(defineTool({ ... }))` 注册 7 个原生工具，使模型可以在与用户的对话中直接调动自媒体工作台的所有能力：

### 6.1 `media_init_scaffold`
- **说明**：在当前工作区初始化自媒体规范目录（`00_Inbox` ~ `99_System`）及行文规范指南 `media-style.md`。
- **参数**：
  - `workspacePath`（可选 string，默认当前工作区）
  - `force`（可选 boolean，是否覆盖已存在的规范指南）
- **输出**：`{ created: string[], existed: string[], scaffoldReady: boolean }`
- **UI Card**：`generic` 或 `diff` 卡片。

### 6.2 `media_check_updates`
- **说明**：轻量级毫秒级增量更新检测探针。快速轮询信源 URL，比对指纹库，判断是否有新资讯发布，用于高频调度（如每小时）时的空转熔断。
- **参数**：
  - `sourceIds`（可选 string[]，指定检测的信源 ID 列表，默认全部已启用信源）
- **输出**：`{ hasNew: boolean, newCount: number, candidatesCount: number }`

### 6.3 `media_summarize_article`
- **说明**：Agent 级单篇文章深度研读与四维总结（去伪存真、读者收益、争议博弈面、黄金 3 秒 Hook）。支持通过 URL 二段抓取全文或直接传入正文。
- **参数**：
  - `title`（必填 string，资讯标题）
  - `url`（可选 string，目标网页地址）
  - `content`（可选 string，已有正文材料）
  - `customStylePrompt`（可选 string，用户覆盖的特定风格提示词）
- **输出**：`{ summary: string, readersBenefit: string, controversy: string, hooks: string[], heatScore: number }`

### 6.4 `media_list_topics`
- **说明**：查询自媒体选题。支持今日精选、本周 Top 榜单、特定日期或关键词搜索。
- **参数**：
  - `scope`（可选 string，枚举：`today_top` | `week_top` | `all`，默认 `today_top`）
  - `batchDate`（可选 string，格式 YYYY-MM-DD）
  - `category`（可选 string，分类过滤）
  - `limit`（可选 number，最多返回条数，默认 10）
- **输出**：`{ topics: TopicView[], total: number }`

### 6.5 `media_create_draft`
- **说明**：将指定的选题一键立项，在 `30_Outputs/drafts/` 下生成标准化草稿 Markdown 文件，并更新选题状态为 `drafted`。
- **参数**：
  - `topicId`（必填 string，选题唯一 ID）
  - `customTitle`（可选 string，自拟文章标题）
  - `selectedAngle`（可选 string，创作者选中的主要切入视角）
- **输出**：`{ draftPath: string, alreadyExisted: boolean, fullPath: string }`
- **UI Card**：`diff` 卡片（显示新建草稿文件的内容与路径）。

### 6.6 `media_refine_topic`
- **说明**：对单条资讯标题、摘要或外部文章 URL 进行 AIHOT 深度提炼，挖掘自媒体切入角度与金句。
- **参数**：
  - `title`（必填 string，资讯标题）
  - `url`（可选 string，资讯链接，提供时将尝试二段抓取正文）
  - `content`（可选 string，已有正文材料）
- **输出**：`{ summary: string, heat_score: number, angles: string[], references: any[] }`

### 6.7 `media_ingest_articles`
- **说明**：批量摄取候选资讯，执行排重、二段抓取、AIHOT 打分与聚类，并将新生成的选题保存入库和写入离线 Markdown 归档。
- **参数**：
  - `articles`（必填 array，每项含 title、url、snippet、sourceName、pubDate）
  - `batchDate`（可选 string，批次日期）
- **输出**：`{ totalReceived: number, dedupSkipped: number, eventsCreated: number, degraded: boolean, topics: TopicView[] }`

### 6.8 `media_add_source`
- **说明**：Agent 级智能信源录入与自动分类工具。用户只需提供一个博客/媒体首页网址或 RSS 地址，由系统自动探测 Feed 端点、抓取样例文章、分析内容主题，并由 Agent 自动推断最精准的分类（category）与语义标签（tags）。
- **参数**：
  - `url`（必填 string，网站网址或 RSS/Atom 链接）
  - `name`（可选 string，信源名称；未提供时自动抓取网站 `<title>`）
  - `category`（可选 string，显式指定分类；未提供时由 Agent 根据近 5 篇样文自动分类）
  - `tags`（可选 string[]，显式标签；未提供时由 Agent 自动提炼标签）
  - `autoDiscover`（可选 boolean，是否自动探测 HTML 中的 `<link rel="alternate">`，默认 true）
- **输出**：`{ id: string, name: string, feedUrl: string, category: string, tags: string[], autoCategorized: boolean, sampleArticlesCount: number }`

### 6.9 `media_list_sources`
- **说明**：查询当前工作区或系统已配置的信源列表、健康状态、所属分类与最近抓取时间。
- **参数**：
  - `category`（可选 string，分类筛选）
  - `enabledOnly`（可选 boolean，是否仅看启用的信源）
- **输出**：`{ sources: ContentSource[], total: number }`

### 6.10 `media_update_source`
- **说明**：更新信源的分类、标签、名称或启停状态。支持 Agent 批量审阅现有信源并修正分类。
- **参数**：
  - `id`（必填 string，信源唯一 ID）
  - `category`（可选 string，新分类）
  - `tags`（可选 string[]，新标签列表）
  - `enabled`（可选 boolean，是否启用）
  - `name`（可选 string，重命名）
- **输出**：`{ ok: true, source: ContentSource }`

---

## 7. HTTP RESTful API 契约

前缀由插件配置决定，默认：`/dsh-media-station`。

### 7.1 安全防护纪律
- **防 DNS Rebinding / CSRF**：写操作校验 `Host` 与 `Origin`，拒绝跨站请求（对齐 dsh 核心安全栅栏）。
- **路径遍历防护**：所有目录拼装严格经由 `path.resolve` 与工作区边界白名单检查。
- **请求体积控制**：Ingest 与 Refine 请求体上限 200 KiB，拒绝超大 HTML 注入。

### 7.2 端点清单

| Method | Path | 功能描述 | 请求载荷 / 参数 | 响应结果 |
|---|---|---|---|---|
| **GET** | `/api/topics` | 获取选题列表 | `?scope=today_top\|week_top&batchDate=YYYY-MM-DD&category=tech` | `{ ok: true, topics: TopicView[] }` |
| **GET** | `/api/topics/:id` | 获取单条选题详情 | - | `{ ok: true, topic: TopicView }` |
| **POST** | `/api/topics/ingest` | 外部文章摄取 Webhook（支持 N8N） | `{ articles: RawArticle[], batchDate?: string }` | `{ ok: true, totalReceived, dedupSkipped, eventsCreated, topics }` |
| **POST** | `/api/topics/refine` | 触发异步深度提炼任务 | `{ batchDate?: string, limit?: number }` | 202 `{ ok: true, taskId: string }` |
| **GET** | `/api/topics/refine/:taskId`| 轮询提炼任务状态与进度 | - | `{ taskId, status, progress, error, doneCount }` |
| **POST** | `/api/topics/:id/draft` | 一键立项生成草稿 | `{ customTitle?, angle? }` | `{ ok: true, draftPath: string, alreadyExisted: boolean }` |
| **PUT** | `/api/topics/:id/status` | 更新选题状态 | `{ status: 'candidate'\|'planned'\|'published'\|'archived' }` | `{ ok: true, id, status }` |
| **GET** | `/api/metrics` | 获取大盘统计指标 | - | `{ ok: true, totalEvents7d, todayTopHeat, draftedCount7d, conversionRate, categoryBreakdown }` |
| **GET** | `/api/sources` | 列出配置的所有信源 | - | `{ ok: true, sources: ContentSource[] }` |
| **POST** | `/api/sources` | 新增信源 | `{ name, type, feedUrl, category, tags }` | `{ ok: true, source: ContentSource }` |
| **PUT** | `/api/sources/:id` | 修改信源（启停/参数） | `{ enabled?, feedUrl?, category?, tags? }` | `{ ok: true, source: ContentSource }` |
| **DELETE**| `/api/sources/:id` | 删除信源 | - | `{ ok: true, removed: string }` |
| **POST** | `/api/sources/import-opml`| 导入 OPML 订阅列表 | `{ opmlContent: string }` | `{ ok: true, importedCount: number }` |
| **POST** | `/api/sources/test` | 测试信源连通性与抓取 | `{ feedUrl: string }` | `{ ok: true, title, itemsCount, sampleItems }` |
| **GET** | `/api/pipeline` | 获取流水线配置与 N8N 模版 | - | `{ ok: true, pipeline: PipelineConfig, template: object }` |

---

## 8. Web Client 用户体验与界面设计

### 8.1 槽位与导航挂载

- **侧边栏图标（`sidebar.panellist`）**：
  - `id`: `'media-station'`
  - `order`: `30`（排在 Plugins 与 Skills 之后）
  - 图标：极客风微光 SVG 新闻/笔尖图标（拒绝低质 Emoji）
  - 文案：通过 `t('panel')` 动态返回 `自媒体工作台` / `Media Station`。
- **主区域注册（`main`）**：
  - `key`: `'media-station'`
  - 挂载全屏工作台组件 `MediaStationPage`。

### 8.2 核心界面布局

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [媒体图标] 自媒体选题与创作工作台                           [信源管理] [部署流水线] [刷新]│
├──────────────────────────────────────────────────────────────────────────────────┤
│ 📊 大盘指标条:                                                                   │
│   [7天追踪热点: 86 条]   [今日最高热度: 96🔥]   [已立项草稿: 6 篇]   [立项转化率: 7.0%]   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 选项卡: [🔥 选题看板 (Topics Board)]   [📈 趋势洞察 (Dashboard)]   [📜 抓取历史 (History)] │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ 🔍 搜索选题...        分类: [全部 | 科技突破 | AI探索 | 独立开发 | 效率工具]  排序: [热度]│
├──────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ 🔥 96分 · 技术突破                                               2小时前 · InfoQ│ │
│ │ DeepSeek 开源第二代 MoE 架构推理方案：显存开销锐减 45%                       │ │
│ │ 摘要: 针对消费级单卡与分布式场景优化内存复用，在基准跑分持平下大幅降低显存开销...  │ │
│ │                                                                              │ │
│ │ 💡 自媒体创作者切入视角 (3 个 Hook 钩子):                                     │ │
│ │  ├─ [痛点共鸣] 大厂都在卷万卡闭源，为什么开源在拼命降低独立开发者的门槛？      │ │
│ │  ├─ [实操避坑] 拿单张 4090 实测新架构部署：显存占用量化对比与吞吐真相          │ │
│ │  └─ [商业思考] 私有化模型成本跌破心理预期，本地优先型 AI 工具将迎来大爆发      │ │
│ │                                                                              │ │
│ │ 🔗 参考来源: [36氪] [InfoQ] [HackerNews]                                     │ │
│ │                                                                              │ │
│ │ [立项状态: 候选]                                     [🤖 唤起 Agent 深度提炼]  │ │
│ │                                                      [📝 一键立项生成草稿]     │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 8.3 视觉质感与设计规范
- 严格继承宿主设计规范，只消费 DSH 官方 Design Tokens（`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-elevation-*`），不写死颜色：
  - 大屏/底层容器：`var(--dsw-alias-bg-layer-1)`；卡片/表单：`var(--dsw-alias-bg-layer-2)`；悬浮层：`var(--dsw-alias-bg-layer-3)`
  - 文本：`var(--dsw-alias-label-primary)` / `--dsw-alias-label-secondary` / `--dsw-alias-label-tertiary`
  - 边框：`var(--dsw-alias-border-l1)` ~ `var(--dsw-alias-border-l4)`
  - 品牌与状态：`var(--dsw-alias-brand-primary)`、`var(--dsw-alias-state-success-primary)`、`var(--dsw-alias-state-warn-primary)`、`var(--dsw-alias-state-error-primary)`
  - 圆角与投影：`var(--dsw-radius-sm|md|lg)`、`var(--dsw-elevation-panel)`、`var(--dsw-elevation-overlay)`
  - 数据/评分/哈希使用等宽字体栈（`ui-monospace, SFMono-Regular, monospace`）。
- 深色与浅色模式随宿主切换，不自建独立色板。
- 无任何第三方大型 UI 库捆绑，零体积包袱。

---

## 9. 插件配置与自动化调度体系

### 9.1 Schemastery Schema 声明

```ts
import { Schema } from '@deepseek-ai/schemastery'

export interface MediaStationConfig {
  /** 数据库存放路径，默认 $DSH_HOME/media-station/media.db */
  dbPath?: string
  /** HTTP 路由前缀，默认 /dsh-media-station */
  routePrefix?: string
  /** 快速模型路由配置 */
  fastModel?: {
    provider?: string
    model?: string
  }
  /** 二段正文抓取引擎优先选项：jina | crawl4ai | firecrawl */
  crawlerEngine?: 'crawl4ai' | 'jina' | 'firecrawl'
  /** 自建 Crawl4AI 实例地址 */
  crawl4aiUrl?: string
  /** Jina Reader API Key (可选) */
  jinaApiKey?: string
  /** 默认热度筛选门槛（低于该分数的选题不进入精选流） */
  minHeatThreshold?: number
  /** 是否开启自动排重 */
  enableDedup?: boolean
  /** 自动化调度周期：'hourly' | 'every-2h' | 'daily' | 自定义 Cron 表达式 (如 '0 * * * *') */
  scheduleTiming?: string
  /** 是否启用轻量更新检测熔断 (0 增量时不唤醒 Agent，省 Token) */
  enableShortCircuit?: boolean
  /** 自定义采编 Agent Prompt 模板 */
  customPromptTemplate?: string
}

export const Config: Schema<MediaStationConfig> = Schema.object({
  dbPath: Schema.string().description('媒体工作台 SQLite 存储路径'),
  routePrefix: Schema.string().default('/dsh-media-station').description('Web API 前缀'),
  fastModel: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).description('快速打分与提炼模型'),
  crawlerEngine: Schema.union(['crawl4ai', 'jina', 'firecrawl']).default('jina').description('网页正文抓取服务'),
  crawl4aiUrl: Schema.string().description('自建 Crawl4AI 基础 URL'),
  jinaApiKey: Schema.string().description('Jina Reader API Key'),
  minHeatThreshold: Schema.number().default(60).description('最低精选热度阈值'),
  enableDedup: Schema.boolean().default(true).description('是否启用指纹排重'),
  scheduleTiming: Schema.string().default('hourly').description('自动化调度周期 (如 hourly 或 cron 表达式)'),
  enableShortCircuit: Schema.boolean().default(true).description('启用增量更新熔断保护'),
  customPromptTemplate: Schema.string().description('自定义采编 Agent 指令 Prompt 模板'),
})
```

### 9.2 默认采编 Agent Prompt 模板契约

当自动化调度触发时，若检测到有新增资讯，系统自动将以下 Prompt 模板（经变量插值后）投递给 Agent：

```markdown
你是自媒体采编主理人。系统刚刚检测到 {{NEW_ARTICLES_COUNT}} 篇新资讯入库（批次日期：{{BATCH_DATE}}）。

【执行流程】
1. 调用 media_list_topics 查询新入库的候选文章；
2. 挑选出 3~5 篇最具爆款潜力和技术突破的重点资讯，调用 media_summarize_article 通读全文并生成深度研读卡；
3. 严格遵循 99_System/prompts/media-style.md 的行文风格与黄金 3 秒 Hook 规范；
4. 针对最具价值的 Top 2~3 个选题，调用 media_create_draft 一键立项并生成大纲草稿文件；
5. 在本会话中向创作者输出一份优雅清晰的“采编简报”，附带已立项草稿的文件链接。
```

### 9.2 `cordis.patch.yml`

```yaml
# dsh bundle patch: 注入媒体创作工作台插件
- insert:
    - id: media-station
      name: '@charonx/dsh-media-station'
      config:
        routePrefix: '/dsh-media-station'
        crawlerEngine: 'jina'
        minHeatThreshold: 60
        enableDedup: true
```

---

## 10. 分期实施路线（Phased Implementation Plan）

### 阶段一：核心基础、存储层与 Agent 工具（Phase 1: Core & Tools）
- [x] 完成架构设计方案 `docs/DESIGN.md`。
- [ ] 搭建项目骨架：`package.json`、`tsconfig.*.json`、`cordis.patch.yml`、`src/shared/api.ts`。
- [ ] 实现存储层 `src/host/db.ts`（基于 Node 24 原生 `node:sqlite` 初始化 4 张表）。
- [ ] 实现脚手架服务 `src/host/scaffold.ts` 与内置提示词 `media-style.md`。
- [ ] 实现 AIHOT 打分与聚类引擎 `src/host/aihot.ts`（启发式规则算法保底）。
- [ ] 实现并注册 5 个 `@deepseek-ai/dsh-tools` 原生工具，并在命令行/无头环境下可调通。
- [ ] 编写核心单测（DB CRUD、指纹排重算法、AIHOT 启发式聚类、Scaffold 目录创建）。

### 阶段二：HTTP 服务、信源管理与 Webhook（Phase 2: HTTP & Ingest）
- [ ] 实现信源抓取与 RSS 解析器 `src/host/fetcher.ts`（零依赖 XML 解析）。
- [ ] 实现正文二段补全抓取器 `src/host/crawler.ts`（集成 Jina / Crawl4AI）。
- [ ] 实现 HTTP 前缀路由 `src/host/http.ts`（RESTful 接口 + DNS rebinding 安全校验）。
- [ ] 实现 `/api/topics/ingest` Webhook 摄取端点与 N8N 模版渲染服务。
- [ ] 编写集成测试（HTTP 接口覆盖、Webhook 批量导入测试、OPML 导入测试）。

### 阶段三：Web Client 界面与深度体验（Phase 3: Web UI）
- [ ] 构建 Web Client 构建流水线（`tsdown` 打包为 CommonJS Loader 格式）。
- [ ] 实现国际化多语言字典 `src/client/locales.ts`（中文 + 英文）。
- [ ] 编写 `TopicsBoard.tsx`（选题看板、Stream/Dashboard 双视图、Hooks 折叠卡片、指标总览）。
- [ ] 编写 `SourcesDrawer.tsx`（信源抽屉、启停开关、导入 OPML 弹窗）。
- [ ] 注册到 `slots.inject('sidebar.panellist')` 与 `slots.inject('main')`。
- [ ] 本地联合调试（`pnpm dsh web --patch ...`）与视觉走查。
