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

# 注：certs 不再复制进镜像 — 运行时通过 -v ./certs:/app/certs:ro 挂载

# SQLite 数据 + 上传文件持久化
VOLUME ["/app/data", "/app/uploads"]

# 默认值 — 实际运行时由 env_file（backend/.env）和 compose environment 覆盖
ENV DATABASE_URL=sqlite:////app/data/knowledge_base.db \
    UPLOAD_DIR=/app/uploads \
    HOST=0.0.0.0 \
    SSL_KEYFILE=/certs/server.key \
    SSL_CERTFILE=/certs/server.crt \
    SSL_CA_CERTS=/certs/ca.crt \
    PYTHONUNBUFFERED=1

# 登录页端口 + 应用端口
EXPOSE 8000 8443

CMD ["python", "run.py"]
