# 📚 My-Wiki — 个人知识库

基于 AI 的个人知识库系统，支持文章管理、文件上传解析、知识图谱可视化、语义搜索问答，通过 mTLS 客户端证书进行身份验证。

---

## 功能

### 📝 文章管理
- 创建 / 编辑 / 删除文章，Markdown 编写
- 记录创建人和更新人（从 mTLS 证书 CN 提取姓名+身份证号）
- 仅更新过的文章显示更新时间/更新人
- 文件上传自动解析（文本 / Word / Excel / PPT / PDF / 图片 / 音视频），500MB 大小限制
- 分类管理（颜色标签，含文章保护）
- 标签系统（手动 chips 交互 + AI 自动提取）
- 附件下载（原始文件保留）
- 附件手动重新解析（每个附件独立 🔄 按钮，解析中显示遮罩）
- 附件缩略图（图片/视频 poster + 灯箱预览）

### 🔒 证书认证 (mTLS)
- 双向 TLS 客户端证书验证，无需密码
- 证书 CN 格式为 `[姓名] [18位身份证号]`，后端自动解析为 name/id_number
- **开发模式**：前端显示用户选择页，Vite 代理根据选择动态切换客户端证书
- **生产模式**：双端口架构 — 8000 展示登录页（Hero + 证书登录按钮），点击后跳转 8443 触发证书选择框，登录后刷新不掉线
- 顶栏右侧显示姓名，hover 显示完整身份证号

### 🔍 文章内搜索
- 文章详情页顶栏搜索框，实时高亮匹配文本
- 底部导航条：圆点位置轨道 + ▲▼ 跳转 + 计数
- 大小写不敏感，跳过代码块
- 搜索输入防抖，大文章下保持流畅

### 🤖 AI 能力（需配置 LLM API）
- **标签提取**：自动从文章内容提取概念标签
- **实体识别**：仅提取具有具体名称的实体（人物/组织/地点/事件/产品/作品）及其关系，泛化概念归入标签
- **图片描述**：上传图片自动用视觉模型生成描述
- **视频分析**：提取关键帧，通过视觉模型生成视频内容描述
- **音频转写**：自动转写音频为文字（语音识别）
- **文档摘要**：上传文档自动生成标题
- **智能问答**：基于知识库的 RAG 问答（语义搜索 + LLM 回答），支持上传图片 / 音频 / 视频作为上下文，回答内容经 rehype-sanitize 消毒

### 🗺️ 知识图谱
- D3.js 力导向图可视化
- 文章 / 分类 / 实体三种节点
- 实体间关系边（LLM 提取的关联）
- 缩放 / 拖拽 / 节点点击跳转
- 选中节点高亮，不重建图谱

### 💬 文章评论
- 评论创建 / 编辑 / 删除，Markdown 编写
- 记录评论人（身份证号）和时间，仅评论人可修改/删除
- 支持文件上传（与文章相同的文件类型），自动解析
- 评论附件画廊（缩略图 / 灯箱 / 下载，与文章一致）
- 评论内容纳入智能问答（分块嵌入）
- 文章卡片显示评论概要（条数 + 最新评论摘要）

### 🔐 权限控制
- **文章**：仅创建人可编辑/删除（基于身份证号）
- **评论**：仅评论人可编辑/删除，文章创建人也可删除
- **实体/附加信息**：记录创建人，仅创建人或文章创建人可操作
- **分类**：记录创建人/时间，仅创建人可修改/删除
- 前端按钮根据权限自动显示/隐藏，后端 403 兜底

### 📊 其他
- 阅读进度条
- 键盘快捷键
- Toast 提示
- 确认对话框
- 侧边栏响应式
- 实体出现位置导航（文章 + 评论中高亮 + 跳转）
- 长文章动态截断（展开全文 / 收起）
- 编辑表单附件标签移至标题后

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
| **Markdown** | react-markdown + remark-gfm + rehype-raw |
| **HTTP 客户端** | httpx (后端) / fetch (前端) |
| **文件解析** | python-docx / openpyxl / python-pptx / PyPDF2 / OpenCV |
| **音频处理** | wave / audioop / ffmpeg |
| **AI 接口** | OpenAI 兼容 API（智谱 GLM / GPT 系列等） |
| **认证** | mTLS 双向 TLS（8000: CERT_NONE 登录页 / 8443: CERT_REQUIRED 应用） |

---

## 项目结构

```
my-wiki/
├── backend/                       # 后端
│   ├── app/
│   │   ├── main.py                # FastAPI 入口 + 种子数据 + mTLS + SPA 服务
│   │   ├── database.py            # SQLAlchemy 引擎 + SQLite 外键启用
│   │   ├── models.py              # 数据模型 (Article/Category/EntityInfo/Chunk)
│   │   ├── schemas.py             # Pydantic 请求/响应模型
│   │   ├── config.py              # 集中配置（LLM/Vision/ASR/Embedding/TLS）
│   │   ├── auth.py                # mTLS 客户端证书验证依赖
│   │   ├── prompts.py             # 所有 LLM 提示词模板
│   │   ├── dependencies.py        # FastAPI 依赖注入 (get_db)
│   │   ├── llm_extract.py         # 共享 LLM 标签+实体提取
│   │   ├── utils.py               # 共享工具（ffmpeg 查找等）
│   │   └── routes/
│   │       ├── articles.py        # 文章 CRUD + 后台 LLM 增强 + 权限控制
│   │       ├── categories.py      # 分类 CRUD + 权限控制
│   │       ├── comments.py        # 评论 CRUD + 文件上传 + LLM 增强
│   │       ├── tags.py            # 标签 CRUD
│   │       ├── entities.py        # 实体 CRUD + 附加信息 + 权限控制
│   │       ├── graph.py           # 知识图谱数据
│   │       ├── stats.py           # 统计信息
│   │       ├── qa.py              # RAG 问答 (语义搜索 + LLM)
│   │       └── upload.py          # 文件上传 + 解析 + AI 增强
│   ├── static/                    # 前端构建产物（生产模式）
│   ├── uploads/                   # 上传文件存储
│   ├── requirements.txt
│   └── .env                       # 环境变量 (需自行创建)
├── frontend/                      # 前端
│   ├── src/
│   │   ├── main.tsx               # React 入口
│   │   ├── App.tsx                # 路由配置 + mTLS 认证守卫
│   │   ├── api/client.ts          # API 客户端
│   │   ├── api/auth.ts            # mTLS 认证状态检查
│   │   ├── context/AppProvider.tsx # 全局状态 (编辑器/版本号/确认框/用户)
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
│   │   │   ├── useReadingProgress.ts
│   │   │   ├── useArticleSearch.ts      # 文章内搜索 (IntersectionObserver)
│   │   │   └── useEntityOccurrences.ts  # 实体出现位置追踪
│   │   ├── components/
│   │   │   ├── Layout/            # Layout / TopBar / Sidebar
│   │   │   ├── Hero.tsx           # 首页
│   │   │   ├── ArticleCard.tsx    # 文章卡片
│   │   │   ├── ArticleList.tsx    # 文章列表 + EntityPanel
│   │   │   ├── ArticleDetail.tsx  # 文章详情 + 内联查看（归并）
│   │   │   ├── ArticleDetailPage.tsx # 独立文章页（懒加载路由包装）
│   │   │   ├── CommentSection.tsx # 评论组件（共用）
│   │   │   ├── EditorModal.tsx    # 文章编辑弹窗
│   │   │   ├── UploadModal.tsx    # 文件上传弹窗
│   │   │   ├── EntityPanel.tsx    # 实体面板 (列表 + 知识图谱)
│   │   │   ├── EntityOccurrenceBar.tsx  # 实体出现导航条
│   │   │   ├── KnowledgeGraph.tsx # 全屏知识图谱页
│   │   │   ├── QA.tsx             # 问答页面
│   │   │   ├── AttachmentGallery.tsx  # 附件画廊
│   │   │   ├── Lightbox.tsx       # 文件预览灯箱
│   │   │   ├── SearchNavBar.tsx   # 文章内搜索导航条
│   │   │   ├── CertErrorPage.tsx  # mTLS 证书错误页面
│   │   │   ├── LoginPage.tsx      # 开发模式用户选择页面
│   │   │   ├── ConfirmDialog.tsx  # 确认弹窗
│   │   │   ├── Toast.tsx          # Toast 容器
│   │   │   └── ReadingProgress.tsx
│   │   ├── utils/
│   │   │   ├── entityIcons.ts     # 实体类型图标映射
│   │   │   ├── rehypeEntityHighlight.ts  # 实体高亮 rehype 插件
│   │   │   └── rehypeSearchHighlight.ts  # 搜索高亮 rehype 插件
│   │   ├── types/                 # TypeScript 类型定义
│   │   └── styles/                # 全局样式 (reset/tokens/global)
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── certs/                         # PKI 证书
│   ├── ca.key / ca.crt            # CA 根证书
│   ├── server.key / server.crt    # 服务器证书 (CN=localhost)
│   ├── client.key                 # 客户端私钥（共享）
│   ├── client_zh.crt / client_zh.p12  # 周衡的客户端证书
│   ├── client_xl.crt / client_xl.p12  # 谢林的客户端证书
│   └── readme.txt                 # 证书生成说明
├── Dockerfile                     # 多阶段构建（Node 前端 + Python 运行时）
├── docker-compose.yml             # 容器编排（数据卷 + 环境变量注入）
├── .dockerignore
└── README.md
```

---

## 快速开始

### 环境要求

- Python 3.11+
- Node.js 18+
- LLM API Key（可选，推荐智谱 GLM）

### 1. 安装依赖

```bash
# 后端
cd backend
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 前端
cd frontend
npm install
```

### 2. 配置环境变量

在 `backend/` 下创建 `.env` 文件：

```bash
# ─── 基础设施 ───
DATABASE_URL=sqlite:///./knowledge_base.db
UPLOAD_DIR=./uploads

# ─── LLM 文本模型 ───
LLM_API_KEY=your-api-key-here
LLM_API_BASE=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=GLM-5.2

# ─── 视觉模型 ───
VISION_API_KEY=your-vision-api-key
VISION_API_BASE=https://open.bigmodel.cn/api/paas/v4
VISION_MODEL=GLM-5V-Turbo

# ─── 语音识别模型 ───
ASR_API_KEY=your-asr-api-key
ASR_API_BASE=https://open.bigmodel.cn/api/paas/v4
ASR_MODEL=GLM-ASR-2512

# ─── 嵌入模型 ───
EMBEDDING_API_KEY=your-embedding-api-key
EMBEDDING_API_BASE=https://open.bigmodel.cn/api/paas/v4
EMBEDDING_MODEL=embedding-3

# ─── 问答 ───
QA_TEMPERATURE=0.2

# ─── TLS / mTLS 证书认证 ───
SSL_CERTFILE=../certs/server.crt
SSL_KEYFILE=../certs/server.key
SSL_CA_CERTS=../certs/ca.crt
# 白名单（逗号分隔的 subject DN；留空 = 允许所有证书）
ALLOWED_CERT_SUBJECTS=/C=CN/ST=32/L=00/O=11/OU=00/CN=周衡 320923197608270018,/C=CN/ST=32/L=00/O=11/OU=00/CN=谢林 320100198001010010
```

### 3. 导入客户端证书

生产模式（含 Docker）下浏览器需要出示客户端证书（8443 端口 `CERT_REQUIRED`）。

**证书文件**（密码均为 `123456`）：

| 文件 | 用户 | CN |
|------|------|-----|
| `certs/zhouheng.p12` | 周衡 | 周衡 320923197608270018 |
| `certs/xielin.p12` | 谢林 | 谢林 320100198001010010 |
| `certs/xielin2.p12` | 谢林(2) | 谢林 320200199011010011 |
| `certs/zhangshengli.p12` | 张胜利 | 张胜利 320301198803210011 |

导入步骤（Windows）：

**第一步：导入 CA 根证书**（信任服务器证书）：
1. 双击 `certs/ca.crt` → 「安装证书」
2. 存储位置选择「当前用户」
3. 证书存储选择「将所有的证书都放入下列存储」→「受信任的根证书颁发机构」
4. 完成导入

**第二步：导入客户端证书**（用于身份认证）：
1. 双击 `.p12` 文件 → 输入密码 `123456`
2. 存储位置选择「当前用户」→「个人」
3. 完成导入

> ⚠️ 两步缺一不可：
> - **缺少 CA 根证书** → 浏览器显示"您的连接不是私密连接"（NET::ERR_CERT_AUTHORITY_INVALID），不会弹出客户端证书选择框
> - **缺少客户端证书** → 浏览器直接显示证书错误页（ERR_BAD_SSL_CLIENT_AUTH_CERT）
> - 两者都导入后，点击「证书登录」→ 浏览器弹出证书选择框

**浏览器证书选择行为**：

| 匹配的客户端证书数 | 行为 |
|-------------------|------|
| 0 个 | 证书错误页（导入 .p12 后重试） |
| 1 个 | 自动使用，不弹选择框 |
| 2 个以上 | 弹出选择框供用户选择身份 |

**SHA-1 签名证书兼容**：后端启动时配置 `ssl_ciphers="DEFAULT:@SECLEVEL=0"`，可接受 SHA-1 签名的客户端证书（现代浏览器端仍可能有限制）。

开发模式无需导入 — Vite 代理直接使用 `certs/` 目录下的证书文件连接后端。

### 4. 启动

**开发模式**（前后端分离，热重载）：

```bash
# 终端 1：启动后端（HTTPS + mTLS，热重载）
cd backend
.venv\Scripts\python -m app.main     # Windows
# source .venv/bin/python -m app.main  # macOS/Linux

# 终端 2：启动前端（HTTPS 开发服务器，Vite 代理携带客户端证书连接后端）
cd frontend
npm run dev
# 访问 https://localhost:5173 → 显示用户选择页面 → 选择身份登录
# 后端自动切换对应的客户端证书，无需重启
```

> Vite 代理根据前端的 `X-Dev-User` 请求头动态选择客户端证书。用户注册表在 `vite.config.ts` 的 `DEV_USERS` 中配置，添加新用户只需放入证书文件并更新注册表。

**生产模式**（双端口，登录页不弹证书框）：

```bash
cd frontend && npm run build          # 构建前端 → backend/static/
cd backend && .venv\Scripts\python run.py  # 启动双端口服务
# 访问 https://localhost:8000 → 登录页面 → 点击"证书登录" → 选择证书 → 进入系统
```

**Docker 部署**：

```bash
docker compose up -d --build
# 访问 https://localhost:8000（登录页）/ https://localhost:8443（应用）
```

- 多阶段构建：Node 构建前端 → Python slim 运行时（含 ffmpeg + OpenCV）
- 数据持久化：`wiki-data`（SQLite）/ `wiki-uploads`（上传文件）卷
- 环境变量通过 `.env` 注入（LLM 密钥 + ALLOWED_CERT_SUBJECTS 白名单）
- 证书从 `./certs` 挂载（只读）

> 生产模式使用双端口架构：
> - **8000**（`CERT_NONE`）：仅展示登录页，永不会触发浏览器证书选择框
> - **8443**（`CERT_REQUIRED`）：全功能应用，所有 API 调用需 mTLS 验证

### 5. 访问

开发模式访问 **https://localhost:5173**，生产模式访问 **https://localhost:8000**：

**开发模式**：
1. 首次访问显示用户选择页面 → 选择身份 → 点击「登录」
2. 进入知识库，顶栏右侧显示姓名，hover 显示完整身份证号

**生产模式**：
1. 访问 `https://localhost:8000` → 显示登录页面（不会弹证书框）
2. 点击「证书登录」→ 页面跳转到 8443 端口 → 浏览器弹出证书选择框
3. 选择对应证书 → 确认 → 进入知识库

---

## 环境变量

### 基础设施

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | SQLite 数据库路径 | `sqlite:///./knowledge_base.db` |
| `UPLOAD_DIR` | 上传文件存储目录 | `./uploads` |
| `CORS_ORIGINS` | 跨域白名单（Vite 代理模式下通常不需要） | `https://localhost:5173` |

### LLM 文本模型（标题生成、实体提取、纯文本问答）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_API_KEY` | API 密钥 | (空，不配置则禁用 AI 功能) |
| `LLM_API_BASE` | API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名称 | `gpt-4o-mini` |

### 视觉模型（图片描述、视频分析）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VISION_API_KEY` | API 密钥 | 同 `LLM_API_KEY` |
| `VISION_API_BASE` | API 地址 | 同 `LLM_API_BASE` |
| `VISION_MODEL` | 模型名称 | `glm-4v-flash` |

### 语音识别模型（音频转文字）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ASR_API_KEY` | API 密钥 | 同 `LLM_API_KEY` |
| `ASR_API_BASE` | API 地址 | 同 `LLM_API_BASE` |
| `ASR_MODEL` | 模型名称 | `GLM-ASR-2512` |

### 嵌入模型（语义搜索）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `EMBEDDING_API_KEY` | API 密钥 | 同 `LLM_API_KEY` |
| `EMBEDDING_API_BASE` | API 地址 | 同 `LLM_API_BASE` |
| `EMBEDDING_MODEL` | 向量模型 | `embedding-3` |

### 问答

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `QA_TEMPERATURE` | LLM 回答温度 | `0.4` |

### TLS / mTLS

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SSL_CERTFILE` | 服务器证书路径 | `certs/server.crt` |
| `SSL_KEYFILE` | 服务器私钥路径 | `certs/server.key` |
| `SSL_CA_CERTS` | CA 证书路径 | `certs/ca.crt` |
| `ALLOWED_CERT_SUBJECTS` | 允许的证书 subject DN（逗号分隔） | (空) |


---

## API 概览

除 `/api/stats` 外，所有 `/api/*` 路由受 mTLS 保护。

| 方法 | 路由 | 说明 |
|------|------|------|
| `GET/POST` | `/api/articles` | 文章列表 / 创建（含 created_by/updated_by） |
| `GET/PUT/DELETE` | `/api/articles/{id}` | 文章详情 / 更新 / 删除 |
| `GET` | `/api/articles/{id}/download` | 下载附件 |
| `POST` | `/api/articles/{id}/reprocess` | 重新解析全部附件 |
| `POST` | `/api/articles/{id}/reprocess/{safe_name}` | 重新解析单个附件 |
| `GET/POST` | `/api/articles/{id}/comments` | 评论列表 / 创建 |
| `PUT/DELETE` | `/api/articles/{id}/comments/{cid}` | 更新 / 删除评论 |
| `GET/POST` | `/api/categories` | 分类列表 / 创建 |
| `PUT/DELETE` | `/api/categories/{id}` | 分类更新 / 删除 |
| `GET/POST` | `/api/tags` | 标签列表 / 添加 |
| `PUT` | `/api/tags/rename` | 标签重命名 |
| `POST` | `/api/tags/remove` | 删除标签 |
| `GET/POST` | `/api/entities` | 实体列表 / 添加 |
| `PUT` | `/api/entities/update` | 更新实体 |
| `DELETE` | `/api/entities/remove` | 删除实体 |
| `GET/POST` | `/api/entities/{name}/info` | 实体附加信息 |
| `PUT/DELETE` | `/api/entities/{name}/info/{id}` | 更新 / 删除附加信息 |
| `GET` | `/api/graph` | 知识图谱数据 |
| `GET` | `/api/stats` | 统计（公开端点，登录页 Hero 使用） |
| `POST` | `/api/qa/ask` | RAG 问答 |
| `POST` | `/api/qa/parse-file` | 为问答解析上传文件 |
| `POST` | `/api/upload` | 文件上传 |
| `GET` | `/api/media/{filename}` | 媒体文件直链 |
| `GET` | `/api/auth/status` | 证书认证状态 + 用户信息 (name/id_number/display_name) |
| `GET` | `/api/auth/login` | 页面导航登录（生产模式，重定向回前端） |
| `GET` | `/api/health` | 健康检查 |

---

## 数据模型

### Article (文章)
```
id, title, content, category_id, tags (JSON数组), entities (JSON对象),
created_by, updated_by, created_at, updated_at,
attachment_path/name/type, processing
```

### entities 格式
```json
{
  "entities": [{"name": "机器学习", "type": "技术"}],
  "relations": [{"source": "OpenAI", "target": "机器学习", "label": "研发"}]
}
```

### Category (分类)
```
id, name, color, created_by, created_at, updated_at
```
- 记录创建人/时间，仅创建人可修改/删除

### Comment (评论)
```
id, article_id, content, tags (JSON), entities (JSON),
attachments (JSON数组 [{path, name, type}]),
processing, created_by, updated_by, created_at, updated_at
```
- 关联文章，级联删除；支持多附件

### ArticleChunk (文章分块 + 向量)
```
id, article_id, chunk_index, chunk_text, embedding (JSON数组)
```
- 评论内容以 `comment.{id}.{i}` 索引分块纳入

### EntityInfo (实体附加信息)
```
id, entity_name, name, content, created_by, created_at, updated_at
```
- 记录创建人，仅创建人可修改/删除

---

## 架构说明

### 前后端分离
- **开发模式**：后端 `https://localhost:8000`（CERT_OPTIONAL），前端 Vite `https://localhost:5173`，通过自定义代理中间件转发 API 请求，根据 `X-Dev-User` 请求头动态选择客户端证书
- **生产模式**：双端口 — 8000（CERT_NONE）展示登录页（Hero + 证书登录按钮），8443（CERT_REQUIRED）提供全功能应用。前端构建产物放到 `backend/static/`，由两个端口共同服务

### mTLS 证书认证
- 证书 CN 格式为 `[姓名] [18位身份证号]`（如 `谢林 320100198601010018`），后端自动解析为 `name` 和 `id_number`
- **开发模式**：前端显示用户选择页面，Vite 代理中间件根据 `X-Dev-User` 请求头动态选择客户端证书连接后端
- **生产模式**：双端口架构 — 8000（`CERT_NONE`）展示登录页，8443（`CERT_REQUIRED`）提供全功能应用。用户点击登录后跳转到 8443 触发证书选择框
- 顶栏右侧显示姓名，hover 显示完整身份证号
- 证书由自签 CA (`certs/ca.crt`) 签发，客户端 `.p12` 文件导入浏览器即可
- 后端配置 `ssl_ciphers="DEFAULT:@SECLEVEL=0"` 兼容 SHA-1 签名的客户端证书

### 三层访问控制
1. **TLS 层**（8443 端口 `CERT_REQUIRED`）：只有受 CA 签发的证书能完成握手
2. **应用白名单**（`ALLOWED_CERT_SUBJECTS`）：空 = 全部允许；非空 = 仅 CN 精确匹配的证书可访问 `/api/*`
3. **资源权限**：文章/评论/实体/分类基于 `created_by` 身份证号比对，仅创建人可修改/删除

### 开发用户注册表

开发模式下的可选用户在 `vite.config.ts` 的 `DEV_USERS` 和 `LoginPage.tsx` 的 `DEV_USERS` 中维护：

```ts
// vite.config.ts — 代理层（证书路径映射）
const DEV_USERS = {
  zh: { agent: readAgent('client_zh.crt', 'client.key'), displayName: '周衡' },
  xl: { agent: readAgent('client_xl.crt', 'client.key'), displayName: '谢林' },
};

// LoginPage.tsx — 前端界面（用户选择列表）
const DEV_USERS = [
  { key: 'zh', displayName: '周衡' },
  { key: 'xl', displayName: '谢林' },
];
```

添加新用户步骤：
1. 生成客户端证书放入 `certs/` 目录
2. 在 `vite.config.ts` 的 `DEV_USERS` 中注册证书路径
3. 在 `LoginPage.tsx` 的 `DEV_USERS` 中添加界面入口
4. 将用户证书 CN（格式 `姓名 身份证`）加入 `.env` 的 `ALLOWED_CERT_SUBJECTS`

### 文章作者追踪
- 文章创建时自动记录 `created_by`（创建人 CN）和 `updated_by`（更新人 CN）
- 更新文章时仅更新 `updated_by`，`created_by` 保持不变
- 前端仅显示姓名部分（从 `姓名 身份证` 格式中提取），hover 显示完整 CN
- 若文章未更新过（`created_at === updated_at`），不显示更新时间和更新人
- 日期精确到分钟，格式：`2026年7月30日 15:23`

### 模型配置分离
- 四种模型类型独立配置：LLM 文本 / Vision 视觉 / ASR 语音识别 / Embedding 嵌入
- 每种模型有独立的 API Key、Base URL、Model 名称，未配置自动回退到 LLM 配置
- 所有配置统一在 `app/config.py` 中管理

### 提示词管理
- 所有 LLM 提示词集中在 `app/prompts.py`，使用 `{variable}` 占位符
- 涵盖：标签/实体提取、图片/视频描述、标题生成、问答系统提示

### LLM 集成
- 标签/实体提取：共享 `app/llm_extract.py`（60s 超时 + 2 次重试 + JSON 容错解析）
- 上传文件：异步提取（通过 `asyncio.to_thread` 桥接同步函数）+ 后台渐进增强
- 文章编辑：仅内容变更时触发提取
- 标题生成：基于内容理解合成标题（非句子提取），温度 0.7，8000 字符上下文
- Q&A：语义搜索 + LLM 生成回答，GLM-5.2 推理模型有 reasoning_content 回退

### 知识图谱
- `/api/graph` 端点聚合所有文章/分类/实体节点 + 边
- 30 秒 TTL 缓存避免全表扫描
- 前端 `useD3ForceGraph` 共享钩子供 `EntityPanel` 和 `KnowledgeGraph` 共用
- 选中节点仅更新视觉高亮，不重建图谱
- 实体节点使用类型图标区分（人物/组织/地点/事件/产品/其他）

### 向量搜索 (RAG)
- 文章先上传显示，后台 LLM 增强（标题/内容/标签/实体）完成后才计算嵌入
- 文章按 Markdown 标题分段，每段调用 embedding API 生成向量
- 增量计算（`asyncio.Lock` 保护 + 记录已处理文章数）
- 问答时计算 query 向量与所有 chunk 的余弦相似度
- LLM 不可用时自动降级为关键词匹配（CJK 双字母组 + 英文单词）

### 文章内搜索
- 使用 rehype 插件在渲染的 HTML 文本节点中高亮匹配项
- `useDeferredValue` 延迟搜索防抖，大文章下保持输入流畅
- IntersectionObserver 自动跟踪当前可见匹配项
- 底部导航条支持圆点跳转 + ▲▼ 逐项导航

---

## 许可证

MIT
