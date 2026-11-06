# @charonx/dsh-media-station

> 面向 **DeepSeek Harness (dsh)** 的自媒体创作与选题自动化工作台插件。

将 OPC Workstation（本地既有项目）经过实战检验的自媒体全流程创作能力（信源采集、指纹去重、AIHOT 热点挖掘与双打分、自媒体切入视角提炼、知识库规范脚手架、一键立项草稿与大盘指标）完整解耦重构为 dsh 原生 bundle（Host 服务 + Web Client 看板 + 5 个 Agent 专属工具）。

详细技术架构与分期实施方案见设计文档：[docs/DESIGN.md](docs/DESIGN.md)。

---

## 实现状态

当前仓库是**脚手架阶段**：下列内容已落地，其余为设计目标（见 [docs/DESIGN.md](docs/DESIGN.md)）。

| 已落地 | 说明 |
|---|---|
| `src/index.ts` | Cordis 插件入口（`name` / `inject` / `apply`），按 `webServer` 是否存在渐进挂载 |
| `src/config.ts` | Schemastery 配置声明（路由前缀、评分阈值、抓取引擎、调度时机等） |
| `src/shared/api.ts` | Host / Client 共享的领域类型与两个常量 |
| `cordis.patch.yml` | dsh bundle 声明 |
| `docs/DESIGN.md` | 完整设计与分期方案 |

| 规划中 | 说明 |
|---|---|
| Host 服务 | `src/host/`：存储、脚手架、AIHOT 打分聚类、提炼任务、信源抓取 |
| HTTP 路由 | `GET/POST` 前缀路由与 Webhook |
| Agent 工具 | `media_init_scaffold`、`media_list_topics`、`media_create_draft`、`media_refine_topic`、`media_ingest_articles` |
| Web Client 半 | `src/client/`：槽位注入、看板与信源抽屉、中英文字典 |

`pnpm typecheck` 与 `pnpm test` 可用；`pnpm build` 依赖 Client 入口，因此目前只能跑 `pnpm build:host`。

---

## 核心特性

1. **自媒体知识库规范脚手架（Scaffold）**：
   - 一键初始化标准知识库规范目录：`00_Inbox/topics/`（精选存档与台账）、`10_Raw/`、`20_Wiki/`、`30_Outputs/drafts/`、`99_System/prompts/`。
   - 内置并持续维护 `99_System/prompts/media-style.md` 自媒体行文规范指南（黄金 3 秒 Hook、读者收益第一、一屏一焦点排版节奏）。
2. **多源采集与精准排重（Sources & Fingerprinting）**：
   - 统一管理 RSS / Atom 信源、支持 OPML 批量导入导出与连通性检测。
   - 内置基于 SHA-256 URL 哈希的文章指纹秒级排重库，避免多源重复抓取。
   - 正文缺失时自动使用 Jina Reader / Crawl4AI 进行二段正文补全。
3. **AIHOT 智能评估引擎（Scoring & Clustering）**：
   - 双独立打分维度：**爆款潜力分（virality 0~100）** 与 **专业深度分（depth 0~100）**，加权计算 **综合热度分（heat_score）**。
   - 跨多源事件聚类（Clustering），多篇关联报道自动合并并汇聚全部参考来源。
   - 全中文硬约束：聚类提炼输出的标题、核心摘要与切入视角强制为地道流畅简体中文。
   - 启发式规则保底：模型不可用时自动降级并显式标记 `degraded: true`，保障系统永不断流。
4. **自媒体切入视角提炼（Hooks & Angles）**：
   - 自动提炼 2~3 个自媒体吸睛切入视角（如痛点共鸣、反差揭秘、实操避坑、商业思考、底层架构解构）。
   - 支持异步后台深度提炼任务（Task ID 追踪与状态查询）。
5. **一键立项写作与草稿生成（Drafting & Lifecycle）**：
   - 选题完整生命周期状态机：`candidate`（候选） ➔ `planned`（已规划） ➔ `drafted`（已立项） ➔ `published`（已发布） / `archived`（已归档）。
   - 一键生成标准化 YAML Frontmatter 草稿 Markdown 文件，直接联动 Agent 协同撰写正文。
6. **自媒体专属 Agent 工具集（DSH Agent Tools）**：
   - 原生类型化工具支持模型自主调用：
     - `media_init_scaffold`：初始化工作区知识库与规范指南
     - `media_list_topics`：查询近期高热选题与 Hooks
     - `media_create_draft`：将选题立项并生成草稿 Markdown
     - `media_refine_topic`：对单条资讯深度挖掘切入角度
     - `media_ingest_articles`：批量摄取资讯并执行 AIHOT 打分聚类
7. **可视化工作台界面（Web Client UI）**：
   - 注册左侧主导航专属图标（`sidebar.panellist`，order=30）与独立全屏主页面（`main` 槽位，key=`media-station`）。
   - 包含 **选题看板**（Stream 流式视图 / Dashboard 卡片）与 **信源抽屉**（Sources Drawer）。
   - 严格继承宿主设计规范与 `--dsw-alias-*` Design Tokens，支持中英文国际化。

---

## 安装与配置

### 配置文件 `cordis.patch.yml`

在你的 dsh profile 中引入：

```yaml
- insert:
    - id: media-station
      name: '@charonx/dsh-media-station'
      config:
        routePrefix: '/dsh-media-station'
        crawlerEngine: 'jina'
        minHeatThreshold: 60
        enableDedup: true
```

### 本地快速体验

```bash
cd deepseek-harness
pnpm dsh web --patch ../dsh-media-station/cordis.patch.yml
```

---

## 目标项目结构

以下为完整目标布局；当前只有 `src/index.ts`、`src/config.ts`、`src/shared/api.ts` 与 `docs/`。

```
dsh-media-station/
├── docs/
│   └── DESIGN.md                 # 完整系统架构与分期实施设计规范
├── src/
│   ├── index.ts                  # Host 插件入口 (Cordis apply)
│   ├── config.ts                 # Schemastery 配置声明
│   ├── shared/
│   │   └── api.ts                # Host 与 Client 共享的领域类型与通信协议
│   ├── host/                     # Host 端服务实现
│   │   ├── db.ts                 # 基于 Node 24 原生 node:sqlite 的存储层
│   │   ├── scaffold.ts           # 规范目录与 media-style.md 初始化
│   │   ├── aihot.ts              # AIHOT 双打分、聚类与启发式兜底
│   │   ├── refine.ts             # 深度提炼服务与异步任务管理
│   │   ├── sources.ts            # 信源管理与 OPML 导入
│   │   ├── fetcher.ts            # RSS / Atom 轻量解析器
│   │   ├── crawler.ts            # Jina Reader / Crawl4AI 正文抓取
│   │   ├── tools.ts              # Agent 专属工具集注册
│   │   └── http.ts               # HTTP 前缀路由与 Webhook 接口
│   └── client/                   # Web Client 浏览器端实现
│       ├── index.tsx             # Client 入口 (槽位注入与国际化)
│       ├── locales.ts            # 中英文字典
│       ├── api.ts                # Client 端 HTTP 客户端
│       ├── MediaStationPage.tsx  # 自媒体创作工作台主页面
│       ├── TopicsBoard.tsx       # 选题看板组件 (Stream / Dashboard)
│       └── SourcesDrawer.tsx     # 信源管理抽屉组件
├── cordis.patch.yml              # dsh bundle 声明
├── package.json
└── tsconfig.json
```

---

## 开源协议

本项目基于 MIT 协议分发。
