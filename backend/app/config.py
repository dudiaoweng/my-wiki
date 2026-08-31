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

# ── Q&A ──
QA_TEMPERATURE = float(os.getenv("QA_TEMPERATURE", "0.4"))

# ── 自动解析 ──
# 控制 LLM 类后台解析（媒体描述、标签/实体/标题提取）。文档附件的文本提取
# 是纯本地解析（不调用 LLM），始终自动执行，不受本开关影响。
# 默认关闭（"0"）——仅跳过 LLM 解析，可经 reprocess 端点或前端按钮手动解析。
AUTO_PARSE = os.getenv("AUTO_PARSE", "0") == "1"

# ── Infrastructure ──
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./knowledge_base.db")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "https://localhost:5173")

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
