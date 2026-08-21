# ─── Stage 1: Build frontend ─────────────────────────
FROM node:18-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install

COPY frontend/ ./
# vite.config.ts 在加载时读取 ../certs 下的证书文件
COPY certs/ ../certs/
# 输出到 backend/static（与 vite.config.ts 的 outDir 一致）
RUN npm run build

# ─── Stage 2: Python runtime ─────────────────────────
FROM python:3.11-slim

WORKDIR /app

# 系统依赖：ffmpeg（音视频处理）+ OpenCV 所需库
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 后端依赖（opencv-headless 用于视频关键帧提取）
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir opencv-python-headless

# 后端代码
COPY backend/app ./app
COPY backend/run.py ./

# 前端构建产物
COPY --from=frontend-build /build/backend/static ./static

# mTLS 证书（生产环境需挂载真实证书，构建时复制便于默认运行）
COPY certs ./certs

# SQLite 数据 + 上传文件持久化
VOLUME ["/app/data", "/app/uploads"]

ENV DATABASE_URL=sqlite:////app/data/knowledge_base.db \
    UPLOAD_DIR=/app/uploads \
    HOST=0.0.0.0 \
    SSL_KEYFILE=/app/certs/server.key \
    SSL_CERTFILE=/app/certs/server.crt \
    SSL_CA_CERTS=/app/certs/ca.crt \
    PYTHONUNBUFFERED=1

# 登录页端口 + 应用端口
EXPOSE 8000 8443

CMD ["python", "run.py"]
