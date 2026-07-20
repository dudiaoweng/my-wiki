"""Centralised configuration loaded from environment variables."""

import os
from dotenv import load_dotenv

load_dotenv()

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "embedding-3")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./knowledge_base.db")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173")
