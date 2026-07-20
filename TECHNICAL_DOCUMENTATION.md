# 知识库系统 — 技术文档

> **版本**: 1.1 | **最后更新**: 2026-07-20 | **作者**: dudiaoweng

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [系统架构](#3-系统架构)
4. [数据库设计](#4-数据库设计)
5. [后端 API 设计](#5-后端-api-设计)
6. [前端架构](#6-前端架构)
7. [组件树与路由](#7-组件树与路由)
8. [核心数据流](#8-核心数据流)
9. [关键功能详解](#9-关键功能详解)
10. [状态管理](#10-状态管理)
11. [样式系统](#11-样式系统)
12. [安全措施](#12-安全措施)
13. [开发指南](#13-开发指南)
14. [部署说明](#14-部署说明)

---

## 1. 项目概述

**my-wiki** 是一个个人知识库管理系统，支持以下核心功能：

- 📄 **文章管理** — 创建、编辑、删除 Markdown 文章，支持分类和标签
- 📤 **文件上传解析** — 支持 .txt / .md / .docx / .xlsx / .pptx / .pdf / 图片 / 音视频，自动通过 LLM 提取标题、实体和关系
- 🔍 **智能搜索** — 基于向量嵌入 (embedding) 的语义搜索 + 关键词降级搜索
- 🤖 **智能问答 (RAG)** — 检索增强生成，结合知识库文章和实体附加信息回答用户问题
- 🕸️ **知识图谱** — D3.js 力导向图，展示文章-分类-实体之间的关系网络
- 🏷️ **实体管理** — LLM 自动提取实体+关系，支持附加信息（类别+内容），用于增强知识图谱和 Q&A 上下文
- 📱 **响应式设计** — 桌面端三栏布局，移动端自适应堆叠

### 1.1 项目结构总览

```
my-wiki/
├── backend/                     # Python FastAPI 后端
│   ├── .env                     # 环境变量 (LLM API Key 等)
│   ├── requirements.txt         # Python 依赖
│   ├── knowledge_base.db        # SQLite 数据库
│   ├── uploads/                 # 上传文件存储
│   └── app/
│       ├── main.py              # 入口：FastAPI 应用工厂、路由注册、种子数据
│       ├── database.py          # SQLAlchemy 引擎、会话、表创建、迁移
│       ├── dependencies.py      # FastAPI 依赖注入 (get_db)
│       ├── models.py            # ORM 模型 (Category, Article, ArticleChunk, EntityInfo)
│       ├── schemas.py           # Pydantic 请求/响应模型
│       ├── config.py            # 集中化 LLM/应用配置 (环境变量)
│       ├── llm_extract.py       # 共享 LLM 标签+实体提取 (统一超时/重试/容错)
│       └── routes/
│           ├── articles.py      # 文章 CRUD + 分页搜索
│           ├── categories.py    # 分类 CRUD
│           ├── tags.py          # 标签管理 (添加/重命名/删除)
│           ├── entities.py      # 实体管理 + 附加信息 CRUD + 嵌入重算
│           ├── graph.py         # 知识图谱数据构建
│           ├── qa.py            # RAG 问答管道
│           ├── stats.py         # 仪表盘统计
│           └── upload.py        # 文件上传 + LLM 实体提取
│
├── knowledge-base.html          # 前端入口 (可直接打开)
├── frontend/                    # React 18 + TypeScript 前端
│   ├── index.html               # Vite 入口 HTML
│   ├── package.json             # NPM 依赖
│   ├── vite.config.ts           # Vite 配置 (代理 /api → :8000)
│   └── src/
│       ├── main.tsx             # React 入口
│       ├── App.tsx              # 根组件 (路由 + Provider)
│       ├── api/client.ts        # API 客户端 (类型化 fetch 封装)
│       ├── context/AppProvider.tsx  # 全局 UI 状态
│       ├── types/               # TypeScript 类型定义
│       │   ├── article.ts       # Article, ArticleCreate, ArticleUpdate
│       │   ├── category.ts      # Category
│       │   ├── graph.ts         # GraphNode, GraphEdge, GraphData
│       │   ├── qa.ts            # QAMessage, QASource, QAResponse
│       │   └── stats.ts         # Stats
│       ├── hooks/               # 自定义 Hooks
│       │   ├── useArticles.ts   # 文章获取/CRUD
│       │   ├── useCategories.ts # 分类获取/创建
│       │   ├── useD3ForceGraph.ts # D3 力导向图共享钩子
│       │   ├── useGraphData.ts  # 图谱数据获取
│       │   ├── useQA.ts         # QA 对话管理
│       │   ├── useStats.ts      # 统计数据获取
│       │   ├── useTags.ts       # 标签获取
│       │   ├── useToast.tsx     # Toast 通知系统
│       │   ├── useKeyboardShortcuts.ts  # 键盘快捷键
│       │   └── useReadingProgress.ts    # 阅读进度
│       ├── utils/               # 工具函数
│       │   └── entityIcons.ts   # 实体类型图标映射 (共享)
│       ├── components/          # React 组件
│       │   ├── Layout/          # Layout, Sidebar, TopBar
│       │   ├── Hero.tsx         # 首页
│       │   ├── ArticleList.tsx  # 文章列表 + 实体面板
│       │   ├── ArticleCard.tsx  # 文章卡片
│       │   ├── ArticleDetail.tsx        # 文章详情页 (独立路由)
│       │   ├── ArticleDetailInline.tsx  # 文章内联详情
│       │   ├── EntityPanel.tsx  # 实体面板 (LLM实体只读列表+知识图谱双模式)
│       │   ├── KnowledgeGraph.tsx       # 全屏知识图谱页
│       │   ├── QA.tsx           # 智能问答页
│       │   ├── EditorModal.tsx  # 文章编辑器
│       │   ├── UploadModal.tsx  # 文件上传器
│       │   ├── ConfirmDialog.tsx # 确认对话框
│       │   ├── Toast.tsx        # Toast 容器
│       │   └── ReadingProgress.tsx # 阅读进度条
│       └── styles/              # 全局样式
│           ├── tokens.css       # 设计变量 (颜色/字体/阴影)
│           ├── reset.css        # CSS Reset
│           └── global.css       # 全局样式 + 动画 + 可访问性
│
└── .claude/                     # Claude Code 配置
    ├── agents/code-reviewer.md  # 代码审查 Agent
    └── settings.local.json      # 本地设置
```

---

## 2. 技术栈

### 2.1 后端

| 技术 | 版本 | 用途 |
|------|------|------|
| **Python** | 3.11+ | 运行时 |
| **FastAPI** | 0.115.6 | Web 框架，异步 REST API |
| **Uvicorn** | 0.34.0 | ASGI 服务器 |
| **SQLAlchemy** | 2.0.36 | ORM，数据库抽象 |
| **Pydantic** | 2.10.3 | 数据验证与序列化 |
| **SQLite** | 3.x | 嵌入式数据库 |
| **httpx** | 0.28.1 | 异步 HTTP 客户端 (LLM API 调用) |
| **python-multipart** | — | 文件上传解析 |
| **python-docx** | — | Word 文档解析 |
| **openpyxl** | — | Excel 文档解析 |
| **python-pptx** | — | PowerPoint 文档解析 |
| **PyPDF2** | — | PDF 文档解析 |
| **python-dotenv** | — | 环境变量加载 |

### 2.2 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 18.x | UI 框架 |
| **TypeScript** | 5.x | 类型安全 |
| **Vite** | 6.x | 构建工具与开发服务器 |
| **React Router DOM** | 6.x | 客户端路由 (URL Search 参数驱动状态) |
| **D3.js** | 7.x | 知识图谱力导向图 |
| **react-markdown** | — | Markdown 渲染 |
| **remark-gfm** | — | GitHub Flavored Markdown 支持 |
| **CSS Modules** | — | 组件级样式隔离 |

### 2.3 外部 LLM 服务

| 服务 | 端点 | 用途 |
|------|------|------|
| **智谱 (BigModel)** | `https://open.bigmodel.cn/api/paas/v4` | LLM 对话 + 嵌入向量 |
| 模型: `glm-4` (可配置) | `/chat/completions` | 问答生成、实体提取、标题生成 |
| 模型: `embedding-3` | `/embeddings` | 文本向量化 (语义搜索) |

> 任何兼容 OpenAI API 格式的服务均可替换使用。

---

## 3. 系统架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────┐
│                    浏览器 (Browser)                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │              React 18 SPA (Vite)                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │ AppProvider│ │  Router  │ │ CSS Modules       │  │  │
│  │  │ (Context) │ │ (react-  │ │ (tokens/reset/    │  │  │
│  │  │           │ │  router) │ │  global)           │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │            Hooks Layer                        │  │  │
│  │  │  useArticles │ useQA │ useGraphData │ ...     │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │            API Client (client.ts)             │  │  │
│  │  │     fetch() + JSON + Error Handling          │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│                          │  HTTP (localhost:5173 → :8000) │
└──────────────────────────┼───────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────┐
│                 后端 (Python/FastAPI)                     │
│                          ▼                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │              FastAPI Application                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │  │
│  │  │  CORS    │ │ Lifespan │ │ Static Files      │  │  │
│  │  │  MW      │ │ (seed)   │ │ (/uploads)        │  │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │           Route Layer (8 routers)             │  │  │
│  │  │  articles │ categories │ tags │ entities     │  │  │
│  │  │  graph    │ qa         │ stats │ upload      │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │           Dependency Injection                │  │  │
│  │  │              get_db() → Session               │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │           SQLAlchemy ORM                      │  │  │
│  │  │  models.py (Category, Article, Chunk, Info)   │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                                │
│                    ┌─────┴─────┐                          │
│                    ▼           ▼                          │
│            ┌──────────┐ ┌──────────────┐                 │
│            │  SQLite  │ │ LLM API      │                 │
│            │  (.db)   │ │ (智谱/OpenAI) │                 │
│            └──────────┘ └──────────────┘                 │
└──────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **单用户本地优先** — SQLite 嵌入式数据库，无需独立数据库服务器
2. **渐进增强** — 有关键词搜索作为降级方案 (LLM 不可用时)
3. **URL 驱动状态** — 搜索/筛选/视图状态编码在 URL 参数中，支持分享和前进/后退
4. **乐观更新** — 前端先更新 UI，再等待 API 确认，保证响应速度
5. **关注点分离** — CSS Modules 隔离样式，Hooks 封装业务逻辑，组件只负责渲染
6. **代码复用** — 共享 LLM 提取模块 (`llm_extract.py`) 供文章创建/更新/上传共用；共享 D3 钩子 (`useD3ForceGraph`) 供图谱页/实体面板共用；共享实体图标 (`entityIcons.ts`) 跨组件一致

---

## 4. 数据库设计

### 4.1 ER 图

```
┌──────────────┐       ┌──────────────────────┐       ┌──────────────┐
│   Category   │       │       Article         │       │ ArticleChunk │
├──────────────┤       ├──────────────────────┤       ├──────────────┤
│ id (PK)      │──┐    │ id (PK)              │──┐    │ id (PK)      │
│ name (UQ)    │  │    │ title                │  │    │ article_id   │
│ color        │  │    │ content              │  │    │   (FK→Article│
└──────────────┘  │    │ category_id (FK,IDX) │◄─┘    │   CASCADE)   │
                  └───►│   → Category         │       │ chunk_index  │
                       │ tags (JSON TEXT)     │       │ chunk_text   │
                       │ entities (JSON TEXT) │       │ embedding    │
                       │ created_at           │       │   (JSON TEXT)│
                       │ updated_at (IDX)     │       └──────────────┘
                       │ attachment_path      │
                       │ attachment_name      │       ┌──────────────┐
                       │ attachment_type      │       │ EntityInfo   │
                       └──────────────────────┘       ├──────────────┤
                                                      │ id (PK)      │
                                                      │ entity_name  │
                                                      │   (IDX)      │
                                                      │ category     │
                                                      │ content      │
                                                      │ created_at   │
                                                      │ updated_at   │
                                                      └──────────────┘
```

### 4.2 表结构详解

#### `categories` — 文章分类

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 分类唯一标识 |
| `name` | VARCHAR(100) | UNIQUE, NOT NULL | 分类名称 |
| `color` | VARCHAR(7) | NOT NULL | 十六进制颜色 (如 `#1E5C8A`) |

#### `articles` — 文章

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 文章唯一标识 |
| `title` | VARCHAR(200) | NOT NULL | 文章标题 |
| `content` | TEXT | NOT NULL, DEFAULT "" | Markdown 内容 |
| `category_id` | VARCHAR(36) | FK→categories, ON DELETE SET NULL, INDEX | 所属分类 |
| `tags` | TEXT | NOT NULL, DEFAULT "[]" | 手动标签 (JSON 数组) |
| `entities` | TEXT | NULLABLE | LLM 提取的实体+关系 (JSON 对象) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL, INDEX | 更新时间 (UTC) |
| `attachment_path` | VARCHAR | NULLABLE | 上传文件路径 |
| `attachment_name` | VARCHAR | NULLABLE | 原始文件名 |
| `attachment_type` | VARCHAR | NULLABLE | 文件类型 |

**entities JSON 结构:**
```json
{
  "entities": [
    {"name": "机器学习", "type": "concept"},
    {"name": "深度学习", "type": "concept"}
  ],
  "relations": [
    {"source": "机器学习", "target": "深度学习", "label": "包含"}
  ]
}
```

#### `article_chunks` — 文章分块 (用于语义搜索)

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 分块唯一标识 |
| `article_id` | VARCHAR(36) | FK→articles, ON DELETE CASCADE, INDEX | 所属文章 |
| `chunk_index` | VARCHAR | NOT NULL | 分块序号 (如 "0", "1") |
| `chunk_text` | TEXT | NOT NULL | 分块文本内容 |
| `embedding` | TEXT | NULLABLE | 向量嵌入 (JSON 浮点数组) |

#### `entity_infos` — 实体附加信息

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 信息条目唯一标识 |
| `entity_name` | VARCHAR(200) | NOT NULL, INDEX | 关联实体名称 |
| `category` | VARCHAR(100) | NOT NULL, DEFAULT "" | 信息类别 (短标签) |
| `content` | TEXT | NOT NULL, DEFAULT "" | 信息内容 |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL | 更新时间 (UTC) |

### 4.3 索引策略

| 表 | 索引列 | 原因 |
|----|--------|------|
| articles | `category_id` | 按分类筛选是最常用操作 |
| articles | `updated_at` | 文章列表默认按更新时间排序 |
| article_chunks | `article_id` | 按文章查询分块是主访问路径 |
| entity_infos | `entity_name` | 按实体名查询附加信息 |

---

## 5. 后端 API 设计

### 5.1 路由总览

| 前缀 | 文件 | 端点 | 方法 | 说明 |
|------|------|------|------|------|
| `/api/articles` | `routes/articles.py` | `/` | GET | 文章列表 (分页/搜索/筛选) |
| | | `/{id}` | GET | 文章详情 |
| | | `/` | POST | 创建文章 |
| | | `/{id}` | PUT | 更新文章 |
| | | `/{id}` | DELETE | 删除文章 |
| | | `/{id}/download` | GET | 下载附件 |
| `/api/categories` | `routes/categories.py` | `/` | GET | 分类列表 |
| | | `/` | POST | 创建分类 |
| | | `/{id}` | PUT | 更新分类 |
| | | `/{id}` | DELETE | 删除分类 |
| `/api/tags` | `routes/tags.py` | `/` | GET | 标签列表 |
| | | `/` | POST | 添加标签 |
| | | `/rename` | PUT | 重命名标签 |
| | | `/remove` | POST | 删除标签 |
| | | `/by-article` | GET | 按文章分组标签 |
| `/api/entities` | `routes/entities.py` | `/` | GET | 实体列表 |
| | | `/` | POST | 添加实体 |
| | | `/update` | PUT | 更新实体 |
| | | `/rename` | PUT | 重命名实体 |
| | | `/remove` | DELETE | 删除实体 |
| | | `/{name}/info` | GET | 实体附加信息列表 |
| | | `/{name}/info` | POST | 创建实体附加信息 |
| | | `/{name}/info/{id}` | PUT | 更新实体附加信息 |
| | | `/{name}/info/{id}` | DELETE | 删除实体附加信息 |
| `/api/graph` | `routes/graph.py` | `/` | GET | 知识图谱数据 |
| `/api/qa` | `routes/qa.py` | `/ask` | POST | 问答 (RAG) |
| `/api/stats` | `routes/stats.py` | `/` | GET | 统计数据 |
| `/api/upload` | `routes/upload.py` | `/` | POST | 文件上传 |
| `/api` | `main.py` | `/health` | GET | 健康检查 |

### 5.2 核心 API 详解

#### GET /api/articles — 文章列表

**查询参数:**
| 参数 | 类型 | 说明 |
|------|------|------|
| `category_id` | string | 按分类 UUID 筛选 |
| `search` | string | 按标题+内容搜索 (ILIKE) |
| `tag` | string | 按标签筛选 (JSON 子串匹配) |
| `skip` | int | 分页偏移 (默认 0) |
| `limit` | int | 每页数量 (默认 50, 最大 200) |

**响应:** `ArticleResponse[]`

#### POST /api/qa/ask — 智能问答 (RAG 管道)

**请求:**
```json
{
  "question": "什么是观察者模式？",
  "history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

**处理流程:**

```
用户问题
    │
    ▼
┌─────────────────┐
│ 1. 语义搜索      │  ← 向量化问题 → 余弦相似度 → 取 top-5 文章块
│  semantic_search │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 实体信息收集   │  ← 从问题和检索结果中提取实体名 → 查 entity_infos 表
│ _collect_entity  │
│ _info            │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. LLM 调用      │  ← 构建系统提示 (知识库内容 + 实体附加信息 + 历史)
│ call_llm         │     → POST /chat/completions → 返回生成回答
└────────┬────────┘
         │
         ▼
    最终回答 + 来源列表
```

**响应:**
```json
{
  "answer": "观察者模式是一种行为设计模式...",
  "sources": [
    {
      "article_id": "abc-123",
      "title": "设计模式笔记",
      "excerpt": "观察者模式定义了对象之间的一对多依赖...",
      "relevance": 0.89
    }
  ]
}
```

**降级策略:** 如果 LLM API 不可用，使用关键词匹配 (`fallback_keyword_search`) 生成摘要式回答。

#### POST /api/upload — 文件上传

**请求:** `multipart/form-data`
| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 上传文件 |
| `category_id` | string | 目标分类 UUID (可选) |

**处理流程:**

```
上传文件
    │
    ▼
┌──────────────────┐
│ 1. 安全校验       │  ← 路径穿越防护 (文件名净化)
│                  │  ← 大小限制 (500MB)
│                  │  ← 扩展名校验
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 2. 文件解析       │  ← .txt/.md → 直接读取
│ (按类型分发)      │  ← .docx → python-docx
│                  │  ← .xlsx → openpyxl
│                  │  ← .pptx → python-pptx
│                  │  ← .pdf → PyPDF2
│                  │  ← 图片 → base64 + 视觉 LLM
│                  │  ← 音视频 → 转录 API
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. LLM 标题生成   │  ← 从内容中提取简洁标题
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 4. LLM 标签+实体提取│  ← 调用共享 llm_extract 模块
│ (60s超时+重试+容错)│    提取标签+实体+关系 JSON
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 5. 创建文章 +     │  ← 存储到数据库
│    异步嵌入计算    │  ← 后台 asyncio.create_task 计算向量
└──────────────────┘
```

#### GET /api/graph — 知识图谱数据

**响应:** `{ nodes: GraphNode[], edges: GraphEdge[] }`

**节点类型:**
| 前缀 | 类型 | 说明 | 视觉样式 |
|------|------|------|---------|
| `category:` | category | 文章分类 | 彩色圆点 |
| `article:` | article | 文章 | 彩色矩形卡片 |
| `entity:` | entity | LLM 提取的实体 | 带类型表情符号的圆点 |

**边类型:**
| 标签 | 源→目标 | 说明 |
|------|---------|------|
| `"属于"` | article → category | 文章归属分类 |
| `"提及"` | article → entity | 文章提及实体 |
| `(自定义)` | entity → entity | 实体间关系 (来自 LLM 提取) |

**安全限制:** 最多 2000 个节点，防止图谱过于庞大。

---

## 6. 前端架构

### 6.1 目录职责

```
src/
├── main.tsx          # ReactDOM.createRoot, 挂载 <App/>
├── App.tsx           # 路由配置, Provider 嵌套, 全局模态框
├── api/client.ts     # 所有 API 调用的统一出口
├── context/          # React Context (全局 UI 状态)
├── types/            # TypeScript 接口定义
├── hooks/            # 可复用的数据获取和业务逻辑
├── components/       # UI 组件 (每个组件一个文件夹)
│   ├── Layout/       # 布局组件 (路由无关)
│   └── *.tsx         # 页面级和功能组件
└── styles/           # 全局 CSS (tokens, reset, global)
```

### 6.2 Provider 层级

```
<BrowserRouter>
  <ToastProvider>          ← Toast 通知上下文
    <AppProvider>          ← 全局 UI 状态 (侧边栏/编辑器/确认框/文章版本号)
      <ReadingProgress />  ← 文章阅读进度条 (全局)
      <Routes>
        <Route element={<Layout />}>   ← TopBar + Sidebar + <Outlet/>
          <Route path="/" element={<Hero />} />
          <Route path="/articles" element={<ArticleList />} />
          <Route path="/articles/:id" element={<ArticleDetail />} />
          <Route path="/qa" element={<QA />} />
        </Route>
      </Routes>
      <EditorModal />      ← 全局模态框 (条件渲染)
      <UploadModal />      ← 全局模态框 (条件渲染)
      <ConfirmDialog />    ← 全局对话框 (条件渲染)
      <ToastContainer />   ← Toast 渲染容器 (条件渲染)
      <KbShortcuts />      ← 键盘快捷键监听
    </AppProvider>
  </ToastProvider>
</BrowserRouter>
```

### 6.3 Hooks 设计模式

所有数据获取 Hooks 遵循统一模式：

```typescript
// 示例: useArticles
function useArticles(params?) {
  const [data, setData]     = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getXxx(params);
      setData(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [deps]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch, /* mutation methods */ };
}
```

**关键 Hooks 一览:**

| Hook | 返回值 | 用途 |
|------|--------|------|
| `useArticles(params)` | articles, loading, error, createArticle, updateArticle, deleteArticle, refetch | 文章 CRUD + 列表 |
| `useCategories()` | categories, loading, error, createCategory, refetch | 分类列表 + 创建 |
| `useGraphData()` | graphData, loading, error, refetch | 知识图谱数据 |
| `useStats()` | stats, loading, error, refetch | 仪表盘统计 |
| `useTags()` | tags, loading, error, refetch | 标签列表 |
| `useQA()` | sessions, activeId, askQuestion, newSession, ... | QA 会话管理 |
| `useToast()` | showToast | Toast 通知 |

### 6.4 API 客户端 (`client.ts`)

```typescript
// 核心封装
async function request<T>(path: string, options?: RequestInit): Promise<T>

// 错误处理
class ApiError extends Error {
  status: number;
  message: string;  // 从响应 body.detail 提取
}

// 查询字符串构建
function qs(params: Record<string, string>): string

// 导出对象
export const api = {
  getArticles, getArticle, createArticle, updateArticle, deleteArticle,
  getCategories, createCategory,
  getTags, addTag, renameTag, removeTag, getTagsByArticle,
  addEntity, updateEntity, renameEntity, removeEntity,
  getEntityInfos, createEntityInfo, updateEntityInfo, deleteEntityInfo,
  getGraphData,
  askQuestion,
  uploadFile,     // FormData 方式, 不用 JSON
};
```

---

## 7. 组件树与路由

### 7.1 路由表

| 路径 | 组件 | 说明 |
|------|------|------|
| `/` | `Hero` | 首页: 搜索入口 + 统计概览 |
| `/articles` | `ArticleList` | 文章列表: 卡片 + 实体面板 |
| `/articles?view=:id` | `ArticleList` → `ArticleDetailInline` | 文章列表 + 内联详情 + 实体面板 |
| `/articles/:id` | `ArticleDetail` | 文章详情独立页 (从知识图谱导航而来) |
| `/qa` | `QA` | 智能问答: 多会话 + 聊天 UI |

### 7.2 组件通信

```
AppProvider (Context)
  ├── sidebarOpen, toggleSidebar
  ├── editorState, openEditor, closeEditor
  ├── confirmState, requestConfirm
  ├── uploaderOpen, openUploader, closeUploader
  ├── articleVersion, notifyArticleSaved  ← 全局刷新信号
  └── searchInputRef                       ← 跨组件聚焦搜索框

ArticleList
  ├── 读取 URL params: category, search, tag, view
  ├── 传递给 EntityPanel: entities (LLM实体), selectedArticleIds, articles
  └── 接收 EntityPanel 回调: onGraphNodeClick (节点点击联动)

EntityPanel
  ├── 双模式: list (LLM实体只读列表+附加信息) / graph (D3 知识图谱)
  ├── 从 ArticleList 接收选中的文章 ID
  ├── 图谱节点点击 → 回传 ArticleList 筛选文章
  └── 实体点击 → 展开附加信息面板 (CRUD)

QA
  └── 独立管理对话状态 (localStorage)
```

---

## 8. 核心数据流

### 8.1 文章上传完整流程

```
用户拖放文件 → UploadModal
    │
    ▼
POST /api/upload (FormData)
    │
    ▼
后端: 安全校验 → 解析文件 → LLM 提取标题/实体 → 创建文章 → 异步嵌入
    │
    ▼
返回 Article JSON
    │
    ▼
UploadModal:
  1. notifyArticleSaved()  ← articleVersion++
  2. navigate('/articles?view=<articleId>')
    │
    ▼
ArticleList:
  1. articleVersion 变化 → refetch()         ← 文章列表刷新
  2. viewId 变化 → setViewedArticleId(id)     ← 显示内联详情
  
Sidebar:
  1. articleVersion 变化 → refetch()          ← 分类计数刷新

EntityPanel:
  1. articleVersion 变化 → refetchGraph()     ← 知识图谱刷新
```

### 8.2 文章删除流程

```
用户点击删除 → ConfirmDialog → 确认
    │
    ▼
ArticleDetailInline / ArticleDetail:
  1. api.deleteArticle(id)               ← 调用后端删除
  2. notifyArticleSaved()                ← articleVersion++
    │
    ▼
  所有监听 articleVersion 的组件自动刷新:
  - ArticleList: refetch()
  - Sidebar: refetch()
  - EntityPanel: refetchGraph()
```

### 8.3 全局刷新信号 (`articleVersion`)

这是一个简单但有效的跨组件通信模式:

```typescript
// AppProvider.tsx
const [articleVersion, setArticleVersion] = useState(0);
const notifyArticleSaved = useCallback(() => {
  setArticleVersion(v => v + 1);
}, []);
```

任何修改文章的操作 (创建/更新/删除/上传) 都调用 `notifyArticleSaved()`，所有需要同步的组件通过 `useEffect` 监听 `articleVersion` 变化来触发自身的 `refetch`。

### 8.4 URL 驱动的筛选状态

```
/articles                          → 所有文章
/articles?category=<id>            → 按分类筛选
/articles?search=关键词             → 搜索结果
/articles?tag=标签名                → 按标签筛选
/articles?view=<articleId>         → 查看内联详情
```

所有筛选状态存储在 URL search params 中，支持:
- 浏览器前进/后退
- 链接分享
- 键盘导航 (Ctrl+K → 跳转 /articles 并聚焦搜索框)

---

## 9. 关键功能详解

### 9.1 RAG 问答管道 (`qa.py`)

#### 文本分块策略

```python
def chunk_article(content: str) -> list[str]:
    # 1. 按 Markdown 标题分割 (##, ###)
    # 2. 长段落按双换行分割
    # 3. 超长段落按单换行分割
    # 4. 超长行按字符数硬截断 (2000 字符)
    # 保证每块不超过 MAX_CHUNK_CHARS
```

#### 词嵌入生成

```python
async def get_embedding(text: str) -> list[float]:
    # POST {base}/embeddings
    # 模型: embedding-3
    # 文本截断 2000 字符
    # 返回浮点向量
```

#### 语义搜索

```python
async def semantic_search(db, question, top_k=5):
    # 1. ensure_embeddings(db)  — 增量计算缺失的嵌入
    # 2. q_embedding = get_embedding(question)
    # 3. 遍历所有 chunk，计算余弦相似度
    # 4. 按文章去重，取 top_k
    # 5. 所有嵌入计算失败 → fallback_keyword_search
```

#### 实体信息增强

```python
def _collect_entity_info(question, top_chunks, db) -> str:
    # 1. 扫描问题中的已知实体名
    # 2. 扫描检索结果中的实体
    # 3. 查询 entity_infos 表
    # 4. 格式化为 Markdown 注入 LLM 上下文:
    #    ## 实体附加信息（知识图谱）
    #    **实体名**:
    #      - 类别: 内容
```

#### 降级搜索

当嵌入 API 不可用时，使用 CJK 双字母组 + 英文单词的简单关键词匹配:

```python
def fallback_keyword_search(db, question, top_k=5):
    # CJK: 滑窗取相邻字符对 (如 "观察者模式" → ["观察", "察者", "者模", "模式"])
    # EN: 取 >=2 字母的单词
    # 标题匹配权重 3.0, 内容匹配权重 1.0
```

### 9.2 文件上传解析

| 文件类型 | 解析方式 | 备注 |
|---------|---------|------|
| `.txt`, `.md`, 代码文件 | 直接 `file.read()` + UTF-8 解码 | 文本类 |
| `.docx` | `python-docx` → 提取段落文本 | Word 文档 |
| `.xlsx` | `openpyxl` → 遍历所有工作表 | Excel 表格 |
| `.pptx` | `python-pptx` → 提取幻灯片文本 | PowerPoint |
| `.pdf` | `PyPDF2` → 逐页提取文本 | PDF 文档 |
| `.jpg/.png/.gif/.webp` | base64 → 视觉 LLM 描述 | 图片转文字 |
| `.mp3/.wav/.mp4/.avi` | 转录 API → 降级为元数据 | 音视频 |

**安全措施:**
- 文件名净化: `re.sub(r'[^\w.\-]', '_', Path(file.filename).name)` (防路径穿越)
- 文件大小限制: 500MB
- UUID 存储名 (防文件名冲突)
- 同步解析器在 `asyncio.to_thread()` 中运行 (不阻塞事件循环)

### 9.3 知识图谱可视化

使用 D3.js v7 力导向图，通过共享 Hook (`useD3ForceGraph`) 实现代码复用：

**节点视觉设计:**
- `category` — 彩色圆点 (使用分类颜色)
- `article` — 彩色矩形，显示文章标题 (~160px 宽)
- `entity` — 圆形，显示类型表情符号 + 实体名

**交互功能:**
- 缩放/平移 (d3.zoom)
- 节点拖拽 (d3.drag)
- 悬停工具提示 (title + 类型)
- 节点点击联动筛选文章列表
- 多节点选择 (Ctrl+Click)

**SVG 箭头标记:**
```xml
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M 0 0 L 10 5 L 0 10 z" fill="#999" />
</marker>
```

### 9.4 响应式布局

| 断点 | 布局 | 侧边栏 | 文章列表 | 实体面板 |
|------|------|--------|---------|---------|
| > 1100px | 三栏 | 240px 固定 | flex: 3 (主体) | 320px 固定, sticky |
| ≤ 1100px | 单栏堆叠 | 覆盖层 | 50% 高度, 可滚动 | 50% 高度, 可滚动 |

移动端核心 CSS:
```css
@media (max-width: 1100px) {
  .layout {
    flex-direction: column;
    height: 100%;
    gap: 0;
  }
  .mainCol { flex: 1 1 0%; min-height: 0; overflow-y: auto; }
  .panel   { flex: 1 1 0%; min-height: 0; overflow-y: auto; }
}
```

两个区域通过 `flex: 1 1 0%` 等分可用高度。

---

## 10. 状态管理

### 10.1 不依赖外部状态管理库

项目使用 React 内置的 Context + Hooks 管理所有状态，没有引入 Redux/Zustand 等。设计理由:

- 应用规模适中 (< 20 个组件)
- 单用户场景，无复杂的并发状态
- URL 参数承担了大部分筛选状态的持久化

### 10.2 状态分类

| 状态类型 | 存储方式 | 示例 |
|---------|---------|------|
| 路由状态 | URL search params | 分类筛选、搜索词、视图模式 |
| 服务端数据 | `useState` in hooks | 文章列表、图谱数据、统计 |
| 全局 UI 状态 | `AppProvider` Context | 侧边栏开关、编辑器、确认框 |
| 持久化状态 | `localStorage` | QA 对话历史 |
| 刷新信号 | Context (`articleVersion`) | 跨组件数据同步 |
| 组件本地状态 | `useState` | 选择状态、编辑状态 |

### 10.3 AppProvider 提供的全局状态

```typescript
interface AppContextValue {
  // 侧边栏
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // 编辑器
  editorState: { isOpen: boolean; articleId: string | null };
  openEditor: (articleId: string | null) => void;
  closeEditor: () => void;

  // 确认框
  confirmState: { message: string; onConfirm: () => void; confirmLabel?: string } | null;
  requestConfirm: (message: string, onConfirm: () => void, confirmLabel?: string) => void;

  // 上传器
  uploaderOpen: boolean;
  openUploader: () => void;
  closeUploader: () => void;

  // 刷新信号
  articleVersion: number;
  notifyArticleSaved: () => void;

  // 搜索框引用 (用于键盘快捷键)
  searchInputRef: React.RefObject<HTMLInputElement>;
}
```

---

## 11. 样式系统

### 11.1 设计变量 (`tokens.css`)

采用纸质/暖色调风格:

```css
/* 背景色 */
--c-page:    #FCFCFA;   /* 页面背景 (暖白) */
--c-surface: #F3F1ED;   /* 表面背景 (浅灰) */
--c-card:    #FFFFFF;   /* 卡片背景 */

/* 文字色 */
--c-text:       #1A1C1E;  /* 主文字 */
--c-text-soft:  #4A4D52;  /* 次要文字 */
--c-text-muted: #8B8F94;  /* 辅助文字 */

/* 强调色 */
--c-accent:      #1E5C8A;  /* 深蓝 (主色) */
--c-accent-hover:#17476E;  /* 悬停 */
--c-accent-wash: #E8F0F7;  /* 浅色背景 */

/* 分类色 (8 种) */
--c-cat-0: #1E5C8A;   --c-cat-1: #2E7D32;
--c-cat-2: #E65100;   --c-cat-3: #6A1B9A;
--c-cat-4: #C62828;   --c-cat-5: #00838F;
--c-cat-6: #4E342E;   --c-cat-7: #37474F;

/* 字体 */
--font-display: 'Iowan Old Style', 'Palatino', serif;
--font-body:    -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-mono:    'SF Mono', 'Cascadia Code', 'Fira Code', monospace;

/* 圆角 */
--radius-sm: 4px;   --radius-md: 8px;   --radius-lg: 12px;

/* 过渡 */
--transition-fast: 150ms ease;
```

### 11.2 CSS 组织方式

- **CSS Modules** — 每个组件对应一个 `.module.css` 文件，类名自动 scoped
- **全局样式** — `reset.css` (浏览器重置), `global.css` (动画关键帧、可访问性)
- **无 CSS 框架** — 不使用 Tailwind/Bootstrap，手写 CSS

### 11.3 动画

```css
@keyframes fadeSlideIn  { /* 页面进入 */ }
@keyframes modalIn      { /* 模态框弹出 */ }
@keyframes toastIn      { /* Toast 滑入 */ }
@keyframes toastOut     { /* Toast 滑出 */ }
@keyframes typingBounce { /* QA 打字动画 */ }
@keyframes spin         { /* 加载旋转 */ }
```

支持 `prefers-reduced-motion` 媒体查询关闭动画。

---

## 12. 安全措施

### 12.1 已实施的安全措施

| 类别 | 措施 | 位置 |
|------|------|------|
| **路径穿越** | 文件名净化 `re.sub(r'[^\w.\-]', '_', name)` | `upload.py` |
| **文件大小** | 500MB 上传限制 | `upload.py` |
| **XSS** | D3 工具提示 `innerHTML` 使用 `esc()` HTML 转义 | `useD3ForceGraph.ts` (共享钩子) |
| **UUID 校验** | 路径参数通过 `uuid.UUID()` 验证 | `articles.py`, `entities.py` |
| **SQL 注入** | SQLAlchemy ORM 参数化查询 | 全后端 |
| **错误泄露** | 移除异常消息中的 `str(e)` | `upload.py` |
| **CORS** | 可配置的允许来源列表 | `main.py` |
| **外键** | `PRAGMA foreign_keys = ON` | `database.py` |
| **请求体限制** | QA 历史最多 20 条，文章分页最多 200 | `qa.py`, `articles.py` |
| **图谱节点限制** | MAX_NODES = 2000 | `graph.py` |

### 12.2 已知安全限制

- ⚠️ **无身份验证** — 设计用于本地单用户环境
- ⚠️ **无速率限制** — 需要时可添加 slowapi 中间件
- ⚠️ **LLM API Key 存储在 `.env`** — 本地部署场景下可接受
- ⚠️ **SQLite 并发限制** — 生产环境建议迁移至 PostgreSQL

---

## 13. 开发指南

### 13.1 环境准备

```bash
# 克隆项目
cd my-wiki

# 后端
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 配置环境变量
cp .env.example .env
# 编辑 .env: 填写 LLM_API_KEY, LLM_API_BASE, LLM_MODEL 等

# 启动后端 (端口 8000)
uvicorn app.main:app --reload --port 8000

# 前端
cd frontend
npm install

# 启动前端 (端口 5173, 自动代理 /api → :8000)
npm run dev
```

### 13.2 项目脚本

```bash
# 前端
npm run dev          # 开发模式
npm run build        # 生产构建
npm run preview      # 预览生产构建

# 后端
uvicorn app.main:app --reload           # 开发模式 (热重载)
uvicorn app.main:app --host 0.0.0.0    # 生产模式
```

### 13.3 添加新功能

#### 添加新 API 端点

1. 在 `backend/app/routes/` 下创建或编辑路由文件
2. 定义 Pydantic schema (如在 `schemas.py` 需要)
3. 在 `backend/app/main.py` 中注册路由: `app.include_router(xxx.router)`
4. 在 `frontend/src/api/client.ts` 中添加 API 方法
5. 创建前端 TypeScript 类型 (如需要)
6. 创建前端 Hook (如需要)
7. 创建前端组件

#### 添加新页面

1. 在 `frontend/src/components/` 创建组件
2. 在 `frontend/src/App.tsx` 添加 `<Route>`
3. 在 `Sidebar.tsx` 添加导航链接 (可选)

### 13.4 数据库迁移

SQLite 不直接支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，项目采用 try/except 方式:

```python
# database.py init_db()
with engine.connect() as conn:
    try:
        conn.exec_driver_sql("ALTER TABLE articles ADD COLUMN entities TEXT")
    except Exception:
        pass  # 列已存在
```

添加新列时在此处追加类似的 try/except 块。

### 13.5 调试技巧

- **API 调试:** 访问 `http://localhost:8000/docs` (Swagger UI 自动生成)
- **前端调试:** 浏览器 DevTools → Network 面板查看 API 调用
- **数据库调试:** 使用 SQLite 浏览器打开 `backend/knowledge_base.db`
- **LLM 调试:** 在 `qa.py` 的 `call_llm()` 函数中添加 `logger.debug()` 打印系统提示

---

## 14. 部署说明

### 14.1 生产构建

```bash
# 前端构建
cd frontend
npm run build
# 输出: frontend/dist/

# 后端配置
cd backend
# 设置 CORS_ORIGINS 环境变量为前端域名
export CORS_ORIGINS="https://your-domain.com"
```

### 14.2 部署方案

**方案 A: Nginx 反向代理 (推荐)**

```nginx
server {
    listen 80;
    server_name wiki.example.com;

    # 前端静态文件
    location / {
        root /path/to/frontend/dist;
        try_files $uri /index.html;
    }

    # 后端 API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**方案 B: FastAPI 直接托管静态文件**

```python
# main.py 添加
from fastapi.staticfiles import StaticFiles
app.mount("/", StaticFiles(directory="../frontend/dist", html=True), name="static")
```

### 14.3 注意事项

- 使用 `gunicorn` + `uvicorn.workers.UvicornWorker` 进行多进程部署
- SQLite 在单进程下工作良好，多进程需考虑 WAL 模式
- 生产环境建议使用 PostgreSQL + pgvector 替换 SQLite 存储嵌入向量
- 添加 HTTPS (通过 Nginx + Let's Encrypt)
- 生产环境建议添加认证层 (JWT / API Key)

---

## 附录 A: 依赖版本清单

### 后端 (requirements.txt)

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
sqlalchemy==2.0.36
pydantic==2.10.3
httpx==0.28.1
python-multipart==0.0.20
aiofiles==24.1.0
python-docx==1.1.2
openpyxl==3.1.5
python-pptx==1.0.2
PyPDF2==3.0.1
python-dotenv==1.0.1
pydantic-settings==2.7.0
```

### 前端 (package.json)

```json
{
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-router-dom": "^6.28.0",
  "react-markdown": "^9.0.1",
  "remark-gfm": "^4.0.0",
  "d3": "^7.9.0",
  "@types/d3": "^7.4.3",
  "typescript": "~5.6.2",
  "vite": "^6.0.0",
  "@vitejs/plugin-react": "^4.3.4"
}
```

## 附录 B: API 端点速查

```
GET    /api/health                         健康检查
GET    /api/articles?category_id=&search=&tag=&skip=&limit=   文章列表
GET    /api/articles/:id                   文章详情
POST   /api/articles                       创建文章
PUT    /api/articles/:id                   更新文章
DELETE /api/articles/:id                   删除文章
GET    /api/articles/:id/download          下载附件
GET    /api/categories                     分类列表
POST   /api/categories                     创建分类
PUT    /api/categories/:id                 更新分类
DELETE /api/categories/:id                 删除分类
GET    /api/tags                           标签列表
POST   /api/tags                           添加标签
PUT    /api/tags/rename                    重命名标签
POST   /api/tags/remove                    删除标签
GET    /api/tags/by-article                按文章分组标签
GET    /api/entities                       实体列表
POST   /api/entities                       添加实体
PUT    /api/entities/update                更新实体
PUT    /api/entities/rename                重命名实体
DELETE /api/entities/remove                删除实体
GET    /api/entities/:name/info            实体附加信息
POST   /api/entities/:name/info            创建实体附加信息
PUT    /api/entities/:name/info/:id        更新实体附加信息
DELETE /api/entities/:name/info/:id        删除实体附加信息
GET    /api/graph                          知识图谱数据
POST   /api/qa/ask                         智能问答
GET    /api/stats                          统计数据
POST   /api/upload                         文件上传
```

---

> 📝 本文档由 Claude Code 基于项目源码自动生成，最后更新于 2026-07-20。
