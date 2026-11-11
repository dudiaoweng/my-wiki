"""Centralised configuration loaded from environment variables.

All modules should import from here instead of calling os.getenv() directly.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# 统一加载仓库根目录 .env（Docker 与本地开发共用同一份）：
# - 容器内：cwd=/app，挂载的 /app/.env 由第一次 load_dotenv 命中
# - 本地开发：cwd 在 backend/ 下，由第二次显式加载仓库根目录文件命中
load_dotenv()
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

# ── LLM text model (title generation, entity extraction, text Q&A) ──
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

# ── Vision model (image description, video analysis) ──
VISION_API_KEY = os.getenv("VISION_API_KEY", LLM_API_KEY)
VISION_API_BASE = os.getenv("VISION_API_BASE", LLM_API_BASE)
VISION_MODEL = os.getenv("VISION_MODEL", "glm-4v-flash")

# ── Speech recognition model (audio transcription) ──
ASR_API_KEY = os.getenv("ASR_API_KEY", LLM_API_KEY)
ASR_API_BASE = os.getenv("ASR_API_BASE", LLM_API_BASE)
ASR_MODEL = os.getenv("ASR_MODEL", "GLM-ASR-2512")

# ── Embedding model (semantic search) ──
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", LLM_API_KEY)
EMBEDDING_API_BASE = os.getenv("EMBEDDING_API_BASE", LLM_API_BASE)
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "embedding-3")


def _env_any_nonempty(*names: str) -> bool:
    return any((os.getenv(name) or "").strip() for name in names)


# 模型是否参与健康检测：API Key 非必填（本地 llama-server 等通常不鉴权）。
# 显式配置了该模型的任一变量，或继承了非空 API Key，则视为已配置；
# 完全未配置时保持 unconfigured，避免默认端点在无 Key 时误报异常。
LLM_MONITOR = _env_any_nonempty("LLM_API_KEY", "LLM_API_BASE", "LLM_MODEL")
VISION_MONITOR = _env_any_nonempty("VISION_API_KEY", "VISION_API_BASE", "VISION_MODEL") or bool(VISION_API_KEY.strip())
ASR_MONITOR = _env_any_nonempty("ASR_API_KEY", "ASR_API_BASE", "ASR_MODEL") or bool(ASR_API_KEY.strip())
EMBEDDING_MONITOR = _env_any_nonempty("EMBEDDING_API_KEY", "EMBEDDING_API_BASE", "EMBEDDING_MODEL") or bool(EMBEDDING_API_KEY.strip())

# 业务调用可用性：Base/Model 必填，API Key 可选；未显式配置且无继承 Key 时视为未启用
LLM_READY = LLM_MONITOR and bool(LLM_API_BASE.strip()) and bool(LLM_MODEL.strip())
VISION_READY = VISION_MONITOR and bool(VISION_API_BASE.strip()) and bool(VISION_MODEL.strip())
ASR_READY = ASR_MONITOR and bool(ASR_API_BASE.strip()) and bool(ASR_MODEL.strip())
EMBEDDING_READY = EMBEDDING_MONITOR and bool(EMBEDDING_API_BASE.strip()) and bool(EMBEDDING_MODEL.strip())

# ── Q&A ──
QA_TEMPERATURE = float(os.getenv("QA_TEMPERATURE", "0.4"))

# ── Prompt 配置 ──
# 提示词目录：每个 prompt 一个同名 .txt 文件（文件名对应 prompts.py 内置默认的
# prompt 名称，如 GENERATE_TITLE.txt），文件内容即为该提示词全文，存在则覆盖默认值。
# 路径锚定仓库根目录 prompts/；容器内由 Dockerfile ENV 覆盖为 /app/prompts
# （compose 挂载 ./prompts:/app/prompts:ro）。修改后重启后端生效。
PROMPTS_DIR = os.getenv("PROMPTS_DIR", str(Path(__file__).resolve().parents[2] / "prompts"))

# ── 超时配置（秒）──
# 各类模型调用的超时上限，可用环境变量覆盖；未设置或值非法时回退到代码默认值。
# 本地模型加载较慢时可调大 LLM_TIMEOUT。
def _env_float(name: str, default: float) -> float:
    """读取环境变量为 float，未设置或非法值回退默认（保留默认值，避免启动崩溃）。"""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    """读取环境变量为 int，未设置或非法值回退默认。"""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


LLM_TIMEOUT = _env_float("LLM_TIMEOUT", 120.0)       # 文本 LLM：问答、分段实体提取、上传文档解析
VISION_TIMEOUT = _env_float("VISION_TIMEOUT", 120.0) # 视觉模型：图片描述、视频分析
ASR_TIMEOUT = _env_float("ASR_TIMEOUT", 120.0)       # 语音识别：音频转文字
EMBEDDING_TIMEOUT = _env_float("EMBEDDING_TIMEOUT", 30.0)  # 嵌入模型：语义搜索
FFMPEG_TIMEOUT = _env_int("FFMPEG_TIMEOUT", 60)      # ffmpeg 音视频转换（子进程）

# ── 健康巡检 ──
# 后台巡检间隔（秒）：每轮探测 Neo4j/Qdrant 并更新模型状态快照。
# 最小 60 秒，避免配置为 0/负数或过小值导致后台任务空转/频繁探测；默认 600 秒（10 分钟）。
HEALTH_MONITOR_INTERVAL = max(60.0, _env_float("HEALTH_MONITOR_INTERVAL", 600.0))
# Neo4j / Qdrant 连通性探测超时；模型探测统一复用上方各类模型的调用超时
# （LLM_TIMEOUT / VISION_TIMEOUT / ASR_TIMEOUT / EMBEDDING_TIMEOUT），不单独配置。
HEALTH_PING_TIMEOUT = _env_float("HEALTH_PING_TIMEOUT", 3.0)

# 检索结果的最低相关度阈值（Cosine 相似度，越大越相关）。
# embedding-3（2048 维）对真实匹配块的分数普遍在 0.3-0.42，0.4 会漏掉有效结果；
# 默认 0.3 兼顾召回与噪声过滤（噪声块通常 < 0.27）。
QA_MIN_RELEVANCE = _env_float("QA_MIN_RELEVANCE", 0.3)

# 分块大小上限（字符）：检索/提取共用的向量分块切分粒度。
# 512 ≈ 500-800 token，兼顾嵌入质量与检索精度；改动后需执行
# backend/rebuild_chunks.py 一次性全量重建存量分块。
MAX_CHUNK_CHARS = _env_int("MAX_CHUNK_CHARS", 512)

# 分块重叠（字符）：相邻分块共享的尾部字符数，缓解语义在块边界被切断。
# 块总长仍 ≤ MAX_CHUNK_CHARS（基础切分按 MAX_CHUNK_CHARS - OVERLAP 进行）。
# 改动后同样需执行 rebuild_chunks.py 全量重建。
CHUNK_OVERLAP = _env_int("CHUNK_OVERLAP", 100)

# ── 自动解析 ──
# 控制上传后/内容修改后的自动解析（媒体描述、标签/实体/标题提取、文档文本提取）。
# 关闭（"0"）时：文章与评论的新增附件/内容修改不做任何自动解析，保留
# "待解析"占位；唯一例外是 /api/upload 上传入口的文档文本提取（始终自动，
# 纯本地解析不调用 LLM）。可经 reprocess 端点或前端按钮手动解析。
AUTO_PARSE = os.getenv("AUTO_PARSE", "0") == "1"

# ── Infrastructure ──
# 数据统一存放于仓库根 data/ 目录（本地开发与 Docker 部署共用同一位置，
# Docker 挂载 ./data:/app/data；路径锚定仓库根，与启动时 cwd 无关）
_DATA_DIR = Path(__file__).resolve().parents[2] / "data"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{(_DATA_DIR / 'knowledge_base.db').as_posix()}")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", str(_DATA_DIR / "uploads"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "https://localhost:5173")

# ── Qdrant 向量数据库（语义检索）──
# 统一在 .env 中配置：Docker 部署用 http://qdrant:6333（compose 网络服务名），
# 本地开发用 http://localhost:6333（代码默认值）。
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", "")
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "my_wiki_chunks")
QDRANT_VECTOR_SIZE = _env_int("QDRANT_VECTOR_SIZE", 1024)  # embedding-3 / bge-m3 均为 1024 维
QDRANT_TIMEOUT = _env_float("QDRANT_TIMEOUT", 10.0)

# ── Neo4j 图数据库（实体/关系存储）──
# 统一在 .env 中配置：Docker 部署用 bolt://neo4j:7687（compose 网络服务名），
# 本地开发用 bolt://localhost:7687（代码默认值）。
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
# 默认值与 docker-compose.yml 的 NEO4J_AUTH 插值默认值保持一致
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "my-wiki-neo4j")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")
NEO4J_TIMEOUT = _env_float("NEO4J_TIMEOUT", 10.0)

# ── 知识图谱 ──
# 当前图谱节点数上限：/api/graph 随响应下发，前端在按选中文章/目录过滤后的
# 当前图谱上截断节点并同步过滤边（避免全局先截断误删当前文章的实体）。
# 可按部署规模在 .env 中调整；前端 D3 渲染量随该值增长。
GRAPH_MAX_NODES = _env_int("GRAPH_MAX_NODES", 500)

# ── TLS / mTLS ──
# 证书固定放在仓库根目录 certs/ 下；默认值锚定到仓库根目录，与启动时 cwd 无关
# （本地开发 cwd 在 backend/ 下同样命中）。容器内由 Dockerfile ENV 覆盖为 /certs/*。
_CERTS_DIR = Path(__file__).resolve().parents[2] / "certs"
SSL_CERTFILE = os.getenv("SSL_CERTFILE", str(_CERTS_DIR / "server.crt"))
SSL_KEYFILE = os.getenv("SSL_KEYFILE", str(_CERTS_DIR / "server.key"))
SSL_CA_CERTS = os.getenv("SSL_CA_CERTS", str(_CERTS_DIR / "ca.crt"))
ALLOWED_CERT_SUBJECTS = [
    s.strip()
    for s in os.getenv("ALLOWED_CERT_SUBJECTS", "").split(",")
    if s.strip()
]
