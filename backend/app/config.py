"""Centralised configuration loaded from environment variables.

All modules should import from here instead of calling os.getenv() directly.
"""

import os
from dotenv import load_dotenv

load_dotenv()

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

# ── Infrastructure ──
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./knowledge_base.db")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "https://localhost:5173")

# ── TLS / mTLS ──
SSL_CERTFILE = os.getenv("SSL_CERTFILE", "certs/server.crt")
SSL_KEYFILE = os.getenv("SSL_KEYFILE", "certs/server.key")
SSL_CA_CERTS = os.getenv("SSL_CA_CERTS", "certs/ca.crt")
ALLOWED_CERT_SUBJECTS = [
    s.strip()
    for s in os.getenv("ALLOWED_CERT_SUBJECTS", "").split(",")
    if s.strip()
]
