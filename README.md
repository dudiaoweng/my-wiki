# 📚 My-Wiki — 个人知识库

基于 AI 的个人知识库系统，支持文章管理、文件上传解析、知识图谱可视化、语义搜索问答。

---

## 功能

### 📝 文章管理
- 创建/编辑/删除文章，Markdown 编写
- 文件上传自动解析（文本/Word/Excel/PPT/PDF/图片/音视频）
- 分类管理（颜色标签，创建/编辑/删除，含文章保护）
- 标签系统（手动 + AI 自动提取）
- 附件下载（原始文件保留）

### 🤖 AI 能力（需配置 LLM API）
- **标签提取**：自动从文章内容提取概念标签
- **实体识别**：提取人物、组织、地点、事件、产品等实体及其关系
- **图片描述**：上传图片自动用视觉模型生成描述
- **文档摘要**：上传文档自动生成标题
- **智能问答**：基于知识库的 RAG 问答（语义搜索 + LLM 回答）

### 🗺️ 知识图谱
- D3.js 力导向图可视化
- 文章/分类/实体三种节点
- 实体间关系边（LLM 提取的关联）
- 支持缩放、拖拽、节点点击跳转

### 🔍 搜索与过滤
- 全文搜索
- 分类筛选
- 标签过滤
- 知识图谱节点联动筛选

### 📊 其他
- 阅读进度条
- 键盘快捷键
- Toast 提示
- 确认对话框
- 侧边栏响应式

---

## 技术栈

| 层 | 技术 |
|---|------|
| **后端框架** | Python 3.11+ / FastAPI |
| **ORM** | SQLAlchemy 2.0 + SQLite |
| **数据校验** | Pydantic v2 |
| **前端框架** | React 18 + TypeScript |
| **构建工具** | Vite 6 |
| **路由** | react-router-dom v6 |
| **可视化** | D3.js v7 |
| **Markdown** | react-markdown + remark-gfm |
| **HTTP 客户端** | httpx (后端) / fetch (前端) |
| **文件解析** | python-docx / openpyxl / python-pptx / PyPDF2 |
| **AI 接口** | OpenAI 兼容 API（智谱 GLM / GPT 系列等） |

---

## 项目结构

```
my-wiki/
├── backend/                       # 后端
│   ├── app/
│   │   ├── main.py                # FastAPI 入口 + 种子数据
│   │   ├── database.py            # SQLAlchemy 引擎 + SQLite 外键启用
│   │   ├── dependencies.py        # FastAPI 依赖注入 (get_db)
│   │   ├── models.py              # 数据模型 (Article/Category/EntityInfo/Chunk)
│   │   ├── schemas.py             # Pydantic 请求/响应模型
│   │   ├── llm_extract.py         # 共享 LLM 标签+实体提取
│   │   └── routes/
│   │       ├── articles.py        # 文章 CRUD + 下载
│   │       ├── categories.py      # 分类 CRUD
│   │       ├── tags.py            # 标签 CRUD
│   │       ├── entities.py        # 实体 CRUD + 附加信息
│   │       ├── graph.py           # 知识图谱数据
│   │       ├── stats.py           # 统计信息
│   │       ├── qa.py              # RAG 问答 (语义搜索 + LLM)
│   │       └── upload.py          # 文件上传 + 解析 + AI 提取
│   ├── uploads/                   # 上传文件存储
│   ├── requirements.txt
│   └── .env                       # 环境变量 (需自行创建)
├── frontend/                      # 前端
│   ├── src/
│   │   ├── main.tsx               # React 入口
│   │   ├── App.tsx                # 路由配置
│   │   ├── api/client.ts          # API 客户端
│   │   ├── context/AppProvider.tsx # 全局状态 (编辑器/版本号/确认框)
│   │   ├── hooks/
│   │   │   ├── useArticles.ts     # 文章列表状态
│   │   │   ├── useCategories.ts   # 分类状态 + 操作
│   │   │   ├── useD3ForceGraph.ts # D3 力导向图共享钩子
│   │   │   ├── useGraphData.ts    # 图谱数据
│   │   │   ├── useQA.ts           # 问答会话管理
│   │   │   ├── useStats.ts        # 统计数据
│   │   │   ├── useTags.ts         # 标签状态
│   │   │   ├── useToast.tsx       # Toast 通知
│   │   │   ├── useKeyboardShortcuts.ts
│   │   │   └── useReadingProgress.ts
│   │   ├── components/
│   │   │   ├── Layout/            # Layout / TopBar / Sidebar
│   │   │   ├── ArticleCard.tsx    # 文章卡片
│   │   │   ├── ArticleList.tsx    # 文章列表 + EntityPanel
│   │   │   ├── ArticleDetail.tsx  # 文章详情页 (独立路由)
│   │   │   ├── ArticleDetailInline.tsx # 文章内联查看
│   │   │   ├── EditorModal.tsx    # 文章编辑弹窗
│   │   │   ├── UploadModal.tsx    # 文件上传弹窗
│   │   │   ├── EntityPanel.tsx    # 实体面板 (列表 + 知识图谱)
│   │   │   ├── KnowledgeGraph.tsx # 全屏知识图谱页
│   │   │   ├── Hero.tsx           # 首页
│   │   │   ├── QA.tsx             # 问答页面
│   │   │   ├── ConfirmDialog.tsx  # 确认弹窗
│   │   │   ├── Toast.tsx          # Toast 容器
│   │   │   └── ReadingProgress.tsx
│   │   ├── utils/entityIcons.ts   # 实体类型图标映射
│   │   ├── types/                 # TypeScript 类型定义
│   │   └── styles/                # 全局样式 (reset/tokens/global)
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
└── knowledge-base.html            # 前端入口文件
```

---

## 快速开始

### 环境要求

- Python 3.11+
- Node.js 18+
- LLM API Key（可选，推荐智谱 GLM）

### 1. 启动后端

```bash
cd backend

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 配置环境变量 (创建 .env 文件)
cat > .env << EOF
DATABASE_URL=sqlite:///./knowledge_base.db
UPLOAD_DIR=./uploads
LLM_API_KEY=your-api-key-here
LLM_API_BASE=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-4
EMBEDDING_MODEL=embedding-3
CORS_ORIGINS=http://localhost:5173
EOF

# 启动服务 (端口 8000)
uvicorn app.main:app --reload --port 8000
```

### 2. 启动前端

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器 (端口 5173)
npm run dev
```

### 3. 访问

打开浏览器访问 **http://localhost:5173**

首次启动会自动创建 SQLite 数据库并填充示例数据（5 篇示例文章、4 个分类）。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | SQLite 数据库路径 | `sqlite:///./knowledge_base.db` |
| `UPLOAD_DIR` | 上传文件存储目录 | `./uploads` |
| `LLM_API_KEY` | LLM API 密钥 | (空，不配置则禁用 AI 功能) |
| `LLM_API_BASE` | API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名称 | `gpt-4o-mini` |
| `EMBEDDING_MODEL` | 向量模型 | `embedding-3` |
| `CORS_ORIGINS` | 前端地址 | `http://localhost:5173` |

---

## API 概览

| 路由 | 说明 |
|------|------|
| `GET/POST /api/articles` | 文章列表 / 创建 |
| `GET/PUT/DELETE /api/articles/{id}` | 文章详情 / 更新 / 删除 |
| `GET /api/articles/{id}/download` | 下载附件 |
| `GET/POST /api/categories` | 分类列表 / 创建 |
| `PUT/DELETE /api/categories/{id}` | 分类更新 / 删除 |
| `GET/POST /api/tags` | 标签列表 / 添加 |
| `PUT /api/tags/rename` | 标签重命名 |
| `POST /api/tags/remove` | 删除标签 |
| `GET/POST /api/entities` | 实体列表 / 添加 |
| `PUT /api/entities/update` | 更新实体 |
| `DELETE /api/entities/remove` | 删除实体 |
| `GET/POST /api/entities/{name}/info` | 实体附加信息 |
| `GET /api/graph` | 知识图谱数据 |
| `GET /api/stats` | 统计 (文章/分类/标签/实体数) |
| `POST /api/qa/ask` | RAG 问答 |
| `POST /api/upload` | 文件上传 |
| `GET /api/health` | 健康检查 |

---

## 数据模型

### Article (文章)
```
id, title, content, category_id, tags (JSON数组), entities (JSON对象),
created_at, updated_at, attachment_path/name/type
```

### entities 格式
```json
{
  "entities": [
    {"name": "机器学习", "type": "技术"},
    {"name": "OpenAI", "type": "组织"}
  ],
  "relations": [
    {"source": "OpenAI", "target": "机器学习", "label": "研发"}
  ]
}
```

### Category (分类)
```
id, name, color
```

### EntityInfo (实体附加信息)
```
id, entity_name, category, content, created_at, updated_at
```

### ArticleChunk (文章分块 + 向量)
```
id, article_id, chunk_index, chunk_text, embedding (JSON数组)
```

---

## 架构说明

### 前后端分离
- 后端 FastAPI 运行在 `localhost:8000`，提供 REST API
- 前端 Vite 运行在 `localhost:5173`，开发时通过 Vite proxy 转发 API 请求
- 生产环境可将前端构建产物放到后端 `/static` 目录下

### LLM 集成
- 统一通过 `app/llm_extract.py` 调用 LLM（60s 超时 + 2 次重试 + JSON 容错解析）
- 上传文件：异步提取（通过 `asyncio.to_thread` 桥接同步函数）
- 文章编辑：仅内容变更时触发提取
- Q&A：语义搜索 + LLM 生成回答，有 embedding fallback 机制

### 知识图谱
- `/api/graph` 端点聚合所有文章/分类/实体节点 + 边
- 30 秒 TTL 缓存避免全表扫描
- 前端 `useD3ForceGraph` 共享钩子供 `EntityPanel` 和 `KnowledgeGraph` 共用
- 实体节点使用类型图标区分（人物/组织/地点/事件/产品/其他）

### 向量搜索 (RAG)
- 文章按 Markdown 标题分段，每段调用 embedding API 生成向量
- 增量计算（记录已处理文章数，跳过已生成向量的文章）
- 问答时计算 query 向量与所有 chunk 的余弦相似度
- LLM 不可用时自动降级为关键词匹配

---

## 许可证

MIT
