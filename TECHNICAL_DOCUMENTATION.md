# 知识库系统 — 技术文档

> **版本**: 2.0 | **最后更新**: 2026-09-02 | **作者**: dudiaoweng

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

- 📄 **文章管理** — 创建、编辑、删除 Markdown 文章，支持分类和标签；仅创建人可编辑/删除
- 💬 **文章评论** — 评论 CRUD，支持多附件、内容纳入智能问答；仅评论人可编辑/删除
- 🔐 **权限控制** — 基于身份证号的创建人验证，文章/评论/实体/分类均受保护
- 📤 **文件上传解析** — 支持 .txt / .md / .docx / .xlsx / .pptx / .pdf / 图片 / 音视频；文档文本异步提取（读取中→解析中两阶段），自动通过 LLM 提取标题、实体和关系（分段提取、逐段落库）
- 🔍 **智能搜索** — 基于向量嵌入 (embedding) 的语义搜索 + 关键词降级搜索
- 🤖 **智能问答 (RAG)** — 检索增强生成，结合知识库文章和实体附加信息回答用户问题
- 🕸️ **知识图谱** — D3.js 力导向图，展示文章-分类-实体之间的关系网络
- 🏷️ **实体管理** — LLM 自动提取实体+关系（实体以「名称+类型」为标识），支持附加信息（类别+内容），用于增强知识图谱和 Q&A 上下文
- 📱 **响应式设计** — 桌面端三栏布局，移动端自适应堆叠

### 1.1 项目结构总览

```
my-wiki/
├── backend/                     # Python FastAPI 后端
│   ├── run.py                   # 生产入口：双端口服务 (8000/8444) + SSL 兼容补丁
│   ├── .env                     # 环境变量 — 仓库根目录 .env（config.py 显式加载）
│   ├── requirements.txt         # Python 依赖
│   ├── knowledge_base.db        # SQLite 数据库
│   ├── uploads/                 # 上传文件存储
│   ├── static/                  # 前端构建产物 (生产模式, vite outDir)
│   └── app/
│       ├── main.py              # FastAPI 应用工厂、路由注册、种子数据
│       ├── database.py          # SQLAlchemy 引擎、会话、表创建、迁移
│       ├── dependencies.py      # FastAPI 依赖注入 (get_db)
│       ├── models.py            # ORM 模型 (Category, Article, ArticleChunk, EntityInfo, Comment)
│       ├── schemas.py           # Pydantic 请求/响应模型
│       ├── config.py            # 集中化配置：LLM/Vision/ASR/Embedding/QA/TLS (环境变量)
│       ├── auth.py              # mTLS 身份：签名验证 (openssl verify) + CN 解析（peercert 直连 / nginx X-Client-Cert 头双模式）
│       ├── prompts.py           # 所有 LLM 提示词模板
│       ├── llm_extract.py       # 共享 LLM 标签+实体提取 (统一超时/重试/容错)
│       ├── utils.py             # 共享工具函数 (find_ffmpeg 等)
│       └── routes/
│           ├── articles.py      # 文章 CRUD + 分页搜索 + 附件重解析
│           ├── categories.py    # 分类 CRUD
│           ├── comments.py      # 评论 CRUD + 附件上传 + LLM 增强
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
│   ├── vite.config.ts           # Vite 配置 + mTLS 开发代理中间件 (X-Dev-User 动态选证书)
│   └── src/
│       ├── main.tsx             # React 入口
│       ├── App.tsx              # 根组件 (路由 + Provider + 认证守卫)
│       ├── api/client.ts        # API 客户端 (类型化 fetch 封装)
│       ├── api/auth.ts          # mTLS 认证状态检查
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
│       │   ├── CommentSection.tsx       # 评论组件 (共用)
│       │   ├── AttachmentGallery.tsx    # 附件画廊
│       │   ├── EditorModal.tsx  # 文章编辑器
│       │   ├── UploadModal.tsx  # 文件上传器
│       │   ├── LoginPage.tsx    # 开发模式用户选择页 / 生产模式登录页
│       │   ├── CertErrorPage.tsx # mTLS 证书错误页
│       │   ├── ConfirmDialog.tsx # 确认对话框
│       │   ├── Toast.tsx        # Toast 容器
│       │   └── ReadingProgress.tsx # 阅读进度条
│       └── styles/              # 全局样式
│           ├── tokens.css       # 设计变量 (颜色/字体/阴影)
│           ├── reset.css        # CSS Reset
│           └── global.css       # 全局样式 + 动画 + 可访问性
│
├── certs/                       # PKI 证书 (自建 CA 体系)
│   ├── ca.key / ca.crt          # 项目自签 CA (CN=JSCA-Root, 10 年有效期)
│   ├── server.key / server.crt  # 服务器证书 (SAN: localhost/127.0.0.1，无 CRL 分发点)
│   ├── ca_openssl.cnf           # openssl CA 配置 (签发/吊销共用)
│   ├── index.txt / ca.srl       # CA 数据库 / 序列号文件
│   ├── gen_server.py / gen_clients.py  # 签发脚本 (服务器 / 客户端)
│   └── *.crt / *.key / *.p12    # 客户端证书 (开发代理 / 浏览器导入)
├── nginx/                       # nginx 反向代理配置
│   └── mtls.conf                # 8443 TLS 终止 (optional_no_ca)
├── Dockerfile                   # 多阶段构建 (静态 ffmpeg → Node 前端构建 → Python 运行时)
├── docker-compose.yml           # 双容器编排 (my-wiki + nginx)
├── .dockerignore
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
| **nginx** | 1.25 | 反向代理：mTLS TLS 终止 (`optional_no_ca`) |
| **Docker** | — | 容器化部署 (docker compose 双容器) |

### 2.2 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 18.x | UI 框架 |
| **TypeScript** | 5.x | 类型安全 |
| **Vite** | 5.x | 构建工具与开发服务器 |
| **React Router DOM** | 6.x | 客户端路由 (URL Search 参数驱动状态) |
| **D3.js** | 7.x | 知识图谱力导向图 |
| **react-markdown** | — | Markdown 渲染 |
| **remark-gfm** | — | GitHub Flavored Markdown 支持 |
| **CSS Modules** | — | 组件级样式隔离 |

#### 浏览器兼容性（Vite 5 构建目标 es2020）

| 浏览器 | 最低版本 |
|--------|---------|
| Chrome | 87+ |
| Edge | 88+ |
| Firefox | 78+ |
| Safari | 14+ |

> - Vite 5 默认构建目标为 es2020，Chrome 87+ 即可运行
> - **Object.hasOwn polyfill**：`index.html` 内置 polyfill——react-markdown@9 直接调用 ES2022 的 `Object.hasOwn`（Chrome 93+ 才支持），polyfill 将实际底线拉回 es2020（Chrome 87–92 / Firefox 78–91 / Safari 14–15.3）
> - **SHA-1 客户端证书**：Chrome/Edge 109+ 已移除支持；Firefox / Safari 仍支持。SHA-256 证书不受影响
> - **TLS 版本**：nginx 与 `run.py` 均强制 TLS 1.2 + 显式套件列表（`@SECLEVEL=0`），兼容 SHA-1 签名客户端证书
> - mTLS 登录需在浏览器中导入 CA 根证书和客户端 `.p12` 证书（见 14.2 部署前置条件）

### 2.3 外部 LLM 服务

四种模型类型独立配置，每种有独立的 API Key / Base / Model：

| 模型类型 | 用途 | 默认模型 | 配置前缀 |
|---------|------|---------|---------|
| **LLM 文本** | 标题生成、实体提取、纯文本问答 | `gpt-4o-mini` | `LLM_` |
| **Vision 视觉** | 图片描述、视频帧分析 | `glm-4v-flash` | `VISION_` |
| **ASR 语音识别** | 音频转文字 | `GLM-ASR-2512` | `ASR_` |
| **Embedding 嵌入** | 文本向量化 (语义搜索) | `embedding-3` | `EMBEDDING_` |

> 任何兼容 OpenAI API 格式的服务均可替换使用。未配置独立密钥时自动回退到 LLM 配置。
> 所有配置统一在 `app/config.py` 中管理，各模块通过 `from app.config import ...` 引用。
> **模型参数统一在仓库根目录 `.env` 配置**（docker-compose 不做覆盖）。项目当前默认智谱云端（open.bigmodel.cn）；备选本地 llama-server（`http://host.docker.internal:8080`，容器部署）在 `.env` 中以注释形式给出，ASR/Embedding 的本地模型坑见 §9.1 / §9.3。

---

## 3. 系统架构

### 3.1 架构图

```
┌───────────────────────────────────────────────────────────┐
│                      浏览器 (Browser)                      │
│  ┌─────────────────────────────────────────────────────┐  │
│  │               React 18 SPA (Vite 构建产物)           │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │  │
│  │  │ AppProvider│ │  Router  │ │ CSS Modules        │   │  │
│  │  │ (Context) │ │ (react-  │ │ (tokens/reset/     │   │  │
│  │  │           │ │  router) │ │  global)            │   │  │
│  │  └──────────┘ └──────────┘ └────────────────────┘   │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │  Hooks Layer + API Client (fetch)            │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────┘  │
└───┬──────────────────────┬─────────────────────┐
    │ ① 8000 HTTPS         │ ② 8443 HTTPS + mTLS │
    │   CERT_NONE          │   optional_no_ca    │
    │   (登录页)            │   (应用入口)         │
    ▼                      ▼
┌───────────────────────────────────────────────────────────┐
│               nginx 反向代理 (nginx:1.25)                  │
│  ②  TLS 终止 (server.crt) + 请求客户端证书不验证（后端验签） │
│     证书 PEM → X-Client-Cert 头 (URL 转义) → :8444 HTTP    │
└───────────────────────────┬───────────────────────────────┘
                            │  (仅 ② 经 nginx，① 直连后端)
                            ▼
┌───────────────────────────────────────────────────────────┐
│               后端 (Python/FastAPI, run.py)                │
│  ┌──────────────┐                ┌───────────────────┐    │
│  │ :8000        │                │ :8444             │    │
│  │ HTTPS 登录页  │                │ 应用 (纯 HTTP)     │    │
│  │ CERT_NONE    │                │ 解析 X-Client-    │    │
│  │ + 静态 SPA    │                │ Cert 头识别身份    │    │
│  └──────────────┘                └───────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐  │
│  │            FastAPI Application                       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │  │
│  │  │  CORS    │ │ Lifespan │ │ Static Files       │   │  │
│  │  │  MW      │ │ (seed)   │ │ (/uploads)         │   │  │
│  │  └──────────┘ └──────────┘ └────────────────────┘   │  │
│  │  ┌───────────────────────────────────────────────┐  │  │
│  │  │        Route Layer (9 routers + auth)         │  │  │
│  │  │  articles │ categories │ comments │ tags      │  │  │
│  │  │  entities │ graph │ qa │ stats │ upload       │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  │  ┌───────────────────────────────────────────────┐  │  │
│  │  │  Dependency Injection: get_db() → Session     │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  │  ┌───────────────────────────────────────────────┐  │  │
│  │  │  SQLAlchemy ORM (models.py)                   │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────┘  │
│                    ┌─────────┴─────────┐                  │
│                    ▼                   ▼                  │
│            ┌────────────┐      ┌──────────────┐           │
│            │   SQLite   │      │   LLM API    │           │
│            │   (.db)    │      │ (智谱/OpenAI) │           │
│            └────────────┘      └──────────────┘           │
└───────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **单用户本地优先** — SQLite 嵌入式数据库，无需独立数据库服务器
2. **渐进增强** — 有关键词搜索作为降级方案 (LLM 不可用时)
3. **URL 驱动状态** — 搜索/筛选/视图状态编码在 URL 参数中，支持分享和前进/后退
4. **乐观更新** — 前端先更新 UI，再等待 API 确认，保证响应速度
5. **关注点分离** — CSS Modules 隔离样式，Hooks 封装业务逻辑，组件只负责渲染
6. **代码复用** — 共享 LLM 提取模块 (`llm_extract.py`) 供文章创建/更新/上传共用；共享 D3 钩子 (`useD3ForceGraph`) 供图谱页/实体面板共用；共享工具函数 (`utils.py`) 提供 ffmpeg 查找等通用功能；共享实体图标 (`entityIcons.ts`) 跨组件一致
7. **配置统一** — 所有配置集中在 `config.py`，各模块通过 import 引用，避免 `os.getenv()` 分散在多个文件

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
                       │ updated_at (IDX)     │       │ entities     │
                       │ attachment_path      │       │   (JSON TEXT)│
                       │ attachment_name      │       └──────────────┘
                       │ attachment_type      │       ┌──────────────┐
                       └──────────────────────┘       │ EntityInfo   │
                                                      ├──────────────┤
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
| `created_by` | VARCHAR(200) | NULLABLE | 创建人 (证书 CN) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL | 更新时间 (UTC) |

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
    {"name": "机器学习", "type": "技术"},
    {"name": "深度学习", "type": "concept"}
  ],
  "relations": [
    {
      "source": "机器学习", "source_type": "concept",
      "target": "深度学习", "target_type": "concept",
      "label": "包含"
    }
  ]
}
```

> **实体身份规则**：实体以「名称+类型」为标识——同名但类型不同是两个不同实体，可同时存在（如「中华人民共和国」地点/组织）。关系两端均携带类型（`source_type` / `target_type`），关系去重键为五元组 `(source, source_type, target, target_type, label)`。

#### `article_chunks` — 文章分块 (用于语义搜索)

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 分块唯一标识 |
| `article_id` | VARCHAR(36) | FK→articles, ON DELETE CASCADE, INDEX | 所属文章 |
| `chunk_index` | VARCHAR | NOT NULL | 分块序号 (如 "0", "1") |
| `chunk_text` | TEXT | NOT NULL | 分块文本内容 |
| `embedding` | TEXT | NULLABLE | 向量嵌入 (JSON 浮点数组，嵌入失败时为 NULL 但分块行保留) |
| `entities` | TEXT | NULLABLE | 块级实体标注 (JSON 对象，分段提取时逐段落库) |

#### `entity_infos` — 实体附加信息

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 信息条目唯一标识 |
| `entity_name` | VARCHAR(200) | NOT NULL, INDEX | 关联实体名称 |
| `name` | VARCHAR(100) | NOT NULL, DEFAULT "" | 信息类别 (短标签) |
| `content` | TEXT | NOT NULL, DEFAULT "" | 信息内容 |
| `created_by` | VARCHAR(200) | NULLABLE | 创建人 (证书 CN) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL | 更新时间 (UTC) |

#### `comments` — 文章评论 (v1.3 新增)

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 评论唯一标识 |
| `article_id` | VARCHAR(36) | FK→articles, ON DELETE CASCADE, INDEX | 所属文章 |
| `content` | TEXT | NOT NULL, DEFAULT "" | 评论内容 (Markdown + 媒体标签) |
| `tags` | TEXT | NOT NULL, DEFAULT "[]" | 标签 (JSON 数组) |
| `entities` | TEXT | NULLABLE | LLM 提取的实体+关系 JSON |
| `attachments` | TEXT | NULLABLE | 附件列表 (JSON: [{path, name, type}]) |
| `processing` | TEXT | NULLABLE | "processing" 或 NULL (完成) |
| `created_by` | VARCHAR(200) | NOT NULL, DEFAULT "" | 创建人 (证书 CN) |
| `updated_by` | VARCHAR(200) | NOT NULL, DEFAULT "" | 更新人 (证书 CN) |
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
| | | `/{id}/reprocess` | POST | 重新解析全部附件 |
| | | `/{id}/reprocess/{safe_name}` | POST | 重新解析单个附件 |
| | | `/{id}/recognize` | POST | 重新解析文章文本内容（标签/实体、检索索引） |
| `/api/articles/{article_id}/comments` | `routes/comments.py` | `/` | GET | 评论列表 |
| | | `/` | POST | 创建评论 (支持附件) |
| | | `/{comment_id}` | PUT | 更新评论 |
| | | `/{comment_id}` | DELETE | 删除评论 |
| | | `/{comment_id}/reprocess` | POST | 重新解析评论内容（只针对内容） |
| | | `/{comment_id}/reprocess/{safe_name}` | POST | 重新解析评论单个附件（只针对该附件） |
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
| | | `/parse-file` | POST | 解析上传文件为问答上下文 |
| `/api/stats` | `routes/stats.py` | `/` | GET | 统计数据 |
| `/api/upload` | `routes/upload.py` | `/` | POST | 文件上传 |
| `/api` | `main.py` | `/media/{filename}` | GET | 媒体文件直链 |
| `/api` | `main.py` | `/health` | GET | 健康检查 |
| `/api/auth` | `main.py` | `/status` | GET | 证书认证状态 + 用户信息 (name/id_number/display_name) |
| `/api/auth` | `main.py` | `/login` | GET | 登录跳转 (生产模式，重定向回前端) |

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
  ],
  "file_contexts": [
    {
      "filename": "photo.jpg",
      "content": "<base64>",
      "content_type": "image/jpeg",
      "is_image": true
    }
  ],
  "kb_enabled": true
}
```

**处理流程:**

```
用户问题 + 上传文件(可选)
    │
    ▼
┌─────────────────┐
│ 1. 文件上下文解析  │  ← 图片→base64(视觉模型) / 文本→直接解析
│ parse-file       │  ← 音频→ASR转录 / 视频→帧提取+视觉描述
│ (如上传了文件)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 语义搜索      │  ← 向量化问题 → 余弦相似度 → 取 top-5 文章块
│  semantic_search │  ← (kb_enabled=false 时跳过)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. 实体信息收集   │  ← 从问题和检索结果中提取实体名 → 查 entity_infos 表
│ _collect_entity  │
│ _info            │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. LLM 调用      │  ← 构建系统提示 (知识库内容 + 实体附加信息 + 文件上下文 + 历史)
│ call_llm         │  ← 有图片时使用视觉模型, 纯文本使用文本模型
│                  │     → POST /chat/completions → 返回生成回答
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
      "relevance": 0.89,
      "entities": [
        {"name": "观察者模式", "type": "concept"},
        {"name": "GoF", "type": "组织"}
      ]
    }
  ]
}
```

> `sources[].entities` 取自命中分块的块级实体标注（`article_chunks.entities`，见 §9.9），前端在来源卡片显示实体 chips。

**降级策略:** 如果 LLM API 不可用，使用关键词匹配 (`fallback_keyword_search`) 生成摘要式回答。

#### POST /api/upload — 文件上传

**请求:** `multipart/form-data`
| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 上传文件 |
| `category_id` | string | 目标分类 UUID (可选) |

**处理流程 (两阶段):**

```
上传文件
    │
    ▼
┌──────────────────┐
│ 1. 安全校验       │  ← 路径穿越防护 (文件名净化)
│                  │  ← 大小限制 (500MB)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 2. 立即显示       │  ← 文本/图片/音频/视频以媒体标签立即显示
│ (创建文章)        │  ← 文档: processing="processing:{name}" (读取中)
│                  │  ← 媒体+AUTO_PARSE: "recognizing:{name}" (解析中)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. 后台异步任务    │  ← Step A: 文档文本提取 (纯本地解析, 始终执行)
│ (_bg_enhance)     │     → 文本先落库, processing 转 "recognizing:{name}"
│                   │  ← Step B: 媒体 LLM 描述 (AUTO_PARSE 控制)
│                   │     → 图片: 视觉模型 / 视频: OpenCV 帧 / 音频: ASR
│                   │  ← 重建向量分块 + 嵌入 (文本最终确定后)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 4. 分段 LLM 提取  │  ← 标题生成 + 标签/实体/关系提取 (AUTO_PARSE 控制)
│ (逐段落库)        │  ← 基于向量分块逐段提取, 每段完成立即落库
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 5. 合并落库       │  ← 更新文章内容 (含错误报告) + 合并标签/实体
│    完成清空状态    │  ← processing → None, 前端停止轮询
└──────────────────┘
```

#### GET /api/graph — 知识图谱数据

**响应:** `{ nodes: GraphNode[], edges: GraphEdge[] }`

**节点类型:**
| 前缀 | 类型 | 说明 | 视觉样式 |
|------|------|------|---------|
| `category:` | category | 文章分类 | 彩色圆点 |
| `article:` | article | 文章 | 彩色矩形卡片 |
| `entity:` | entity | LLM 提取的实体（节点 id = `entity:{名称}::{类型}`） | 图标按类型，标签只显示名称 |

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
  parseFileForQA, // 解析上传文件为问答上下文
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
    # 0. 移除 HTML 注释 (<!-- doc-attachment --> 等附件标记是元数据, 不产生分块)
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
    # 模型: embedding-3（云端）/ bge-m3-Q4_K_M（本地 llama-server）
    # 文本截断 2000 字符
    # 返回浮点向量
```

**响应格式兼容**（v2.1）：云端返回 OpenAI 格式 `{"data": [{"embedding": [...]}]}`；本地 llama.cpp b10775 路由版返回原生格式 `[{"index": 0, "embedding": [[...]]}]`（顶层数组 + 向量多套一层）。`get_embedding` 两种格式都解析。**注意**：本地 bge-m3 子进程默认 `ubatch-size=512`，长分块（>500 token）会报 `input is too large to process` 500 —— preset 里需配 `ubatch-size = 2048`（`batch-size` 是逻辑批，配了没用）。

#### 嵌入管理

```python
# 使用 asyncio.Lock 保护全局计数器，防止并发重复计算
async def ensure_embeddings(db, force=False):
    async with _embedding_lock:
        # 1. 增量检测: 对比缓存计数与 Article 总数
        # 2. 仅对缺失 chunk 的文章计算嵌入
        # 3. force=True 时删除旧 chunk 重新计算全部
```

#### 语义搜索

```python
async def semantic_search(db, question, top_k=5) -> list[tuple[float, Article, ArticleChunk | None]]:
    # 1. ensure_embeddings(db)  — 增量计算缺失的嵌入 (asyncio.Lock 保护)
    # 2. q_embedding = get_embedding(question)
    # 3. 遍历所有 chunk，计算余弦相似度
    # 4. 按文章去重，取 top_k
    # 5. 所有嵌入计算失败 → fallback_keyword_search
    # 返回值携带命中的分块行 (chunk) —— QASource.entities 取自该块的块级实体
    # 标注，前端在来源卡片显示实体 chips；关键词兜底路径 chunk=None
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
| `.txt`, `.md`, 代码文件 | 编码检测后解码：BOM（utf-8-sig/utf-16）→ 严格 UTF-8 → 严格 GB18030（GBK/GB2312 超集）→ UTF-8 容错替换 | 文本类（Windows GBK 文件不再乱码） |
| `.docx` | `python-docx` → 提取段落文本 | Word 文档 |
| `.xlsx` | `openpyxl` → 遍历所有工作表 | Excel 表格 |
| `.pptx` | `python-pptx` → 提取幻灯片文本 | PowerPoint |
| `.pdf` | `PyPDF2` → 逐页提取文本 | PDF 文档 |
| 图片 (`.jpg/.png/.gif/.webp` 等) | base64 → 视觉模型描述 | 图片转文字 |
| 音频 (`.mp3/.wav/.m4a/.flac` 等) | ffmpeg/wave 转单声道 16kHz WAV → ASR 模型转录 | 语音转文字 |
| 视频 (`.mp4/.avi/.mov/.mkv` 等) | OpenCV 提取 5 帧 → 视觉模型描述 | 视频内容识别 |

### 9.3 音频处理详解

1. **WAV 格式**: 使用内置 `wave` + `audioop` 模块，将多声道转为单声道，重采样为 16kHz
2. **其他格式 (MP3/M4A 等)**: 通过 `subprocess` 调用 ffmpeg 转换: `ffmpeg -i pipe:0 -ac 1 -ar 16000 -f wav pipe:1`
3. **转换后**: 调用 ASR API (`/audio/transcriptions` 端点) 获取转录文本
4. **错误处理**: 转换失败或识别失败时，错误信息写入文章内容供用户查看

**模型选择**（`.env` 统一配置）：

| 场景 | ASR_API_BASE / ASR_MODEL | 备注 |
|------|--------------------------|------|
| 云端 | `https://open.bigmodel.cn/api/paas/v4` / `GLM-ASR-2512` | 当前默认 |
| 本地 llama-server | `http://host.docker.internal:8080`（容器）/ `localhost:8080`（本地开发）/ `Qwen3-ASR-1.7B-Q4_K_M` | 需 preset 挂 mmproj（见下） |

**本地 Qwen3-ASR 的坑（2026-09 实测）**：

- **mmproj 必须经 preset INI 挂载**：b10775 路由器不自动识别 `mmproj-` 前缀，没挂时 `/v1/models` 显示 `input_modalities: ["text"]`，`/audio/transcriptions` 返回 501 "The current model does not support audio input"。挂上后变为 `["text","audio"]` 即正常
- **输出带前缀噪音**：转录文本形如 `language Chinese<asr_text>正文…`，后端已循环剥离 `language <语种>` 与 `<...>` 标记
- **替换式写入（v2.1）**：`parse_media` 返回带 `<audio>` 标签的完整描述，调用方（upload/articles）用 `_replace_media_placeholder` 替换占位标签行——多次 reprocess 不再在正文中堆叠旧转录段

### 9.4 视频处理详解

1. 使用 OpenCV (`cv2`) 打开视频文件
2. 在 0%、25%、50%、75%、90% 位置提取 5 个关键帧
3. 帧缩放至最大 1024px，JPEG 编码为 base64
4. 多张图片一次性发送至视觉模型，获取视频内容描述
5. 文章内容嵌入 `<video>` 标签 + 描述文本

**安全措施:**
- **路径穿越防护**: 文件名净化 `re.sub(r'[^\w.\-]', '_', name)` + 媒体文件端点 `Path.resolve()` 校验路径在 UPLOAD_DIR 范围内
- 文件大小限制: 500MB (上传) / 50MB (问答)
- UUID 存储名 (防文件名冲突)
- 同步解析器在 `asyncio.to_thread()` 中运行 (不阻塞事件循环)
- 后台闭包不再捕获 `content_bytes`，改为从磁盘重新读取（大文件内存友好）

### 9.5 知识图谱可视化

使用 D3.js v7 力导向图，通过共享 Hook (`useD3ForceGraph`) 实现代码复用：

**节点视觉设计:**
- `category` — 彩色圆点 (使用分类颜色)
- `article` — 彩色矩形，显示文章标题 (~160px 宽)
- `entity` — 圆形，图标按实体类型（人物👤/组织🏢/地点📍/事件⚡/产品📦/作品📄…），标签只显示实体名

**实体节点标识:** 实体以「名称+类型」为标识，节点 id = `entity:{name}::{type}`——同名不同类型（如「中华人民共和国」地点/组织）是两个独立节点；类型经 `entity_type` 字段下发，前端据此渲染图标。旧数据产生的无类型节点（`entity:{name}::`）按名称匹配兜底。

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

### 9.6 响应式布局

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

### 9.7 手动重新解析体系（v1.4+）

手动重新解析按「层面（文章/评论）× 目标（内容/附件）」划分，各入口语义独立：

| 层面 | 入口 | 端点 | 行为 |
|------|------|------|------|
| 文章内容 | 详情页 🧠 重新解析（仅创建人，处理中灰显） | `POST /api/articles/{id}/recognize` | 重建分块/嵌入 + 重新提取标签/实体（用户标签保留合并，实体按新结果覆盖）。**不触碰附件** |
| 文章附件 | 附件卡片 🔄（仅创建人） | `POST /api/articles/{id}/reprocess/{safe_name}` | 重新解析该附件（媒体替换式写入）并重新提取标签/实体 |
| 文章全部附件 | 仅 API | `POST /api/articles/{id}/reprocess` | 重新解析全部附件并重新提取标签/实体 |
| 评论内容 | 评论操作区 🧠（评论人或文章创建人） | `POST /api/articles/{id}/comments/{cid}/reprocess` | **只针对内容**：重建评论分块/嵌入 + 重新提取标签/实体。不触碰附件 |
| 评论附件 | 附件卡片 🔄（评论人或文章创建人） | `POST /api/articles/{id}/comments/{cid}/reprocess/{safe_name}` | **只针对该附件**：重新解析并替换写入正文，随后重建评论分块/嵌入。不重新提取标签/实体 |

实现要点：

- **评论内容重解析**（`_bg_comment_reextract`）：旧实体贡献先从文章实体中扣除（`_subtract_comment_from_article`），再合并新提取结果，避免实体重复累计；评论自身已有标签保留合并
- **评论附件重解析**（`_bg_comment_attachment_reprocess`）：媒体用替换式写入（`_replace_media_tag_with_desc` 替换含该文件的媒体标签行并清理同名重复标签，避免旧描述堆积）；文档仅当占位符仍在时替换。正文变化后重建评论分块 + 嵌入，保持 Q&A 检索索引新鲜。端点校验 `safe_name` 属于该评论（含 legacy 单附件字段），防止把不属于该评论的文件解析进正文
- 解析状态追踪：`processing` 字段两阶段——`"processing:{safe_name}"`（读取中：文本提取）→ `"recognizing"`/`"recognizing:{safe_name}"`（解析中：LLM 识别）→ 完成清空。文档上传后文本提取与识别结果分两步落库
- 前端 AttachmentGallery 根据 processing 字段匹配附件，分别显示"读取中…"/"解析中…"遮罩；文章详情页与评论列表各 5 秒轮询，两阶段各自落库后前端即可看到；识别完成清空遮罩并通知刷新
- **自动解析开关（`AUTO_PARSE`）**：默认关闭（`0`）。控制 LLM 类后台解析（媒体描述、标签/实体/标题提取）。上传接口与评论的文档附件（txt/md/docx/xlsx/pptx/pdf）文本提取为纯本地解析，请求返回后由后台任务异步执行并置 `processing` 标志，不受开关影响；关闭时媒体描述与标签/实体提取跳过，文章编辑器的附件仍保留"待解析"占位符。手动 reprocess/recognize 端点不受开关影响
- **分段 LLM 提取（v2.0）**：标签/实体/关系提取基于向量分块逐段进行——每段最多 2000 字符、最多 10 段；每段完成后立即落库（逐段落库），后续段失败时已保存的结果不受影响。各段结果按「名称+类型」（实体）/ 五元组（关系）去重合并。详见 §9.9

### 9.8 权限控制体系（v1.3+）

所有创建人判断基于 mTLS 证书 CN 中的 18 位身份证号：

| 资源 | 创建人记录 | 修改权限 | 删除权限 | 重新解析权限 |
|------|-----------|---------|---------|------------|
| 文章 | created_by | 仅创建人 | 仅创建人 | 仅创建人 |
| 评论 | created_by | 仅评论人 | 评论人或文章创建人 | 评论人或文章创建人 |
| 实体 | entities JSON 中的 created_by | 实体创建人或文章创建人 | 同左 | — |
| 实体附加信息 | EntityInfo.created_by | 仅创建人 | 仅创建人 | — |
| 分类 | created_by | 仅创建人 | 仅创建人 | — |

- 前端通过身份证号比对隐藏非创建人的编辑/删除按钮
- 后端 403 兜底拦截，错误详情区分权限错误与认证错误（认证 403 触发登录跳转，权限 403 仅弹 toast）

### 9.9 分段提取与块级实体标注（v2.0）

**问题背景**：单次 LLM 提取受上下文长度限制（默认截断 2000 字符），长文档后半部分的实体/关系会丢失。

**方案 A — 单一分段来源**：提取与语义搜索共用同一套向量分块（`article_chunks` 表）。上传/评论/附件重解析在提取前统一调用 `rebuild_article_chunks()` 重建分块并嵌入，随后从分块行读取文本逐段提取——不再重复切分逻辑，保证「检索到的块」与「提取用的段」一一对应。

```
长文本 ──chunk_article──► article_chunks 表 (唯一分段来源)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        语义搜索检索      嵌入向量计算      分段 LLM 提取
        (semantic_search) (embed_chunk_rows) (extract_chunks_iter)
```

**方案 B — 块级实体标注（逐段落库）**：`article_chunks.entities` 列记录每个分块提取到的实体/关系。提取循环每段完成后立即 `db.commit()`，段级失败不丢失前段结果。

```python
chunk_rows = get_article_chunks(db2, article_id)
texts = [r.chunk_text for r in chunk_rows]
seg_idx = 0
async for seg_tags, seg_entities in extract_chunks_iter(texts):
    if seg_entities and seg_idx < len(chunk_rows):
        chunk_rows[seg_idx].entities = json.dumps(seg_entities, ensure_ascii=False)
    db2.commit()          # 逐段落库
    seg_idx += 1
```

**块级标注的下游应用**：`semantic_search()` 返回命中的分块行，`QASource.entities`（经 `parse_chunk_entities(chunk)` 解析）随检索结果返回前端，QA 回答的来源卡片显示实体 chips（`🏷 实体名`），用户可直观看到检索依据。

**限制与容错**：
- 每段 ≤ 2000 字符、最多 10 段（超出部分不提取）
- `merge_tags`（标签按名称去重）/ `merge_entities`（实体按名称+类型、关系按五元组去重）合并各段结果
- 嵌入失败时分块行保留（`embedding=None`），提取不受影响；检索时走关键词兜底
- 评论分块以 `comment.{id}.{i}` 索引存储，喂给提取时剥离 `[评论] ` 前缀
- 文档提取（`extract_chunks_iter`）是异步生成器，调用方需用计数器迭代（`enumerate()` 不支持异步生成器）

### 9.10 安全加固（v2.1）

2026-09 全面审查后修复的安全问题（详见代码注释）：

| 修复 | 位置 | 说明 |
|------|------|------|
| **证书签名验证** | `auth.py` `verify_client_cert_pem` + `main.py` MediaAuthMiddleware | 此前 `X-Client-Cert` 头的 CN 被无条件信任，任意自签证书可伪造身份。现在先 `openssl verify`（CA 级信任 + `-partial_chain` + `-no_check_time`）再解析 CN；媒体文件路由同样验证 |
| **画廊 XSS 防护** | `AttachmentGallery.tsx` `isSafeMediaSrc` | 正则提取正文媒体 src 后白名单校验（站点相对路径 / http/https），拦截 `javascript:`、`data:`、`//evil.com`——此前下载链接可构造 `javascript:` URL 执行脚本 |
| **编辑保存竞态** | `EditorModal.tsx` `loadingArticle` | 文章异步加载完成前禁用保存按钮，防止空 title/content 覆盖原文 |
| **文件名转义** | `upload.py` `parse_image/parse_video/parse_media`、`qa.py` 回退答案 | 用户文件名拼进正文前一律 `html.escape`，堵住 `<script>.txt` 类文件名注入 |
| **SVG / 媒体响应头** | `main.py` `serve_media` | 所有响应加 `X-Content-Type-Options: nosniff`；非媒体类型（html/txt）强制 `Content-Disposition: attachment`；SVG 保持 inline 但加 `CSP: sandbox`（直开导航时禁脚本） |
| **媒体替换式写入** | `upload.py`/`articles.py`/`comments.py`（见 §9.3、§9.7） | reprocess 不再追加堆积旧描述/转录段 |

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
| **mTLS 认证** | nginx 8443 TLS 终止：`optional_no_ca` 只请求证书，证书 PEM 经 `X-Client-Cert` 头传递；后端 `openssl verify -no_check_time -partial_chain -CAfile certs/ca.crt` 验证签名（CA 级信任：RootCA/JSCA 签发的所有人），再 `checkend` 校验叶子有效期，最后解析 CN 识别身份 | `nginx/mtls.conf`, `auth.py` |
| **直连兼容** | 开发模式 uvicorn 单端口 8000 (CERT_OPTIONAL)，`auth.py` 从 TLS peercert 提取 CN（双模式：peercert 直连 / X-Client-Cert 头） | `main.py`, `auth.py` |
| **证书吊销** | 已完全移除 — 服务器证书不含 CRL 分发点（`gen_server.py` 签发），CRL 分发端点已删除 | `main.py`, `run.py` |
| **应用白名单** | `ALLOWED_CERT_SUBJECTS` 控制允许的证书 CN（空 = 全部允许） | `auth.py`, `config.py` |
| **资源权限** | 文章/评论/实体/附加信息/分类基于身份证号比对 created_by，仅创建人可修改/删除 | 各路由模块 |
| **SHA-1 兼容** | `run.py` SSL 兼容补丁：`VERIFY_X509_PARTIAL_CHAIN` + 强制 TLS 1.2 + 显式套件列表 (`@SECLEVEL=0`)；nginx 同样限制 TLS 1.2 + 套件 | `run.py`, `nginx/mtls.conf` |
| **路径穿越** | 文件名净化 + `/api/media/` 端点 `Path.resolve()` 范围校验 | `upload.py`, `main.py` |
| **文件大小** | 500MB 上传限制 / 50MB 问答文件限制 | `upload.py`, `qa.py` |
| **XSS** | 非媒体类型（html/txt）强制 `Content-Disposition: attachment`；SVG inline 但加 `CSP: sandbox`；媒体响应统一 `nosniff`；文件名进正文前 `html.escape`；画廊 src 协议白名单；D3 `innerHTML` 使用 `esc()` 转义；QA 回答经 rehype-sanitize 消毒 | `main.py`, `upload.py`, `AttachmentGallery.tsx`, `useD3ForceGraph.ts`, `QA.tsx` |
| **UUID 校验** | 路径参数通过 `uuid.UUID()` 验证 | `articles.py`, `entities.py` |
| **SQL 注入** | SQLAlchemy ORM 参数化查询 | 全后端 |
| **错误泄露** | 错误信息写入文章内容（用户可见）而非静默丢失 | `upload.py` |
| **CORS** | 可配置的允许来源列表 | `main.py` |
| **外键** | `PRAGMA foreign_keys = ON` | `database.py` |
| **请求体限制** | QA 历史最多 20 条/50 条消息，文章分页最多 200，文件上下文最多 5 个 | `qa.py`, `articles.py` |
| **图谱节点限制** | MAX_NODES = 2000 | `graph.py` |
| **竞态保护** | `ensure_embeddings` 使用 `asyncio.Lock` 防止并发重复计算 | `qa.py` |
| **闭包内存** | 后台任务不捕获 `content_bytes`，改为从磁盘重新读取 | `upload.py` |

### 12.2 四层访问控制模型

```
第一层 TLS（nginx 8443）
  └─ 服务器出示证书（浏览器验证链）；客户端证书被请求（optional_no_ca 不验证链）
  └─ （含国密 U-Key 证书：浏览器经 Windows 证书库出示）
      ↓
第二层 签名验证（auth.py verify_client_cert_pem）
  └─ openssl verify -no_check_time -partial_chain -CAfile certs/ca.crt
  └─ CA 级信任：RootCA/JSCA/项目 CA 签发的所有证书通过；伪造自签证书拒绝
  └─ checkend 0 单独校验叶子有效期（-no_check_time 不查任何时间）
  └─ 验证失败 → 401 "Client certificate is required"
      ↓
第三层 应用白名单（ALLOWED_CERT_SUBJECTS）
  └─ auth.py 解析身份：peercert (直连模式) 或 X-Client-Cert 头 (nginx 反代模式)
  └─ verify_client_cert 依赖挂在 api_router 上
  └─ 空列表 = 全部放行；非空 = CN 精确匹配才放行
  └─ 不匹配 → 401 "Client certificate is not authorized"
  └─ 未出示证书 → 401 → 浏览器重新协商 → 弹出证书选择框
      ↓
第四层 资源权限（created_by 身份证号比对）
  └─ 文章：仅创建人可编辑/删除
  └─ 评论：仅评论人可编辑/删除（文章创建人可删评论）
  └─ 实体：实体创建人或文章创建人
  └─ 附加信息：仅创建人
  └─ 分类：仅创建人
```

### 12.3 证书吊销机制 (CRL) — 已完全移除

CRL 机制已完全移除：`server.crt` 由 `certs/gen_server.py` 签发，不含 CRL 分发点扩展，客户端不会发起任何吊销检查；后端 `GET /crl.pem` 端点、nginx 8080 分发、`certs/crl.pem` 文件均已删除。

| 环节 | 说明 |
|------|------|
| 服务器证书 | `server.crt` 不含 CRL 分发点（`certs/gen_server.py` 签发） |
| 分发 | 已删除（原 `GET /crl.pem` 端点、nginx 8080 端口） |
| 生成 | （如需恢复）`openssl ca -config ca_openssl.cnf -gencrl -out crl.pem` |
| 吊销 | （如需恢复）`openssl ca -config ca_openssl.cnf -revoke <cert>.crt` 后重新生成 CRL |

> 如需恢复吊销机制：在 `certs/gen_server.py` 中为服务器证书加入 CRL 分发点扩展后重新签发（分发点必须指向客户端可访问的实际地址，不能用 localhost），并恢复分发端点。

### 12.4 已知安全限制

- ⚠️ **TLS 层不验证客户端证书链** — `optional_no_ca` 请求但不验证；准入控制完全依赖第二层白名单。`ALLOWED_CERT_SUBJECTS` 留空时任何持有证书者均可访问
- ⚠️ **CRL 吊销机制已完全移除** — 服务器证书不含 CRL 分发点、分发端点已删除；已签发证书无法吊销，泄露后只能重新签发整套证书替换
- ⚠️ **无速率限制** — 需要时可添加 slowapi 中间件
- ⚠️ **LLM API Key 存储在 `.env`** — 本地部署场景下可接受
- ⚠️ **SQLite 并发限制** — 生产环境建议迁移至 PostgreSQL
- ⚠️ **白名单留空时允许所有证书** — Docker compose 默认未设置，需显式配置

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

# 配置环境变量（仓库根目录，Docker 与本地开发共用）
cp .env.example .env
# 编辑 .env: 填写 LLM_API_KEY, LLM_API_BASE, LLM_MODEL 等
cd ..

# 启动后端 (端口 8000, HTTPS + CERT_OPTIONAL, 热重载)
.venv\Scripts\python -m app.main    # Windows
# source .venv/bin/python -m app.main  # macOS/Linux

# 前端
cd frontend
npm install

# 启动前端 (端口 5173, HTTPS 开发服务器, mTLS 代理中间件)
npm run dev
# 访问 https://localhost:5173 → 显示用户选择页面 → 选择身份登录
```

> 开发模式说明：`python -m app.main` 启动单端口 HTTPS 服务 (8000, CERT_OPTIONAL)；Vite 5173 的 `mtlsProxyMiddleware` 中间件根据请求头 `X-Dev-User` 动态选择客户端证书代理 `/api/*` 请求到 8000。用户注册表在 `vite.config.ts` 的 `DEV_USERS` 中配置，前端入口在 `LoginPage.tsx`。

### 13.2 问答文件上传

通过 `/api/qa/parse-file` 端点，用户可在问答中上传文件作为 LLM 对话上下文：

| 文件类型 | 处理方式 | 返回 |
|---------|---------|------|
| 文本 (.txt/.md 等) | 直接读取内容 | 文本字符串 |
| 文档 (.docx/.xlsx/.pptx/.pdf) | 临时文件 + 对应解析器 | 文本字符串 |
| 图片 (.jpg/.png 等) | base64 编码 | base64 字符串 + MIME 类型，标记 `is_image=true` |
| 音频 (.mp3/.wav 等) | ffmpeg/wave 单声道转换 → ASR 转录 | 转录文本 |
| 视频 (.mp4/.avi 等) | OpenCV 帧提取 → 视觉模型描述 | 描述文本 |

> 仅 WORD/EXCEL/PPT/PDF 需要写入临时文件，其它类型直接从内存处理。

### 13.3 项目脚本

```bash
# 前端
npm run dev          # 开发模式
npm run build        # 生产构建
npm run preview      # 预览生产构建

# 后端
python -m app.main                      # 开发模式 (8000 HTTPS + CERT_OPTIONAL, 热重载)
python run.py                           # 生产模式 (双端口: 8000/8444)
```

### 13.4 添加新功能

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

### 13.5 数据库迁移

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

### 13.6 调试技巧

- **API 调试:** 访问 `https://localhost:8000/docs` (Swagger UI 自动生成)
  > ⚠️ 生产模式 (run.py / Docker) 的 8000 端口是 CERT_NONE，从 Swagger 直接调用受保护 API 必然返回 `{"detail":"Client certificate is required"}`。调试受保护接口请用 `curl --cert <客户端证书.crt> --key <客户端密钥.key> -k https://localhost:8443/api/...`（经 nginx 入口），或开发模式下浏览器已导入客户端证书时在 Swagger 中调用
- **前端调试:** 浏览器 DevTools → Network 面板查看 API 调用
- **数据库调试:** 使用 SQLite 浏览器打开 `backend/knowledge_base.db`
- **LLM 调试:** 在 `qa.py` 的 `call_llm()` 函数中添加 `logger.debug()` 打印系统提示

---

## 14. 部署说明

### 14.1 生产构建

```bash
# 前端构建 (vite.config.ts 的 outDir 指向 backend/static)
cd frontend
npm run build
# 输出: backend/static/  (构建时读取 ../certs 下的证书文件)

# 后端配置
cd backend
# 设置 CORS_ORIGINS 环境变量为前端域名
export CORS_ORIGINS="https://your-domain.com"
```

### 14.2 部署方案

**方案 A: Docker Compose（推荐，v1.9 双容器）**

```bash
docker compose up -d --build
# 8000 登录页 / 8443 mTLS 应用
```

**双容器架构：**

| 容器 | 镜像 | 职责 |
|------|------|------|
| `my-wiki` | 多阶段构建（静态 ffmpeg → Node 18 → Python 3.11-slim） | 后端双端口服务（8000 HTTPS 登录页 / 8444 应用） |
| `my-wiki-nginx` | `nginx:1.25` | 8443 TLS 终止（`optional_no_ca`） |

```
浏览器
  ├─ :8000  HTTPS ──────────────► my-wiki:8000   (登录页, CERT_NONE)
  └─ :8443  HTTPS + 客户端证书 ──► nginx ── HTTP ─► my-wiki:8444  (应用)
                                  (TLS 终止, X-Client-Cert 头)
```

- 多阶段构建：静态 ffmpeg 二进制（`mwader/static-ffmpeg:7.0`，替代 apt 版 ~450MB）→ Node 18 构建前端（`vite build` 输出到 `backend/static`）→ Python 3.11-slim 运行时（OpenCV headless）
- 数据持久化：本机目录绑定挂载 — `./data`（SQLite）/ `./uploads`（上传文件）
- **环境变量**：模型参数（KEY/BASE/MODEL）、超时、开关、白名单**统一在仓库根目录 `.env`**（Docker 挂载为 `/app/.env`，本地开发由 `config.py` 显式加载），docker-compose 不做覆盖
- **证书**：`./certs:/certs:ro` 只读挂载（镜像不含证书，启动必须提供）；SSL 路径使用容器内绝对路径（`/certs/server.crt` 等）；nginx 容器挂载同一目录（`/etc/nginx/certs`）
- 修改 `.env` 后执行 `docker compose restart` 即生效（`.env` 挂载 + `load_dotenv()` 在进程启动时读取）；**修改 `docker-compose.yml` 则需 `docker compose up -d` 重建容器**（容器创建时 bake 的环境变量不会随 restart 刷新，且 `load_dotenv` 不覆盖已存在的环境变量）
- 环境变量优先级：容器环境（Dockerfile `ENV`）> `/app/.env` 文件（`load_dotenv` 不覆盖已存在的环境变量）
- `run.py` 支持 `HOST` / `SSL_CERTFILE` / `SSL_KEYFILE` / `SSL_CA_CERTS` 环境变量覆盖

**方案 B: 本机运行**

```bash
cd frontend && npm run build          # 构建前端 → backend/static/
cd backend && .venv\Scripts\python run.py
```

`run.py` 启动双端口服务：

| 端口 | 协议 | 说明 |
|------|------|------|
| 8000 | HTTPS (CERT_NONE) | 登录页 + 静态 SPA，不请求客户端证书 |
| 8444 | HTTP | 应用入口，仅解析 `X-Client-Cert` 头识别身份，**须由 nginx 前置** |

> 8444 为纯 HTTP 端口，仅接受来自 TLS 终止组件的 `X-Client-Cert` 头，不能直接访问。本机完整部署 8443 mTLS 入口需同时运行本地 nginx（加载 `nginx/mtls.conf`，证书路径改为本机 `certs/`），或直接使用方案 A。

**部署前置条件**：

| 步骤 | 操作 | 用途 |
|------|------|------|
| 1 | 导入 `certs/ca.crt` 到浏览器受信任根证书 | 信任服务器证书，否则 TLS 握手中止 |
| 2 | 导入 `.p12` 客户端证书到个人存储 | 身份认证（密码 123456） |
| 3 | 配置 `ALLOWED_CERT_SUBJECTS` 白名单 | 空 = 允许所有证书；非空 = CN 精确匹配 |

### 14.3 证书管理（自建 CA）

项目使用自签 CA（`certs/ca.crt`，CN=JSCA-Root，10 年有效期）签发服务器与客户端证书，配置集中在 `certs/ca_openssl.cnf`（`policy_any`、数据库 `index.txt`、序列号 `ca.srl`、默认 3650 天）。

**服务器证书**：`server.crt`（SAN: `localhost` / `127.0.0.1`，不含 CRL 分发点 — CRL 机制已完全移除），由 nginx 与后端 8000 端口共用。签发方式：运行 `python gen_server.py`（修改脚本顶部 `SAN` 列表可加入实际访问 IP/域名后重签）。

**签发客户端证书**（CN 格式 `姓名 18位身份证号`）：

推荐直接修改 `certs/gen_clients.py` 的 `USERS` 列表后运行 `python gen_clients.py`——脚本已封装 Windows 下的编码处理（UTF-8 配置文件 + `req -utf8` + 吊销清理），并输出 `.crt` / `.key` / `.p12`（密码 `123456`，含 clientAuth EKU）。

手工签发步骤（Linux/容器内可直接用 `-subj` 传参）：

```bash
# ① 生成密钥与 CSR（CN 含中文时必须经 UTF-8 配置文件 + -utf8，见下方警告）
openssl genrsa -out client.key 2048
openssl req -new -utf8 -config client.cnf -key client.key -out client.csr
# client.cnf 内容: [ req ] distinguished_name=dn, prompt=no
#                 [ dn ] C=CN, ST=32, L=00, O=11, OU=00, CN=张三 320100199001010011

# ② CA 签发（clientAuth EKU 由 ca_openssl.cnf 的 client_ext 扩展段提供）
openssl ca -config ca_openssl.cnf -batch -notext -days 3650 -in client.csr -out client.crt

# ③ 导出浏览器可导入的 .p12
openssl pkcs12 -export -in client.crt -inkey client.key -out client.p12 -passout pass:123456
```

> ⚠️ **Windows 编码警告**：在 Windows 上不要用 `-subj "/CN=中文..."` 命令行传参——Git Bash 会把 `/C=` 当作路径转换，且 openssl 按 ANSI 代码页转换 argv，中文 CN 会双重编码损坏（实测表现为 `CN=ÖÜºâ`）。必须用 UTF-8 编码的配置文件 + `req -utf8` 标志。签发后可用 `openssl x509 -in client.crt -noout -subject -nameopt utf8` 核对 CN。

> CRL 吊销机制已完全移除（服务器证书不含 CRL 分发点、分发端点已删除）。如未来需要恢复，见 §12.3。

**第三方证书 / 国密 U-Key（CA 级信任，v2.1）**：

客户端证书不必由本项目 CA 签发。后端按 **CA 级信任** 验证签名（`openssl verify -no_check_time -partial_chain -CAfile certs/ca.crt`）：

- `certs/ca.crt` 现含 3 张信任证书：项目自签 CA、RootCA（江苏省 CA 根）、JSCA（中间 CA，2024-08-20 已过期）
- `-partial_chain`：链中任一证书命中信任列表即通过；`-no_check_time`：容忍 JSCA 过期；叶子有效期由 `checkend 0` 单独校验
- **信任语义**：RootCA/JSCA/项目 CA 签发的所有证书均可登录（身份 = CN）；伪造自签证书被拒
- 新增其他第三方 CA：把其根/中间证书（PEM）追加进 `certs/ca.crt` 即可，立即生效（每请求实时读取，bind mount 无需重启容器）
- ⚠️ `gen_server.py` 重新生成 CA 会覆盖 `ca.crt`，追加的第三方证书需重新追加

> 开发模式注意：`python -m app.main` 直连时 TLS 握手层（uvicorn）是标准链验证，过期中间 CA 的 Ukey 证书会在握手阶段失败——生产链路（nginx + 头验证）不受影响。

### 14.4 注意事项

- SQLite 在单进程下工作良好，多进程需考虑 WAL 模式
- 生产环境建议使用 PostgreSQL + pgvector 替换 SQLite 存储嵌入向量
- Docker 容器默认白名单为空（allow-all），需通过环境变量显式配置
- SHA-1 签名证书：`run.py` 已打 SSL 兼容补丁（`VERIFY_X509_PARTIAL_CHAIN` + 强制 TLS 1.2 + 显式套件），nginx 侧同样限制 TLS 1.2；Chrome/Edge 109+ 浏览器端不再支持 SHA-1 证书
- CRL 机制已完全移除（服务器证书不含 CRL 分发点、分发端点已删除）；证书泄露后需重签整套证书替换
- nginx `client_max_body_size 500m` 与后端 `MAX_UPLOAD_BYTES` (500MB) 对齐 —— 修改上传上限需两处同步（`nginx/mtls.conf` + `backend/app/utils.py`）

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
  "vite": "^5.4.19",
  "@vitejs/plugin-react": "^4.3.4"
}
```

## 附录 B: API 端点速查

```
GET    /api/health                         健康检查
GET    /api/auth/status                    证书认证状态 + 用户信息
GET    /api/auth/login                     登录跳转 (生产模式)
GET    /api/articles?category_id=&search=&tag=&skip=&limit=   文章列表
GET    /api/articles/:id                   文章详情
POST   /api/articles                       创建文章
PUT    /api/articles/:id                   更新文章
DELETE /api/articles/:id                   删除文章
GET    /api/articles/:id/download          下载附件
POST   /api/articles/:id/reprocess         重新解析全部附件
POST   /api/articles/:id/reprocess/:name   重新解析单个附件
POST   /api/articles/:id/recognize         重新解析文章文本内容
GET    /api/articles/:id/comments          评论列表
POST   /api/articles/:id/comments          创建评论 (支持附件)
PUT    /api/articles/:id/comments/:cid     更新评论
DELETE /api/articles/:id/comments/:cid     删除评论
POST   /api/articles/:id/comments/:cid/reprocess        重新解析评论内容
POST   /api/articles/:id/comments/:cid/reprocess/:name  重新解析评论单个附件
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
POST   /api/qa/parse-file                  解析上传文件为问答上下文
GET    /api/stats                          统计数据
POST   /api/upload                         文件上传
GET    /api/media/:filename                媒体文件直链
```

---

> 📝 本文档由 Claude Code 基于项目源码自动生成，最后更新于 2026-09-02。
