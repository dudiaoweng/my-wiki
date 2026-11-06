# 知识库系统 — 技术文档

> **版本**: 2.9 | **最后更新**: 2026-11-06 | **作者**: dudiaoweng

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

- 📄 **文章管理** — 创建、编辑、删除 Markdown 文章，支持目录和标签；仅创建人可编辑/删除
- 🗂️ **目录层级** — 目录可嵌套子目录；文章可挂载在目录下，也可挂载在其他文章下（同目录嵌套）；面包屑路径 全部/目录链/文章/子文章
- 💬 **文章评论** — 评论 CRUD，支持多附件、内容纳入智能问答；仅评论人可编辑/删除
- 🔐 **权限控制** — 基于身份证号的创建人验证，文章/评论/实体/目录均受保护
- 📤 **文件上传解析** — 支持 .txt / .md / .docx / .xlsx / .pptx / .pdf / 图片 / 音视频；文档文本异步提取（读取中→解析中两阶段），自动通过 LLM 提取标题、实体和关系（分段提取、逐段落库）
- 🔍 **搜索体系** — 顶部关键词即时搜索（数据库匹配）、侧边栏搜索结果树、高级搜索（时间范围/人员/关键词 × 与或非组合）；搜索结果作为文章列表展示的基础（目录分布、目录内筛选）
- 🗂️ **文章列表** — 分页（每页 10 篇）、组合排序（时间/标题·目录名/创建人 × 倒序/正序，目录与文章分别排序）、目录卡片（创建人/创建时间、修改/删除、拖拽移动）
- 🤖 **智能问答 (RAG)** — 最右侧面板与文章/实体窗口并排（窗口切换保活、数据不清理），多会话下拉框管理，多行输入框
- 🕸️ **知识图谱** — D3.js 力导向图，展示文章-目录-实体关系网络；实体列表⇄图谱联动、n 层展开/移除/撤销、关系增删改、图谱 JSON 打开/保存/截图与单独浏览模式
- 🏷️ **实体管理** — LLM 自动提取实体+关系（实体以「名称+类型」为标识，同名不同类型独立），实体列表动态加载（每批 20 条）；关联渐进加载（每批 10 条），支持方向切换与类型化对端选择
- 🧩 **Prompt 可配置** — 所有提示词以 txt 文件存于 `prompts/` 目录，可独立编辑，重启生效（Docker 挂载）
- 📱 **响应式设计** — 桌面端多栏布局，移动端按内容高度自适应

### 1.1 项目结构总览

```
my-wiki/
├── data/                        # 数据统一目录（本地开发与 Docker 共用，已 gitignore）
│   ├── knowledge_base.db        #   SQLite 数据库
│   ├── uploads/                 #   上传文件
│   ├── qdrant/                  #   Qdrant 向量数据（compose 卷）
│   └── neo4j/                   #   Neo4j 图数据（compose 卷）
├── backend/                     # Python FastAPI 后端
│   ├── run.py                   # 生产入口：双端口服务 (8000/8444) + SSL 兼容补丁
│   ├── .env                     # 环境变量 — 仓库根目录 .env（config.py 显式加载）
│   ├── requirements.txt         # Python 依赖
│   ├── rebuild_chunks.py        # 一次性全量重建分块（改 MAX_CHUNK_CHARS 后执行）
│   ├── static/                  # 前端构建产物 (生产模式, vite outDir)
│   └── app/
│       ├── main.py              # FastAPI 应用工厂、路由注册、种子数据
│       ├── database.py          # SQLAlchemy 引擎、会话、表创建、迁移
│       ├── dependencies.py      # FastAPI 依赖注入 (get_db)
│       ├── models.py            # ORM 模型 (Category, Article, ArticleChunk, EntityInfo, Comment)
│       ├── schemas.py           # Pydantic 请求/响应模型（含高级搜索条件）
│       ├── config.py            # 集中化配置：LLM/Vision/ASR/Embedding/QA/TLS/PROMPTS_DIR (环境变量)
│       ├── auth.py              # mTLS 身份：签名验证 (openssl verify) + CN 解析（peercert 直连 / nginx X-Client-Cert 头双模式）
│       ├── prompts.py           # LLM 提示词：内置默认 + prompts/*.txt 可配置覆盖
│       ├── llm_extract.py       # 共享 LLM 标签+实体提取 (统一超时/重试/容错)
│       ├── utils.py             # 共享工具函数 (find_ffmpeg 等)
│       └── routes/
│           ├── articles.py      # 文章 CRUD + 分页搜索 + 计数 + 高级搜索 + 附件重解析
│           ├── categories.py    # 目录 CRUD + 移动 + 递归文章数
│           ├── comments.py      # 评论 CRUD + 附件上传 + LLM 增强
│           ├── tags.py          # 标签管理 (添加/重命名/删除)
│           ├── entities.py      # 实体管理 + 附加信息 CRUD + 嵌入重算
│           ├── graph.py         # 知识图谱数据构建
│           ├── qa.py            # RAG 问答管道
│           ├── stats.py         # 仪表盘统计
│           └── upload.py        # 文件上传 + LLM 实体提取
│
├── prompts/                     # Prompt 配置目录（每个提示词一个 .txt，见 README.md）
├── dist/                        # 发布物目录（镜像 tar 包、数据库升级脚本）
│   └── upgrade_db.py            # 数据库升级脚本（补列/建索引/清旧列，幂等）
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
│       │   ├── EntityPanel.tsx  # 实体面板 (实体/关系编辑列表 + 知识图谱双模式)
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
├── docker-compose.yml           # 四容器编排 (my-wiki + qdrant + neo4j + nginx)
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
| **SQLite** | 3.x | 嵌入式数据库（文章/评论/分块/附加信息真相源） |
| **Qdrant** | 1.19.1 | 向量数据库（语义检索索引，见 §9.1） |
| **qdrant-client** | 1.19.0 | Qdrant Python 异步客户端 |
| **Neo4j** | 5.26 LTS | 图数据库（实体/关系唯一存储，见 §4.2） |
| **neo4j** | 5.26.0 | Neo4j Python 驱动（sync + async 双 driver） |
| **httpx** | 0.28.1 | 异步 HTTP 客户端 (LLM API 调用) |
| **python-multipart** | — | 文件上传解析 |
| **python-docx** | — | Word 文档解析 |
| **openpyxl** | — | Excel 文档解析 |
| **python-pptx** | — | PowerPoint 文档解析 |
| **PyPDF2** | — | PDF 文档解析 |
| **python-dotenv** | — | 环境变量加载 |
| **nginx** | 1.25 | 反向代理：mTLS TLS 终止 (`optional_no_ca`) |
| **Docker** | — | 容器化部署 (docker compose 四容器) |

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

### 2.4 外部基础设施服务

| 服务 | 用途 | 配置前缀 | 说明 |
|------|------|---------|------|
| **Qdrant** | 向量检索（语义搜索） | `QDRANT_` | 统一在 `.env` 配置：Docker 部署 `http://qdrant:6333`（compose 网络服务名）；本地开发 `http://localhost:6333`。SQLite 保存分块元数据（真相源），Qdrant 为向量唯一存储与检索索引（详见 §9.1） |
| **Neo4j** | 实体/关系图存储（唯一存储） | `NEO4J_` | 统一在 `.env` 配置：Docker 部署 `bolt://neo4j:7687`（compose 网络服务名）；本地开发 `bolt://localhost:7687`。实体节点/提及边/关系边只存 Neo4j（详见 §4.2）；密码 `NEO4J_PASSWORD` 仅数据卷首次初始化时生效 |

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
│  │  │  MW      │ │ (seed)   │ │ (data/uploads)     │   │  │
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
│ parent_id    │  │    │ category_id (FK,IDX) │◄─┘    │   CASCADE)   │
│   (FK 自引用, │◄─┘    │   → Category         │       │ chunk_index  │
│    IDX)      │       │ parent_id            │       │ chunk_text   │
└──────────────┘       │   (FK 自引用, IDX)   │       └──────────────┘
                       │ tags (JSON TEXT)     │       ┌──────────────┐
                       │ created_at           │       │ EntityInfo   │
                       │ updated_at (IDX)     │       ├──────────────┤
                       │ attachment_path      │       │ id (PK)      │
                       │ attachment_name      │       │ entity_name  │
                       │ attachment_type      │       │   (IDX)      │
                       └──────────────────────┘       │ name         │
                                                      │ content      │
                                                      │ created_at   │
                                                      │ updated_at   │
                                                      └──────────────┘

实体与关系不在此图中——v2.3 起由 Neo4j 存储（见 4.2 存储架构说明）。
```

### 4.2 表结构详解

#### `categories` — 目录（文章分类）

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 目录唯一标识 |
| `name` | VARCHAR(100) | UNIQUE, NOT NULL | 目录名称 |
| `color` | VARCHAR(7) | NOT NULL | 十六进制颜色 (如 `#1E5C8A`) |
| `parent_id` | VARCHAR(36) | FK 自引用, NULLABLE, INDEX | 上级目录（空 = 顶级目录；**v2.6 子目录**，无环由应用层保证） |
| `created_by` | VARCHAR(200) | NULLABLE | 创建人 (证书 CN) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL | 更新时间 (UTC) |

#### `articles` — 文章

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 文章唯一标识 |
| `title` | VARCHAR(200) | NOT NULL | 文章标题 |
| `content` | TEXT | NOT NULL, DEFAULT "" | Markdown 内容 |
| `category_id` | VARCHAR(36) | FK→categories, ON DELETE SET NULL, INDEX | 所属目录（**v2.4 起必填**：创建/上传时缺省返回 400「文章必须选择目录」；编辑不可置空） |
| `parent_id` | VARCHAR(36) | FK 自引用, NULLABLE, INDEX | 父文章（**v2.5 文章层级**：空 = 直接挂在目录下；同目录 + 无环由应用层保证） |
| `tags` | TEXT | NOT NULL, DEFAULT "[]" | 手动标签 (JSON 数组) |
| `processing` | TEXT | NULLABLE | 后台解析状态标志 |
| `created_by` / `updated_by` | VARCHAR(200) | NULLABLE | 创建人/更新人 (证书 CN) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL, INDEX | 更新时间 (UTC) |
| `attachment_path` | VARCHAR | NULLABLE | 上传文件路径 |
| `attachment_name` | VARCHAR | NULLABLE | 原始文件名 |
| `attachment_type` | VARCHAR | NULLABLE | 文件类型 |

> v2.3 起无 `entities` 列：实体与关系迁移至 Neo4j（见下方「Neo4j 存储架构」）。

**Neo4j 存储架构（v2.3）**——实体/关系的唯一存储：

```
(a:Article {id})                          -- 仅作 MENTIONS 边源；标题等元数据仍在 SQLite
(e:Entity {name, type, created_by, created_at})
(a)-[:MENTIONS {source}]->(e)             -- source: 'body' | 'comment:<评论id>'
(e1)-[:RELATES {label, article_id, source, deleted?}]->(e2)
```

- **实体身份规则**：实体以「名称+类型」为标识（`entity:{name}::{type}`），同名不同类型是两个节点；`(name,type)` 建普通索引而非唯一约束（改名/改类型可产生合法重复，读路径按 `(name,type)` 去重、created_at 最早者胜）
- **出处溯源**：MENTIONS/RELATES 边携带 `source` 属性（`'body'` 或 `'comment:<id>'`），评论删除/重新解析时按 source 精确删边（旧版 JSON 按三元组减法可能误删正文关系）；关系边另带 `article_id` 支持附件重解析的覆盖语义
- **手工关系（manual）**：实体面板新增/修改（改名/换向/换对端）产生的关系标记 `source='manual'`；`ON MATCH` 会把已存在的自动抽取边升级为 manual。`replace_article_mentions` 只删对应 `source` 的边，因此重新识别/重新上传不会冲掉手工关系
- **删除墓碑（deleted）**：删除关系不物理删除，而是 `SET r.deleted=true, r.source='deleted'`；`_Q_MERGE_RELATIONS` 在重新抽取时按「同 label + article_id + 任一端点方向」跳过墓碑，防止删除后的关系（含反向重抽取）复活；手工重新添加会清除墓碑。所有读取/图谱/文章组装查询均过滤 `deleted=true` 的边
- **关系写规则**：`POST/PUT/DELETE /api/entities/relations` 必须提供 `article_ids`、两端明确类型和 `owner`（权限主体必须是关系端点）；修改只作用于旧关系实际存在的文章，新对端无法共同出现的文章保留原关系并计入 `skipped`；仅改关系名走原地 SET + 旧名墓碑，仅换方向走向重建边
- **类型化权限**：实体修改/关系写入按 `(name, type)` 查创建人与提及文章创建人；同名不同类型的实体不共享权限主体（`owner_type` 精确匹配端点类型）
- **孤儿 GC**：每次删边后执行「无 MENTIONS 的实体节点 DETACH DELETE」——保持"实体存在 = 至少被一篇文章提及"语义
- **悬空 GC 护栏**：启动清理引用已删除文章/评论的边；若 Neo4j 与 SQLite 的文章 id 不相交（不含固定种子 a1-a5），视为连错库并跳过清理（2026-09-30 存储统一过渡期曾因无此护栏清空过图）
- **熔断降级（v2.4）**：Neo4j 连接级故障后 30 秒内所有调用快速失败（避免每次读路径等满 10s 超时拖垮线程池），任何操作成功即复位
- **接口组装**：文章/评论接口的 `entities` 字段由 `neo4j_store.get_entities_for_articles_sync` / `get_comment_entities_sync` 批量 Cypher 组装（挂 ORM 临时属性直通 Pydantic），Neo4j 不可用时降级 `entities=null`（前端容忍）
- **启动懒迁移**：`migrate_and_drop_columns()` 在 lifespan 中 fire-and-forget——Neo4j 连不上重试 5×30s 后放弃（列保留、下次启动重试）；连通后把旧 `articles.entities`/`comments.entities` JSON（原生 SQL 读取）加载进 Neo4j，**加载完成后才执行 DROP COLUMN**；每次启动还做悬空 GC（引用已删除文章/评论的边清理）。此后 SQLite 无实体来源，写路径严格（重试 3 次后报错），与 Qdrant 的 best-effort 不同
- **保留在 SQLite 的部分**：`entity_infos` 附加信息、chunk_text 中的 `[实体: …]`/`[实体信息: …]` 行（向量检索桥，与 Neo4j 无关）。QA 来源卡片的实体 chips 由 Neo4j 实体名与命中块文本子串匹配**即时派生**（v2.3 起，无块级快照列）

#### `article_chunks` — 文章分块 (用于语义搜索)

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 分块唯一标识 |
| `article_id` | VARCHAR(36) | FK→articles, ON DELETE CASCADE, INDEX | 所属文章 |
| `chunk_index` | VARCHAR | NOT NULL | 分块序号 (如 "0", "1") |
| `chunk_text` | TEXT | NOT NULL | 分块文本内容 |

> v2.3 起无 `entities` 列：块级实体标注快照已移除（改名不传播、重新分块即丢），QA 来源卡片的实体 chips 由 Neo4j 实体名与 chunk_text 子串匹配即时派生。

> v2.2 起无 `embedding` 列：向量只存 Qdrant（point id = 分块 id，payload 含 article_id/chunk_index/chunk_text）。旧库由 `init_db()` 迁移执行 `ALTER TABLE article_chunks DROP COLUMN embedding` 删除。

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

> 附加信息以 `entity_name` 为键，同名不同类型共享；实体类型化重命名时，仅当旧名称下已无其他类型变体才级联更新 `entity_name`。

#### `comments` — 文章评论 (v1.3 新增)

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | VARCHAR(36) | PK, UUID | 评论唯一标识 |
| `article_id` | VARCHAR(36) | FK→articles, ON DELETE CASCADE, INDEX | 所属文章 |
| `content` | TEXT | NOT NULL, DEFAULT "" | 评论内容 (Markdown + 媒体标签) |
| `tags` | TEXT | NOT NULL, DEFAULT "[]" | 标签 (JSON 数组) |
| `attachments` | TEXT | NULLABLE | 附件列表 (JSON: [{path, name, type}]) |
| `processing` | TEXT | NULLABLE | "processing" 或 NULL (完成) |
| `created_by` | VARCHAR(200) | NOT NULL, DEFAULT "" | 创建人 (证书 CN) |
| `updated_by` | VARCHAR(200) | NOT NULL, DEFAULT "" | 更新人 (证书 CN) |
| `created_at` | DATETIME | NOT NULL | 创建时间 (UTC) |
| `updated_at` | DATETIME | NOT NULL | 更新时间 (UTC) |

### 4.3 索引策略

| 表 | 索引列 | 原因 |
|----|--------|------|
| articles | `category_id` | 按目录筛选是最常用操作 |
| articles | `updated_at` | 文章列表默认按更新时间排序 |
| articles | `parent_id` | 子文章树批量构建（v2.5 层级） |
| categories | `parent_id` | 子目录树构建与子树递归筛选 |
| article_chunks | `article_id` | 按文章查询分块是主访问路径 |
| entity_infos | `entity_name` | 按实体名查询附加信息 |

> 存量库补列后可能缺少 `parent_id` 索引——用 `dist/upgrade_db.py` 补齐（见 §13.5）。

---

## 5. 后端 API 设计

### 5.1 路由总览

| 前缀 | 文件 | 端点 | 方法 | 说明 |
|------|------|------|------|------|
| `/api/articles` | `routes/articles.py` | `/` | GET | 文章列表 (分页/搜索/筛选) |
| | | `/count` | GET | 文章计数（分页总数，过滤条件与列表一致） |
| | | `/facets` | GET | 搜索结果目录分布（可传 category_id 收窄到子树） |
| | | `/search` | POST | 高级搜索（时间/人员/标签/关键词/目录 × 与或非组合） |
| | | `/{id}` | GET | 文章详情 |
| | | `/` | POST | 创建文章 |
| | | `/{id}` | PUT | 更新文章 |
| | | `/{id}` | DELETE | 删除文章 |
| | | `/{id}/move` | POST | 拖拽移动文章（换目录/换父文章，创建人 only） |
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
| `/api/categories` | `routes/categories.py` | `/` | GET | 目录列表 |
| | | `/article-counts` | GET | 每个目录的递归文章数（含子目录，目录卡片徽章用） |
| | | `/` | POST | 创建目录 |
| | | `/{id}` | PUT | 更新目录 |
| | | `/{id}/move` | POST | 拖拽移动目录（换上级目录，创建人 only） |
| | | `/{id}` | DELETE | 删除目录（有子目录/文章时 409） |
| `/api/tags` | `routes/tags.py` | `/` | GET | 标签列表 |
| | | `/` | POST | 添加标签 |
| | | `/rename` | PUT | 重命名标签 |
| | | `/remove` | POST | 删除标签 |
| | | `/by-article` | GET | 按文章分组标签 |
| `/api/entities` | `routes/entities.py` | `/` | GET | 实体列表 |
| | | `/` | POST | 添加实体 |
| | | `/update` | PUT | 更新实体（`old_type` 可限定类型变体） |
| | | `/rename` | PUT | 重命名实体（`old_type` 可限定类型变体） |
| | | `/remove` | DELETE | 删除实体（`entity_type` 可限定类型变体） |
| | | `/relations/query` | POST | 查询实体关系（可按实体类型/文章范围过滤） |
| | | `/relations` | POST | 新增实体关系（owner + 两端类型 + article_ids 必填） |
| | | `/relations` | PUT | 修改实体关系（改名/换向/换对端，只改旧边存在的文章） |
| | | `/relations` | DELETE | 删除实体关系（软删除墓碑，防重新抽取复活） |
| | | `/{name}/info` | GET | 实体附加信息列表 |
| | | `/{name}/info` | POST | 创建实体附加信息 |
| | | `/{name}/info/{id}` | PUT | 更新实体附加信息 |
| | | `/{name}/info/{id}` | DELETE | 删除实体附加信息 |
| `/api/graph` | `routes/graph.py` | `/` | GET | 知识图谱数据 |
| | | `/expand` | GET | 按节点 id 展开 n 层邻域（1–5 层） |
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
| `category_id` | string | 按目录 UUID 筛选（搜索/标签组合时匹配整个目录子树） |
| `parent_id` | string | 按父文章筛选（子文章树加载） |
| `search` | string | 按标题+内容搜索 (ILIKE) |
| `title` | string | 仅标题匹配（位置选择器筛选框） |
| `tag` | string | 按标签筛选 (JSON 子串匹配) |
| `root_only` | bool | 仅顶级文章（层级浏览模式） |
| `skip` | int | 分页偏移 (默认 0) |
| `limit` | int | 每页数量 (默认 200, 最大 200) |

**响应:** `ArticleResponse[]`

#### POST /api/articles/search — 高级搜索（v2.7）

**请求:** `{ "conditions": AdvancedSearchCondition[] }`，条件按 `connector`（and/or）依次组合、`negated` 取反：

| 条件 type | 值 | 说明 |
|-----------|-----|------|
| `keyword` | value | 标题+正文 ILIKE |
| `person` | value | 创建人 ILIKE |
| `tag` | value | 标签精确匹配 |
| `time` | start/end | 更新时间范围（ISO 日期，可只填一端，结束日含当天） |
| `category` | value | 目录子树匹配（前端目录筛选用） |

**响应:** `{ total, items: ArticleListItem[] }`（分页参数 skip/limit 同列表接口）。

#### GET /api/articles/count / GET /api/categories/article-counts

- `/count`：文章总数（分页用），过滤条件与列表接口一致
- `/article-counts`：每个目录的递归文章数（含所有子目录），返回 `{category_id: count}`

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

> `sources[].entities` 由 Neo4j 实体名与命中块文本（含 `[实体: …]` 标签行）子串匹配即时派生（`_entities_in_chunk`），前端在来源卡片显示实体 chips——永远与图谱一致，无快照过时问题。

**降级策略:** 如果 LLM API 不可用，使用关键词匹配 (`fallback_keyword_search`) 生成摘要式回答。

#### POST /api/upload — 文件上传

**请求:** `multipart/form-data`
| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 上传文件 |
| `category_id` | string | 目标分类 UUID（**v2.4 起必填**，缺失返回 400「文章必须选择分类」；校验前置在文件写盘之前） |

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
| `category:` | category | 文章分类 | 方框（图标 + 目录名，宽度自适应） |
| `article:` | article | 文章 | 方框（图标 + 标题，宽度 80–200px） |
| `entity:` | entity | LLM 提取的实体（节点 id = `entity:{名称}::{类型}`） | 圆形图标按类型，标签只显示名称 |

**边类型:**
| 标签 | 源→目标 | 说明 |
|------|---------|------|
| `"属于"` | article → category | 文章归属分类 |
| `"提及"` | article → entity | 文章提及实体 |
| `(自定义)` | entity → entity | 实体间关系 (LLM 提取 + 手工编辑；读取端按两端+关系名去重) |

**安全限制:** 最多 2000 个节点，防止图谱过于庞大；超出时同步过滤端点被截断的边。

#### GET /api/graph/expand — n 层邻域展开

| 参数 | 类型 | 说明 |
|------|------|------|
| `node_id` | string | `article:{id}` 或 `entity:{name}::{type}`；目录节点返回空图 |
| `depth` | int | 1–5，默认 1 |

- Neo4j 直查，不受 `/api/graph` 2000 节点上限影响
- 节点查询 `WITH n0, x LIMIT 1200`、关系查询 `WITH r LIMIT 5000`（路径级限流，再 UNWIND/DISTINCT），防止稠密图指数级路径枚举
- 返回前过滤 `deleted=true` 的关系、端点缺失的边，以及只能经墓碑边到达的孤立节点；起点节点始终保留
- 文章节点标题仍从 SQLite 组装

#### POST /api/entities/relations/query — 查询实体关系

```json
{
  "entity_name": "张三",
  "entity_type": "人物",
  "article_ids": ["article-id-1", "article-id-2"]
}
```
- 返回聚合后的 `EntityRelation[]`：`source_name/source_type/target_name/target_type/label/article_ids`
- `article_ids` 为空 = 全部文章（仅查询语义）；`entity_type` 为空字符串表示精确匹配空类型，`null` 才是不限类型

#### POST /api/entities/relations — 新增关系

```json
{
  "owner_name": "张三",
  "owner_type": "人物",
  "source_name": "张三",
  "source_type": "人物",
  "target_name": "李四",
  "target_type": "人物",
  "label": "同事",
  "article_ids": ["article-id-1"]
}
```
- `article_ids` **必填**（关系按文章存储，禁止“全部文章”写入）
- `owner` 必须是关系的一端；权限按 `(owner_name, owner_type)` 校验（创建人或提及文章创建人）
- 两端类型必须明确（空字符串是合法类型）；对端必须与本端在范围内文章共同被提及
- 已存在同名同类型关系时升级为 `source='manual'`

#### PUT /api/entities/relations — 修改关系

```json
{
  "owner_name": "张三", "owner_type": "人物",
  "source_name": "张三", "source_type": "人物",
  "target_name": "李四", "target_type": "人物",
  "old_label": "同事",
  "new_source_name": "张三", "new_source_type": "人物",
  "new_target_name": "王五", "new_target_type": "人物",
  "new_label": "朋友",
  "article_ids": ["article-id-1", "article-id-2"]
}
```
- 只改关系名：原地 `SET label` 并提升为 `source='manual'`，同时写入旧名墓碑（改名后重新抽取不会还原旧名）
- 仅换方向：在旧边所在文章内反向建边（要求两端集合不变）
- 换对端：只在「旧边存在且新对端也能成立」的文章替换；其余文章保留原关系，响应 `{updated, skipped}`
- 响应 `updated` = 实际处理数量（换对端时为文章数，改名时为边数），`skipped` = 保留原关系的文章数（仅换对端时可能非 0）

#### DELETE /api/entities/relations — 删除关系

```json
{
  "owner_name": "张三", "owner_type": "人物",
  "source_name": "张三", "source_type": "人物",
  "target_name": "李四", "target_type": "人物",
  "label": "同事",
  "article_ids": ["article-id-1"]
}
```
- 软删除：边保留为 `deleted=true, source='deleted'` 墓碑
- 重新抽取/重新上传会跳过墓碑（无向匹配，反向也不会复活）；手工重新添加会清除墓碑
- `article_ids` 必填，owner 必须是关系端点

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
    <AppProvider>          ← 全局 UI 状态 (侧边栏/编辑器/确认框/高级搜索/拖拽/问答面板开关)
      <ReadingProgress />  ← 文章阅读进度条 (全局)
      <Routes>
        <Route element={<Layout />}>   ← TopBar + Sidebar + <KeepAliveOutlet/>
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

**窗口保活（KeepAliveOutlet，v2.8）**：`Layout` 的主区出口由 `<Outlet/>` 替换为 `<KeepAliveOutlet/>`——首页/文章列表/文章详情/智能问答四个窗口首次渲染后**保持挂载**（`display:none` 隐藏），隐藏期间用冻结的路由上下文快照（`UNSAFE_LocationContext` / `UNSAFE_NavigationContext` / `UNSAFE_RouteContext`）包裹，URL 变化不影响隐藏窗口内部状态；重新激活时恢复实时上下文且元素引用不变（React 直接跳过重渲染）。侧边栏同样保活（`FrozenRouter` 冻结）。窗口切换（智能问答 ⇄ 文章）**不卸载、数据不清理**——筛选、分页、选中、问答输入等原样保留。

**智能问答面板（v2.8）**：🤖 按钮切换 `qaOpen` 开关——开启时主区变为并排布局 `[活动窗口][问答面板 460px]`（`KeepAliveOutlet` 的 split 模式），问答面板与文章/实体窗口同时可见；窗口容器在两种模式保持同一树位置（仅切换 className），开关面板不触发其他窗口重挂。

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
  getArticles, getArticlesCount, getSearchFacets, advancedSearchArticles,
  getArticle, createArticle, updateArticle, deleteArticle, moveArticle,
  getCategories, createCategory, updateCategory, deleteCategory, moveCategory,
  getCategoryArticleCounts,
  getTags, addTag, renameTag, removeTag, getTagsByArticle,
  addEntity, updateEntity, renameEntity, removeEntity,
  queryEntityRelations, createEntityRelation, updateEntityRelation, deleteEntityRelation,
  getEntityInfos, createEntityInfo, updateEntityInfo, deleteEntityInfo,
  getGraphData, expandGraph,
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
| `/articles` | `ArticleList` | 文章列表: 目录卡片 + 文章卡片 + 实体面板（分页/排序/筛选） |
| `/articles?view=:id` | `ArticleList` → `ArticleDetailInline` | 文章列表 + 内联详情 + 实体面板 |
| `/articles?search=…` | `ArticleList`（搜索结果视图） | 搜索结果根目录视图 / 目录内筛选，侧边栏同步搜索树 |
| `/articles?adv=1` | `ArticleList`（高级搜索结果） | 高级搜索条件存于 AppProvider 上下文，处理与搜索一致 |
| `/articles/:id` | `ArticleDetail` | 文章详情独立页 (从知识图谱导航而来) |
| `/qa` | `QA` | 智能问答窗口（最右侧面板样式）；`qaOpen` 开关时与文章窗口并排 |

### 7.2 组件通信

```
AppProvider (Context)
  ├── sidebarOpen, toggleSidebar, sidebarCollapsed ← 侧边栏抽屉/桌面缩进
  ├── editorState, openEditor, closeEditor
  ├── confirmState, requestConfirm
  ├── uploaderOpen, openUploader, closeUploader
  ├── articleVersion / categoriesVersion         ← 全局刷新信号
  ├── advancedSearch / advCategoryId             ← 高级搜索条件（列表 adv 模式取数）
  ├── qaOpen                                     ← 智能问答面板开关（并排显示）
  ├── dragRef / dropTarget / startDrag / ...     ← 跨组件拖拽（侧边栏 ⇄ 文章列表）
  └── searchInputRef                             ← 跨组件聚焦搜索框

ArticleList
  ├── 读取 URL params: category, search, tag, view, adv
  ├── 目录卡片 (DirCard)：创建人/创建时间 + 修改/删除 + 拖拽（权限同侧边栏）
  ├── 传递给 EntityPanel: entities (LLM实体), selectedArticleIds, articles
  └── 接收 EntityPanel 回调: onGraphNodeClick（图谱多选 id 集合）、onEntitySelect（实体→文章筛选）、onClearAllSelections

Sidebar（与文章列表共享拖拽状态）
  ├── 浏览模式目录树（分批加载、手风琴展开、目录/文章拖拽）
  ├── 搜索/高级搜索模式结果树（目录可收缩、全部按钮承载全部结果+数量）
  └── 全部按钮：搜索时保留 ?search= / ?adv=1

EntityPanel
  ├── 双模式: list (LLM实体列表+附加信息，动态加载每批 20 条) / graph (实体列表 + D3 知识图谱分栏)
  ├── 从 ArticleList 接收选中的文章 ID（关联查询/写入的文章范围）
  ├── 图谱节点点击：实体节点联动实体列表行 + 信息面板；文章/目录节点仅图谱内高亮（不筛选文章列表）
  ├── 图操作：展开 n 层 / 移除 / 撤销；图谱文件新建/打开/保存/截图；打开/新建进入单独浏览模式
  └── 实体点击 → 附加信息 + 关联信息面板（关联渐进加载 10/批，可增删改）

QA
  ├── 会话下拉框切换与管理（localStorage 持久化）
  └── 多行输入框（默认两行自动拉伸）+ 框内发送图标
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

### 8.5 实体关系编辑流程

```
实体列表/图谱选中实体
  → 信息面板 POST /api/entities/relations/query（article_ids = selectedArticleIds，渐进 10 条）
  → 新增：RelationTargetPicker 仅列当前文章实体（名称+类型，可筛选）
     提交 owner/source/target + 两端类型 + label + article_ids
  → 修改：可改关系名、方向、对端
     后端先查旧边实际存在的文章 → 只在这些文章删旧建新
     旧边存在但新对端不成立的文章保留原关系，响应 skipped → 前端提示
  → 删除：软删除墓碑（deleted=true），重新抽取不会复活
  → 成功后重新查询关联 + refetchGraph（画布增量更新，不重排版）
```

单独浏览模式下不调用 API：上述增删改直接作用于 `workingGraph.edges`，并写入撤销历史；不做权限校验。

---

## 9. 关键功能详解

### 9.1 RAG 问答管道 (`qa.py`)

#### 文本分块策略

```python
def chunk_article(content: str) -> list[str]:
    # 0. 移除 HTML 注释 (<!-- doc-attachment --> 等附件标记是元数据, 不产生分块)
    # 1. 按 Markdown 标题分割 (##, ###)（标题边界不重叠）
    # 2. 长段落按双换行分割
    # 3. 超长段落按单换行分割
    # 4. 超长行按字符数硬截断 (MAX_CHUNK_CHARS，.env 可配置，默认 512)
    # 5. 滑动重叠 (CHUNK_OVERLAP，.env 可配置，默认 100)：基础切分按
    #    MAX_CHUNK_CHARS - OVERLAP 进行，块 i 开头前置块 i-1 尾部 OVERLAP 字符
    # 保证每块不超过 MAX_CHUNK_CHARS；重叠只作用于段内（不跨标题边界）
```

分块参数均可在 `.env` 配置：`MAX_CHUNK_CHARS`（默认 512）、`CHUNK_OVERLAP`（默认 100）。改动后需执行 `backend/rebuild_chunks.py` 一次性全量重建存量分块（旧分块保持旧粒度，新旧并存的检索质量会不一致）。

#### 词嵌入生成

```python
async def get_embedding(text: str) -> list[float]:
    # POST {base}/embeddings
    # 模型: embedding-3（云端）/ bge-m3-Q4_K_M（本地 llama-server）
    # 文本截断 2000 字符（问题上限；分块本身 ≤ 512）
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
        # 3. force=True 时删除旧 chunk 重新计算全部（先清 Qdrant 点）
        # 4. 每篇文章 commit 后同步 upsert 到 Qdrant（best-effort）
```

**Qdrant 存储架构（v2.2）**：SQLite（`article_chunks` 表）保存**分块文本**（chunk_text）作为真相源；**向量只存 Qdrant**——point id = 分块 uuid，payload = `{article_id, chunk_index, chunk_text}`。所有写入路径（`embed_chunk_rows` / `ensure_embeddings` / 评论重建 / 实体标签重嵌入）计算向量后直接 upsert；删除路径（文章/评论删除、分块重建）同步删点或经线程池调度删除；Qdrant 掉线时写入只 log 不阻塞（缺失的分块由下次启动同步重算补齐），检索则直接失败（见下）。`init_db()` 迁移已对旧库执行 `DROP COLUMN embedding`。

**启动同步（`sync_qdrant`）**：lifespan 中 fire-and-forget（幂等，双 uvicorn 只跑一次），Qdrant 连不上时重试 5×30s 后放弃、服务器照常启动。流程：集合就绪（维度按 `QDRANT_VECTOR_SIZE`，与嵌入模型实际输出不符时以首个新向量自动纠正重建）→ `ensure_embeddings` 建缺失分块 → 持锁差异同步（**DB 有而 Qdrant 无的分块 → 重算嵌入并 upsert**——Qdrant 卷丢失/集合重建时本步自动全量重建；Qdrant 有而 DB 无 → 孤儿清理）。中断后重启再次执行同一差集，已 upsert 的分块不重算，天然幂等。

#### 语义搜索（Qdrant）

```python
async def semantic_search(db, question, top_k=5) -> list[tuple[float, Article, ArticleChunk | None]]:
    # 1. ensure_embeddings(db)  — 新文章首次问答时懒建分块
    # 2. q_embedding = get_embedding(question)  — 失败抛 EmbeddingError
    # 3. vector_store.search(q_embedding, limit=50)  — Qdrant query_points
    #    (Cosine 距离下 score 即相似度，越大越相关)
    # 4. 按 point id 回查 ArticleChunk 行 —— 跳过 DB 已删的陈旧点（兜底），
    #    每文章取最高分块去重，取 top_k
    # 返回值携带命中的分块行 (chunk) —— QASource.entities 由 Neo4j 实体名与块文本派生
    # 标注，前端在来源卡片显示实体 chips
```

**失败语义（完全依赖 Qdrant）**：不再有 SQLite 暴力比对 / 关键词兜底。Qdrant 不可用 → `VectorStoreError` → 问答返回「知识库向量检索服务（Qdrant）当前不可用…」；嵌入模型失败 → 「嵌入模型调用失败…」。写入路径不受影响（best-effort），下次启动同步补差。

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

### 9.2 文件上传解析

| 文件类型 | 解析方式 | 备注 |
|---------|---------|------|
| `.txt`, `.md`, 代码文件 | 编码检测后解码：BOM（utf-8-sig/utf-16）→ 严格 UTF-8 → 严格 GB18030（GBK/GB2312 超集）→ UTF-8 容错替换 | 文本类（Windows GBK 文件不再乱码） |
| `.docx` | `python-docx` → **结构感知提取**（段落样式/字号 → markdown 标题、表格 → markdown 表格，按文档流保序） | Word 文档 |
| `.xlsx` | `openpyxl` → 遍历所有工作表 | Excel 表格 |
| `.pptx` | `python-pptx` → 提取幻灯片文本 | PowerPoint |
| `.pdf` | `PyPDF2` → 逐页提取文本 | PDF 文档 |
| 图片 (`.jpg/.png/.gif/.webp` 等) | base64 → 视觉模型描述 | 图片转文字 |
| 音频 (`.mp3/.wav/.m4a/.flac` 等) | ffmpeg/wave 转单声道 16kHz WAV → ASR 模型转录 | 语音转文字 |
| 视频 (`.mp4/.avi/.mov/.mkv` 等) | OpenCV 提取 5 帧 → 视觉模型描述 | 视频内容识别 |

**公文/法律文本结构 → markdown（v2.5，规则转换）**：文档文本提取（上传/附件重解析/评论附件）与**文章编辑框内容**（create/update 入库前）统一过 `to_markdown()`：
- 公文编号层级转标题：`一、`→`##`、`（一）`→`###`、`1.`/`1、`→`####`、`（1）`→`#####`；句读结尾的编号行做**内嵌标题拆分**——首个句号前 ≤30 字为标题、其余作正文（公文格式「（一）小标题。正文……」），句号靠后则整行作标题（如「1.编制……规范要求。」三级项）
- 法律结构：`《法律名称》`→`#`、`第X章`→`##`、`第X条`→`###`（条为基本单元，内容以句号结尾仍转标题）；条内 `（一）`/`1.`/`（1）` 层级顺延一级（####/#####/######）——法律模式一经触发保持全文生效（条项之间常有空行）
- **纯文本标题识别**（txt/pdf 无样式信息）：全文检测到公文/法律结构特征时，首行短行（2-40 字、非句读结尾、非发文字号、非数字开头）转 `#` 标题；无结构特征的普通文本（代码/笔记）不触发，避免误转
- 正文**一字不改**（保真优先，不用 LLM 转换）；已是 markdown 的行不动（幂等）
- docx 另有样式感知：Heading/标题 N 样式或 ≥18pt 字号（公文正文三号 16pt 不误判）→ 标题；表格转 markdown 表格（旧版丢弃表格）
- 收益：公文/法律渲染出正确层级，且按标题切分的分块策略（§9.1）切出语义更完整的段落——法律条文按「条」切块，问答可直接定位到具体条款

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

**数据来源（v2.3）**：`GET /api/graph` 混合组装——文章/分类节点来自 SQLite（标题/颜色），实体节点 + 提及边 + 关系边由 `neo4j_store.graph_data_sync()` 三条 Cypher 直查 Neo4j。v2.2 前的 30 秒 TTL 缓存（避免全表 JSON 扫描）已移除，`invalidate_graph_cache` 全部调用点随之删除；Neo4j 不可用时返回 503「知识图谱服务（Neo4j）不可用」。前端节点/边 id 约定保持不变；`EntityPanel` 在此基础上增加了实体列表联动、n 层展开/移除/撤销、关系编辑与图谱文件（打开/保存/新建/截图、单独浏览）功能。

**节点视觉设计:**
- `category` — 方框样式与文章一致，图标 📁 + 目录名（宽度同样自适应）
- `article` — 方框，图标 📄 + 标题，宽度按内容自适应（80–200px，超长省略）
- `entity` — 圆形，图标按实体类型（人物👤/组织🏢/地点📍/事件⚡/产品📦/作品📄…），标签只显示实体名

**实体节点标识:** 实体以「名称+类型」为标识，节点 id = `entity:{name}::{type}`——同名不同类型（如「中华人民共和国」地点/组织）是两个独立节点；类型经 `entity_type` 字段下发，前端据此渲染图标。旧数据产生的无类型节点（`entity:{name}::`）按名称匹配兜底。

**交互功能:**
- 缩放/平移 (d3.zoom)、节点拖拽 (d3.drag)、悬停工具提示 (title + 类型 + 实体附加信息)
- **节点点击**：`EntityPanel` 内切换节点选中/高亮——实体节点联动实体列表（选中行 + 信息面板），文章/目录节点仅在图谱内高亮、不筛选文章列表；全屏 `KnowledgeGraph` 页仍按节点 `url` 跳转
- Ctrl+点击多选；点击空白取消全部选中；选中仅更新视觉高亮，不重建图谱
- **图操作工具栏**（`EntityPanel`）：展开选中节点 n 层（1–5 层，Neo4j 直查）、从视图移除选中节点、撤销上一步；无节点选中/无历史时按钮灰显
- **关系编辑**（`EntityPanel` 实体信息面板）：关联按当前文章范围渐进加载（每批 10 条）；支持新增/修改/删除、方向切换、对端类型图标与筛选；写操作要求文章范围，修改只作用于旧边存在的文章
- **图谱文件**（`EntityPanel` 右上角菜单）：新建 / 打开 / 保存 / 截图；JSON 保存节点位置与视口，可再次打开还原布局。打开或新建后进入**单独浏览模式**：文件名标签可关闭，实体列表仅与载入图联动，本地实体/关系编辑只改内存、不写数据库、不做权限校验
- **增量更新**：数据 join 保留已有节点对象、位置与缩放；节点/边增删才重启力模拟（边-only 变化也会重启以写入新 path），避免每次刷新重排版

**单独浏览模式（载入图谱）:**
- 打开或新建图谱后 `loadedGraphName` 非空、`workingGraph` 持有载入图；图谱模式下实体列表/关联/图谱全部从载入图派生，不查询数据库
- 本地实体/关系编辑只修改 `workingGraph` 并写入撤销历史，不写 SQLite/Neo4j、不做权限校验；撤销不会退出该模式
- 顶部文件名标签的 ✕ 是唯一退出入口；切换列表模式/窗口、在列表模式选择实体都不会清空载入图（保护条件基于 `loadedGraphName` 而非当前 `mode`）
- 保存使用 File System Access API（打开文件时记住可写句柄），JSON 含 `version/exportedAt/viewport/nodes(x,y)/edges`；浏览器不支持或写入失败时回退下载副本；保存对话框可修改位置/文件名，文件名变更同步到顶部标签
- 新建图谱名称按 `知识图谱_YYYY-MM-DD` 追加 `_2`/`_3` 序号；单独模式不显示源实体、不加载数据库附加信息、不查询关联；展开仍可用（按当前标签/类型解析节点 id 后查 Neo4j）

```json
{
  "version": 1,
  "exportedAt": "2026-11-06T08:00:00.000Z",
  "viewport": { "x": 120, "y": 80, "k": 1.2 },
  "nodes": [
    { "id": "entity:张三::人物", "label": "张三", "type": "entity",
      "url": "", "color": null, "entity_type": "人物", "x": 100, "y": 200 }
  ],
  "edges": [
    { "source": "entity:张三::人物", "target": "entity:李四::人物", "label": "同事" }
  ]
}
```

**SVG 箭头标记:**
```xml
<marker id="arrow-d3" viewBox="0 0 10 10" refX="10" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-border)" opacity="0.7" />
</marker>
```

### 9.5.1 知识图谱增强搜索

v2.3 起实体/关系存于 Neo4j，检索路径同时受益：实体直召与附加信息收集改为 Neo4j MENTIONS 边查询（替代旧的全表 JSON 扫描）。四条增强路径：

**路径一：图谱节点 → 文章搜索（图 → 文）**

实体节点的 `url` 指向 `/articles?search={name}`（`graph.py`）——全屏 `KnowledgeGraph` 页点击节点按 `url` 跳转；`EntityPanel` 内点击实体节点则联动实体列表/信息面板（不筛选文章列表），文章/目录节点仅在图谱内高亮。文章列表的本地实体筛选由实体列表选择（`name::type` 精确匹配）触发；图谱多选 id 集合（`selectedGraphNodeIds`）只用于图谱高亮，不再过滤文章列表（用户明确要求图谱文章/目录节点与文章列表不联动）。

**路径二：实体标签写入向量分块，提升召回（召回前）**

手动添加实体时（`entities.py` `add_entity`），把 `[实体: 名称 (类型)]` 标签行追加到所有提及该实体的分块文本末尾（无分块提及时挂到第一个分块或新建 `entity_tag` 块），随后 `_schedule_embedding_recompute()` 异步重算受影响分块的 embedding。效果：用户问句措辞与正文不一致时，只要命中实体名，向量相似度即可匹配到带标签的块——实体标注相当于给检索打了可控的「锚点」。实体改名/删除时同步维护分块标签行并重嵌入（`rename_entity` / `remove_entity`）。

**实体改名/改类型级联**：实体以 `(name, type)` 为身份，改名和改类型都按 `old_type` 限定，避免同名其他类型节点被一起改掉。

- `PUT /api/entities/rename`：Neo4j 节点改名；chunk 标签行按类型精确替换（正则要求实体名后紧跟类型括号，防「AI」误伤「AI 助手」的前缀污染）。EntityInfo 按名称共享——只有旧名称下已无其他类型变体时才级联改名，否则保留旧名称的共享附加信息。改名后关系边端点自动跟随（边指向节点）。
- `PUT /api/entities/update`：只改类型时同样按 `old_type` 限定，并同步 chunk 标签行中的类型（`[实体: 名称 (旧类型)]` → 新类型）。
- `DELETE /api/entities/remove` 支持 `entity_type`；类型化删除只删该类型的 MENTIONS/RELATES 和标签行，同名其他类型保留。
- 上述操作的权限均按 `(name, type)` 判定创建人/提及文章创建人；目标不存在时返回 404，避免无节点却级联 SQLite。

**路径三：实体附加信息同步分块 + QA 注入（召回后）**

- `_sync_entity_info_to_chunks()`（`entities.py`）：`EntityInfo`（实体附加信息）增删改时，把 `[实体信息: 实体名 | 条目名: 内容]` 行同步到所有提及该实体的分块并重嵌入（先剥离旧行再写入，避免堆积）
- `_collect_entity_info()`（`qa.py`）：问答时收集「问题中出现的实体名（扫全库 EntityInfo 表）+ 检索命中文章的实体」，查出其附加信息，格式化为「## 实体附加信息（知识图谱）」段注入 LLM 上下文——向量检索先筛出相关块，图谱信息再补充精确事实

**路径四：实体直召（`entity_recall`，图谱确定性召回）**

向量检索的补充路径——embedding 对专有名词不敏感时（如「汤和干了什么」的最佳匹配块相似度仅 0.388，被旧阈值 0.4 过滤），用实体名这条**确定性信号**兜底召回：

```
问句 ──子串匹配──► 知识图谱实体名（Neo4j 实体节点）
                      │
                      ▼
               含该实体的文章（Neo4j MENTIONS 边）──► chunk_text 含实体名的分块（每文章一条，SQLite）
                      │
                      ▼
               与向量结果按文章去重合并（向量命中优先；直召块给保底分
               ENTITY_RECALL_SCORE=0.5，且**不经过 QA_MIN_RELEVANCE 阈值过滤**）
                      │
                      ▼
               sources 展示 + 实体附加信息注入 + LLM 上下文
```

要点：
- 实体名长度 ≥ 2 防单字噪声；子串匹配不要求分词
- 直召是确定性匹配（实体名出现在分块文本中），不受阈值限制——调高 `QA_MIN_RELEVANCE` 也不会切断此路径
- 与向量结果按文章去重：向量已命中（分数达标）的文章不再重复直召
- 相关度阈值默认 0.3（`QA_MIN_RELEVANCE`，可环境变量调节）：embedding-3（2048 维）对真实匹配块分数普遍在 0.3-0.42，0.4 会漏掉有效结果；噪声块通常 < 0.27

**前端跨文实体定位**：选中实体后，文章正文与评论中该实体的所有出现位置用 rehype 插件（`createEntityHighlightPlugin`）高亮，`useEntityOccurrences` 统计次数并支持逐个跳转（`EntityOccurrenceBar`）。

完整链路：

```
LLM 提取实体/关系 ──► Neo4j（实体节点/提及边/关系边）
        │
        ├──► 图谱可视化（graph.py：SQLite 文章/分类 + Neo4j 实体/边）──► 全屏页点击节点按 url 跳转；EntityPanel 内点击实体节点联动实体列表/信息面板
        │
        ├──► 实体标签/附加信息写入分块 + 重嵌入 ──► 提升向量召回
        │
        ├──► QA 实体直召（entity_recall）──► 向量未命中时按实体名兜底召回
        │
        ├──► QA 检索后 _collect_entity_info 注入 LLM 上下文
        │
        └──► 前端实体面板筛选 + 正文高亮定位（name::type 精确匹配）
```

### 9.6 响应式布局

| 断点 | 布局 | 侧边栏 | 文章列表 | 实体面板 |
|------|------|--------|---------|---------|
| > 1100px | 多栏 | 可缩进（☰ 切换） | flex: 3 (主体) | 320px 固定, sticky |
| ≤ 1100px | 单栏堆叠 | 覆盖层抽屉 | 按内容高度 | 按内容高度 |

移动端核心 CSS（v2.8 起按内容高度，页面整体滚动）:
```css
@media (max-width: 1100px) {
  .layout {
    flex-direction: column;
    height: auto;      /* 按内容高度 */
    gap: 0;
  }
  .mainCol { flex: none; min-height: 0; overflow-y: visible; }
  .panel   { flex: none; min-height: 0; overflow-y: visible; }
}
```

桌面端侧边栏可缩进（`sidebarCollapsed` 状态 + ☰ 按钮，主区自动扩展）；移动端侧边栏为覆盖层抽屉，缩进状态不生效。

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

- **评论内容重解析**（`_bg_comment_reextract`）与**评论编辑**（`_bg_comment_process`）：旧实体贡献先按 `source='comment:<id>'` 精确删边（Neo4j），再合并新提取结果——编辑评论不会残留旧实体（v2.4 起编辑路径同样先删旧边）；评论自身已有标签保留合并
- **评论附件重解析**（`_bg_comment_attachment_reprocess`）：媒体用替换式写入（`_replace_media_tag_with_desc` 替换含该文件的媒体标签行并清理同名重复标签，避免旧描述堆积）；文档仅当占位符仍在时替换。正文变化后重建评论分块 + 嵌入，保持 Q&A 检索索引新鲜。端点校验 `safe_name` 属于该评论（含 legacy 单附件字段），防止把不属于该评论的文件解析进正文
- 解析状态追踪：`processing` 字段两阶段——`"processing:{safe_name}"`（读取中：文本提取）→ `"recognizing"`/`"recognizing:{safe_name}"`（解析中：LLM 识别）→ 完成清空。文档上传后文本提取与识别结果分两步落库
- 前端 AttachmentGallery 根据 processing 字段匹配附件，分别显示"读取中…"/"解析中…"遮罩；文章详情页与评论列表各 5 秒轮询，两阶段各自落库后前端即可看到；识别完成清空遮罩并通知刷新
- **自动解析开关（`AUTO_PARSE`）**：默认关闭（`0`）。文章与评论的**新增附件（含文档文本提取）与内容修改统一受本开关控制**——关闭时不做任何自动解析、保留"待解析"占位符，等手动解析；开启时媒体描述/标签/实体/标题提取与文档文本提取全部自动执行。唯一例外：`/api/upload` 上传入口的文档文本提取（纯本地解析不调用 LLM）始终自动。手动 reprocess/recognize 端点不受开关影响
- **分段 LLM 提取（v2.0）**：标签/实体/关系提取基于向量分块逐段进行——每段最多 512 字符、段数不设上限；每段完成后立即落库（逐段落库），后续段失败时已保存的结果不受影响。各段结果按「名称+类型」（实体）/ 五元组（关系）去重合并。详见 §9.9

### 9.8 权限控制体系（v1.3+）

所有创建人判断基于 mTLS 证书 CN 中的 18 位身份证号：

| 资源 | 创建人记录 | 修改权限 | 删除权限 | 重新解析权限 |
|------|-----------|---------|---------|------------|
| 文章 | created_by | 仅创建人 | 仅创建人 | 仅创建人 |
| 评论 | created_by | 仅评论人 | 评论人或文章创建人 | 评论人或文章创建人 |
| 实体 | Neo4j `Entity.created_by`（按 name+type） | 实体创建人或提及文章创建人 | 同左 | — |
| 实体关系 | 以 `owner` 端点权限判定（按 name+type） | owner 创建人或 owner 提及文章创建人 | 同左 | — |
| 实体附加信息 | EntityInfo.created_by | 仅创建人 | 仅创建人 | — |
| 目录 | created_by | 仅创建人 | 仅创建人 | — |

- 前端通过身份证号比对隐藏非创建人的编辑/删除按钮
- 后端 403 兜底拦截，错误详情区分权限错误与认证错误（认证 403 触发登录跳转，权限 403 仅弹 toast）
- **关系写操作额外约束**：`owner` 必须是关系端点；两端必须提供明确类型；`article_ids` 必填；修改/删除先按旧边实际存在的文章取范围，避免越权或扩散到其他文章
- **同名不同类型**：权限查询使用 `(name, type)` 精确匹配，拥有 `张三(人物)` 不自动拥有 `张三(组织)` 的修改权（无创建人记录时沿用宽松回退）

### 9.9 分段提取（v2.0，v2.3 移除块级标注快照）

**问题背景**：单次 LLM 提取受上下文长度限制（默认截断 512 字符），长文档后半部分的实体/关系会丢失。

**单一分段来源**：提取与语义搜索共用同一套向量分块（`article_chunks` 表）。上传/评论/附件重解析在提取前统一调用 `rebuild_article_chunks()` 重建分块并嵌入，随后从分块行读取文本逐段提取——不再重复切分逻辑，保证「检索到的块」与「提取用的段」一一对应。

```
长文本 ──chunk_article──► article_chunks 表 (唯一分段来源)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        语义搜索检索      嵌入向量计算      分段 LLM 提取
        (semantic_search) (embed_chunk_rows) (extract_chunks_iter)
```

**逐段落库**：提取循环每段完成后立即 `db.commit()`（标签、文章级实体写 Neo4j），段级失败不丢失前段结果。

**v2.3 变更——块级实体标注列移除**：旧 `article_chunks.entities` 快照列记录"该段提取到了什么"，但快照改名不传播、重新分块即丢失、覆盖率随机，且实体归属已有 Neo4j 单一真相源。现改为：QA 来源卡片的实体 chips 由 `_entities_in_chunk` 在问答时用 **Neo4j 实体名与命中块文本（含 `[实体: …]` 标签行）子串匹配即时派生**（与实体直召同规则：实体名长度 ≥ 2）——永远新鲜、重切零损失。代价：失去 LLM 指代解析（正文写"信国公"、实体名"汤和"不在文本中时派生不出），由「重新解析后标签行回填」部分弥补。

**限制与容错**：
- 每段 ≤ 512 字符、段数不设上限（全部分段处理；长文档提取调用量随段数线性增长）
- `merge_tags`（标签按名称去重）/ `merge_entities`（实体按名称+类型、关系按五元组去重）合并各段结果
- 嵌入失败时分块行保留（无向量点），提取不受影响；下次启动同步重算补齐
- 评论分块以 `comment.{id}.{i}` 索引存储，喂给提取时剥离 `[评论] ` 前缀

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

### 9.11 高级搜索（v2.7）

**入口**：顶部搜索框内 ⚙️ 开关（与搜索框融合），面板从搜索框下方弹出。条件行 = 与/或连接符 + 非复选框 + 类型（关键词/人员/时间范围）+ 值输入，可任意添加/删除。提交后进入 `/articles?adv=1` 结果视图。

- **条件组合**：条件按 `connector`（and/or）依次组合，`negated` 取反；后端 `POST /api/articles/search` 构建 SQLAlchemy 表达式（`and_`/`or_`/`not_`），空条件跳过
- **状态管理**：已提交条件存于 AppProvider 上下文（`advancedSearch`），列表 adv 模式据此取数；目录筛选（`advCategoryId`）以 `category` 条件（子树匹配）追加
- **激活态**：条件设置后 ⚙️ 图标醒目标识（accent 实底）、普通搜索输入框禁用、清除按钮（✕）重置高级+普通搜索
- **与搜索结果处理一致**：高级搜索结果的展示处理与关键词搜索完全一致——结果根目录视图（有匹配的顶级目录卡片）、目录内筛选（目录卡片 + 分页结果）、侧边栏结果树（目录可收缩）、面包屑 全部/目录链/条件摘要、详情页链接保留 `?adv=1`

### 9.12 目录层级与拖拽移动

**数据模型**：目录 `parent_id` 自引用（子目录）；文章 `parent_id` 自引用（同目录内挂载）。写路径应用层校验：目录/文章防环（沿祖先链上溯）、文章父子同目录约束、删除保护（有子目录/子文章时 409）。

**移动接口**：`POST /api/categories/{id}/move`（body: parent_id，空串=顶级）、`POST /api/articles/{id}/move`（body: category_id / parent_id）——拖拽移动专用，创建人 only。

**跨组件拖拽（v2.8）**：拖拽源与悬停目标状态提升至 AppProvider（`dragRef`/`dropTarget`），侧边栏与文章列表共享：

- 侧边栏目录/文章 → 文章列表目录卡片（移入目录）、文章卡片（挂为子文章）
- 文章列表目录卡片/文章卡片 → 侧边栏目录、文章、「全部」按钮（移到顶级）
- 目录拖到文章上为不可用状态（红色虚线 + dropEffect none）；拖拽源与目标均有创建人权限校验（无创建人旧数据视为可移动）
- 放置后 `notifyArticleSaved` + `notifyCategoriesChanged` 刷新列表、侧边栏与目录计数

**文章列表目录卡片（DirCard）**：各视图（根目录/浏览/搜索/高级搜索）统一卡片样式——📁 + 名称 + 创建人/创建时间（靠右）+ 递归文章数 + 箭头；✎ 修改（内联表单：名称 + 8 色圆点）/ ✕ 删除（删除保护：有子目录或文章时前端拦截提示、后端 409 兜底），权限控制与侧边栏一致（创建人证件号比对）。

### 9.13 文章列表分页与排序

**分页**：每页 10 篇（`PAGE_SIZE`，与侧边栏/位置选择器分批一致），`/api/articles/count` 提供总数；切换目录/搜索/标签/高级搜索回到第 1 页，总页数减少时自动修正；翻页后平滑回列表顶部；页码窗口前后各 2 个。

**组合排序（v2.8）**：头部「⇅ 排序」面板（portal 固定定位，左对齐按钮）——条件行 = 时间 / 标题·目录名 / 创建人 × ↓倒序/↑正序，多条件按优先级多键比较（标题/创建人按中文拼音序，空值排后）。**目录与文章分别排序**：目录卡片按条件在目录间排序、始终置于文章列表上方；文章按条件在文章间排序（层级缩进保留）。排序面板开关不影响其他窗口（窗口保活）。

### 9.14 Prompt 可配置（v2.7）

- `backend/app/prompts.py`：内置默认 `_DEFAULTS` 字典（11 个提示词）；启动时读取 `prompts/` 目录下同名 `.txt` 文件覆盖（如 `GENERATE_TITLE.txt`），文件缺失/为空回退内置默认，模块级导出名不变
- 配置文件：仓库根 `prompts/`（每个提示词一个 txt，原始文本无需转义），路径可用 `PROMPTS_DIR` 环境变量覆盖；修改后重启后端生效
- Docker：`./prompts:/app/prompts:ro` 挂载 + Dockerfile `ENV PROMPTS_DIR=/app/prompts`；修改本机 txt 后 `docker compose restart my-wiki` 生效
- 模板占位符沿用 Python `.format()` 风格（`{context}`/`{text}` 等），字面花括号写双括号

### 9.15 实体列表动态加载

实体面板列表模式每批展示 **20 条**（`ENTITY_BATCH`），底部「加载更多（已显示 N / 总数 条）」按钮逐批追加；实体数据或筛选词变化时回到第一批。编辑中或已选中的实体若位于第一批之外，会保留其可见批次并滚动到该行，避免清除筛选/数据刷新后编辑表单与信息面板消失。

关联信息同样渐进加载：每次 **10 条**（`RELATION_BATCH`），点击「加载更多」追加；切换选中实体时回到第一批。关联按当前文章范围从 Neo4j 查询（`POST /api/entities/relations/query`），单独浏览模式下改为从载入图的 `workingGraph.edges` 即时派生，不查数据库。

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
  // 侧边栏（移动端抽屉 / 桌面端缩进）
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  sidebarCollapsed: boolean;          // 桌面端缩进（主区扩展）
  toggleSidebarCollapsed: () => void;

  // 编辑器
  editorState: { isOpen: boolean; articleId: string | null; parentId?; categoryId? };
  openEditor: (articleId: string | null, preset?) => void;
  closeEditor: () => void;

  // 确认框
  confirmState: { message: string; onConfirm: () => void; confirmLabel?: string } | null;
  requestConfirm: (message: string, onConfirm: () => void, confirmLabel?: string) => void;

  // 上传器
  uploaderOpen: boolean;
  openUploader: (preset?) => void;
  closeUploader: () => void;

  // 刷新信号
  articleVersion: number;
  notifyArticleSaved: () => void;
  categoriesVersion: number;
  notifyCategoriesChanged: () => void;

  // 智能问答面板（与文章/实体窗口并排）
  qaOpen: boolean;
  setQaOpen: (v: boolean) => void;

  // 高级搜索（条件由顶部搜索框面板提交；列表 adv 模式取数）
  advancedSearch: AdvancedSearchCondition[] | null;
  setAdvancedSearch: (c: AdvancedSearchCondition[] | null) => void;
  advCategoryId: string | null;       // 结果中的目录筛选
  setAdvCategoryId: (id: string | null) => void;

  // 跨组件拖拽（侧边栏 ⇄ 文章列表）
  dragRef: React.MutableRefObject<{ type: 'cat' | 'article'; id: string } | null>;
  dropTarget: string | null;
  setDropTarget: (v: string | null) => void;
  startDrag: (e, type, id, allowed) => void;
  dragOverTarget: (e, key) => void;
  clearDropTarget: (key) => void;

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
| **资源权限** | 文章/评论/实体/附加信息/分类基于身份证号比对 created_by，仅创建人可修改/删除；实体与关系权限按 `(name, type)` 精确匹配，关系 `owner` 必须是端点 | 各路由模块 |
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
| **图谱节点限制** | `/api/graph` MAX_NODES = 2000；`/api/graph/expand` 路径级 LIMIT 1200/5000 + 端点/墓碑过滤 | `graph.py`, `neo4j_store.py` |
| **关系写校验** | `article_ids` 必填；owner 必须是端点；两端类型明确；修改范围限定旧边实际存在的文章 | `entities.py`, `neo4j_store.py` |
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
python rebuild_chunks.py                # 一次性全量重建分块（改 MAX_CHUNK_CHARS 后执行）
                                        #   : 按新规则重切 → 回填实体标签/附加信息行 → 重嵌入 → Qdrant 同步
python dist/upgrade_db.py               # 数据库升级脚本（补列/建索引/清旧列，幂等；仓库根目录下执行）
                                        #   Docker: docker compose exec my-wiki python dist/upgrade_db.py
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
        conn.exec_driver_sql("ALTER TABLE articles ADD COLUMN processing TEXT")
    except Exception:
        pass  # 列已存在
```

添加新列时在此处追加类似的 try/except 块。

**独立升级脚本（v2.8）**：`dist/upgrade_db.py`（发布物目录）——显式升级存量数据库，幂等可重复执行：

- 补列：与 models.py 对齐的全部懒迁移列（articles.parent_id / processing / created_by / updated_by、categories.parent_id / created_by / created_at / updated_at、comments.attachments、entity_infos.created_by）
- 建索引：`ix_articles_parent_id`、`ix_categories_parent_id`（补列后缺失，init_db 懒迁移不建索引）
- 清旧列：`article_chunks.embedding` / `entities`（SQLite ≥ 3.35）
- 每步先检查再变更、输出明细；末尾 ANALYZE。路径默认取 `DATABASE_URL`，可用 `--db` 指定

**v2.3 特例——DROP COLUMN 不在 init_db 执行**：`articles.entities` / `comments.entities` 两列由启动懒迁移 `neo4j_store.migrate_and_drop_columns()` 在数据加载进 Neo4j **之后**才执行 `ALTER TABLE … DROP COLUMN`（SQLite ≥ 3.35）。不能放进 `init_db()`——否则列会先于 Neo4j 加载被删除，历史实体数据丢失。

### 13.6 调试技巧

- **API 调试:** 访问 `https://localhost:8000/docs` (Swagger UI 自动生成)
  > ⚠️ 生产模式 (run.py / Docker) 的 8000 端口是 CERT_NONE，从 Swagger 直接调用受保护 API 必然返回 `{"detail":"Client certificate is required"}`。调试受保护接口请用 `curl --cert <客户端证书.crt> --key <客户端密钥.key> -k https://localhost:8443/api/...`（经 nginx 入口），或开发模式下浏览器已导入客户端证书时在 Swagger 中调用
- **前端调试:** 浏览器 DevTools → Network 面板查看 API 调用
- **数据库调试:** 使用 SQLite 浏览器打开 `data/knowledge_base.db`（数据统一在仓库根 data/ 目录）
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

**方案 A: Docker Compose（推荐，v2.3 四容器）**

```bash
docker compose up -d --build
# 8000 登录页 / 8443 mTLS 应用
```

**四容器架构：**

| 容器 | 镜像 | 职责 |
|------|------|------|
| `my-wiki` | 多阶段构建（静态 ffmpeg → Node 18 → Python 3.11-slim） | 后端双端口服务（8000 HTTPS 登录页 / 8444 应用） |
| `my-wiki-qdrant` | `qdrant/qdrant:v1.19.1`（钉死版本） | 向量检索索引（REST 6333），启动懒迁移自动同步 |
| `my-wiki-neo4j` | `neo4j:5.26`（钉死版本，LTS） | 实体/关系图存储（Bolt 7687 / Browser 7474），启动懒迁移自动同步 |
| `my-wiki-nginx` | `nginx:1.25` | 8443 TLS 终止（`optional_no_ca`） |

```
浏览器
  ├─ :8000  HTTPS ──────────────► my-wiki:8000   (登录页, CERT_NONE)
  └─ :8443  HTTPS + 客户端证书 ──► nginx ── HTTP ─► my-wiki:8444  (应用)
                                  (TLS 终止, X-Client-Cert 头)
my-wiki ── QDRANT_URL ──► qdrant:6333 (向量检索)
my-wiki ── NEO4J_URI ──► neo4j:7687   (实体/关系存储)
```

- 多阶段构建：静态 ffmpeg 二进制（`mwader/static-ffmpeg:7.0`，替代 apt 版 ~450MB）→ Node 18 构建前端（`vite build` 输出到 `backend/static`）→ Python 3.11-slim 运行时（OpenCV headless）
- 数据持久化：本机目录绑定挂载 — `./data` 统一存放（SQLite 数据库 + 上传文件 `data/uploads` + Qdrant 向量数据 `./data/qdrant` + Neo4j 图数据 `./data/neo4j`）
- **Qdrant 连接**：统一在 `.env` 中配置 `QDRANT_URL`——Docker 部署用 `http://qdrant:6333`（compose 网络按服务名解析），本地开发用 `http://localhost:6333`；`my-wiki` 经 `depends_on: qdrant (service_healthy)` 保证 Qdrant 先就绪
- **Neo4j 连接**：统一在 `.env` 中配置 `NEO4J_URI`——Docker 部署用 `bolt://neo4j:7687`，本地开发用 `bolt://localhost:7687`；`my-wiki` 经 `depends_on: neo4j (service_healthy)` 保证 Neo4j 先就绪。**密码注意**：`NEO4J_AUTH=neo4j/${NEO4J_PASSWORD}` 仅在 `./data/neo4j` 数据卷**首次初始化**时生效，改密需重置数据卷或用 `neo4j-admin set-initial-password`
- **环境变量**：模型参数（KEY/BASE/MODEL）、超时、开关、白名单**统一在仓库根目录 `.env`**（Docker 挂载为 `/app/.env`，本地开发由 `config.py` 显式加载），docker-compose 不做覆盖
- **Prompt 配置**：`./prompts:/app/prompts:ro` 只读挂载（Dockerfile `ENV PROMPTS_DIR=/app/prompts`），修改本机 `prompts/*.txt` 后 `docker compose restart my-wiki` 生效；目录缺失时回退内置默认
- **证书**：`./certs:/certs:ro` 只读挂载（镜像不含证书，启动必须提供）；SSL 路径使用容器内绝对路径（`/certs/server.crt` 等）；nginx 容器挂载同一目录（`/etc/nginx/certs`）
- 修改 `.env` 后执行 `docker compose restart` 即生效（`.env` 挂载 + `load_dotenv()` 在进程启动时读取）；**修改 `docker-compose.yml` 则需 `docker compose up -d` 重建容器**（容器创建时 bake 的环境变量不会随 restart 刷新，且 `load_dotenv` 不覆盖已存在的环境变量）
- 环境变量优先级：容器环境（Dockerfile `ENV`）> `/app/.env` 文件（`load_dotenv` 不覆盖已存在的环境变量）
- `run.py` 支持 `HOST` / `SSL_CERTFILE` / `SSL_KEYFILE` / `SSL_CA_CERTS` 环境变量覆盖

**方案 B: 本机运行**

```bash
# Qdrant + Neo4j：
#   docker compose up -d qdrant neo4j       # compose 只起向量库与图数据库
cd frontend && npm run build          # 构建前端 → backend/static/
cd backend && .venv\Scripts\python run.py   # 本地开发：.env 中 QDRANT_URL 切换为 http://localhost:6333、
                                            # NEO4J_URI 切换为 bolt://localhost:7687（均为代码默认值）
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
GET    /api/articles?category_id=&search=&tag=&root_only=&skip=&limit=   文章列表
GET    /api/articles/count                 文章计数（分页总数）
GET    /api/articles/facets?search=&category_id=   搜索结果目录分布
POST   /api/articles/search                高级搜索（与或非组合条件，分页）
GET    /api/articles/:id                   文章详情
POST   /api/articles                       创建文章
PUT    /api/articles/:id                   更新文章
DELETE /api/articles/:id                   删除文章
POST   /api/articles/:id/move              拖拽移动文章（换目录/换父文章）
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
GET    /api/categories                     目录列表
GET    /api/categories/article-counts      每个目录的递归文章数
POST   /api/categories                     创建目录
PUT    /api/categories/:id                 更新目录
POST   /api/categories/:id/move            拖拽移动目录（换上级目录）
DELETE /api/categories/:id                 删除目录
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

> 📝 本文档由 Claude Code 基于项目源码自动生成，最后更新于 2026-11-03。
