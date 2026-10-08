# ─── Stage 0: static ffmpeg binary ──────────────────
# 静态构建的 ffmpeg 单二进制，替代 apt 版（apt 版含编码器全家桶 ~450MB）
FROM mwader/static-ffmpeg:7.0 AS ffmpeg

# ─── Stage 1: Build frontend ─────────────────────────
FROM node:18-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# vite.config.ts 在加载时读取 ../certs 下的证书文件
COPY certs/ ../certs/
# 输出到 backend/static（与 vite.config.ts 的 outDir 一致）
RUN npm run build

# ─── Stage 2: Python runtime ─────────────────────────
FROM python:3.11-slim

WORKDIR /app

# 系统依赖：
#   libglib2.0-0    — opencv-python-headless 运行所需
# ffmpeg 用 Stage 0 的静态二进制（音频转码 / 视频缩略图），不装 apt 版
# 注意：不安装 libgl1 —— headless 版 OpenCV 只做 VideoCapture/帧提取，无需 OpenGL/GUI 库
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 静态 ffmpeg 二进制（自包含，无共享库依赖）
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

# 后端依赖（opencv-headless 用于视频关键帧提取）
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir opencv-python-headless

# 后端代码
COPY backend/app ./app
COPY backend/run.py ./

# 前端构建产物
COPY --from=frontend-build /build/backend/static ./static

# 注：certs 不复制进镜像 — 运行时通过 -v ./certs:/app/certs:ro 挂载

# SQLite 数据 + 上传文件持久化
VOLUME ["/app/data"]

# 默认值 — 实际运行时由挂载的 /app/.env 覆盖（config.py load_dotenv 加载）。
# QDRANT_URL 统一在 .env 中配置（Docker 用 http://qdrant:6333、本地开发用 localhost）
# 数据统一在 /app/data（数据库 + 上传文件，compose 挂载 ./data:/app/data）
ENV DATABASE_URL=sqlite:////app/data/knowledge_base.db \
    UPLOAD_DIR=/app/data/uploads \
    HOST=0.0.0.0 \
    SSL_KEYFILE=/certs/server.key \
    SSL_CERTFILE=/certs/server.crt \
    SSL_CA_CERTS=/certs/ca.crt \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 登录页端口 (8000) + 应用端口 (8444，纯 HTTP，仅 nginx 前置访问)
EXPOSE 8000 8444

# 健康检查：8444 为容器内纯 HTTP，无需处理自签证书
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8444/api/health',timeout=3)" || exit 1

CMD ["python", "run.py"]
