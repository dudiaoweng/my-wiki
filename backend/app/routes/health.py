"""依赖服务健康检查：Neo4j / Qdrant + 已配置模型。

监测由后端后台任务周期性发起，前端只读取最新快照；多个前端轮询不会
触发重复探测。模型探测仅在配置了 API Key 时执行。
"""

import asyncio
import contextlib
import io
import logging
import time
import wave

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from app import neo4j_store, vector_store
from app.utils import auth_headers
from app.config import (
    LLM_API_KEY, LLM_API_BASE, LLM_MODEL, LLM_TIMEOUT,
    VISION_API_KEY, VISION_API_BASE, VISION_MODEL, VISION_TIMEOUT,
    ASR_API_KEY, ASR_API_BASE, ASR_MODEL, ASR_TIMEOUT,
    EMBEDDING_API_KEY, EMBEDDING_API_BASE, EMBEDDING_MODEL, EMBEDDING_TIMEOUT,
    LLM_MONITOR, VISION_MONITOR, ASR_MONITOR, EMBEDDING_MONITOR,
    HEALTH_MONITOR_INTERVAL, HEALTH_PING_TIMEOUT,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["health"])

# 数据库连通性探测超时（可在 .env 覆盖）
_PING_TIMEOUT = HEALTH_PING_TIMEOUT
# 模型探测与业务调用使用同一超时（LLM_TIMEOUT / VISION_TIMEOUT / ASR_TIMEOUT /
# EMBEDDING_TIMEOUT），探测请求走最小负载，不再单独配置健康检测超时
# 后端巡检间隔（秒，可在 .env 用 HEALTH_MONITOR_INTERVAL 覆盖，最小 60 秒）
_MONITOR_INTERVAL = HEALTH_MONITOR_INTERVAL
# 模型探测结果缓存：健康 5 分钟，异常 1 分钟（尽快恢复提示）
_MODEL_CACHE_TTL = 300.0
_MODEL_ERROR_TTL = 60.0


class DependencyHealth(BaseModel):
    # None = 后端首次巡检尚未完成
    neo4j: bool | None = None
    qdrant: bool | None = None


class ModelHealth(BaseModel):
    configured: bool
    # None = 未配置/未探测；False = 已配置但探测失败
    ok: bool | None = None


class FullHealth(DependencyHealth):
    models: dict[str, ModelHealth] = {}


# 最新巡检快照（由后台任务更新；/deps 只读，/deps/check 手动触发检测）
_snapshot: FullHealth | None = None
_monitor_task: asyncio.Task | None = None
# 手动检测串行锁：多个前端同时点击时依次执行，避免重复探测
_check_lock = asyncio.Lock()


async def _safe_ping(coro) -> bool:
    try:
        return bool(await asyncio.wait_for(coro, timeout=_PING_TIMEOUT))
    except Exception:
        return False


def _should_probe(enabled: bool, base: str, model: str) -> bool:
    """Base/Model 必填，API Key 可选（本地模型通常不鉴权）。"""
    return bool(enabled and (base or "").strip() and (model or "").strip())


async def _probe_chat(base: str, key: str, model: str, timeout: float) -> bool:
    """最小 chat/completions 探测（max_tokens=1），超时与文本/视觉调用一致。"""
    url = f"{base.rstrip('/')}/chat/completions"
    headers = auth_headers(key, json_body=True)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "temperature": 0,
        "stream": False,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if not (200 <= resp.status_code < 300):
            return False
        body = resp.json()
        return isinstance(body, dict) and "error" not in body
    except Exception:
        return False


def _embedding_response_ok(body) -> bool:
    """嵌入响应判定：兼容 OpenAI 对象格式与 llama.cpp 原生数组格式。

    - OpenAI：``{"data": [{"embedding": [...]}]}`` → 对象且无 error
    - llama.cpp：``[{"index": 0, "embedding": [[...]]}]`` → 数组且首项含非空 embedding
    """
    if isinstance(body, list):
        if not body or not isinstance(body[0], dict):
            return False
        emb = body[0].get("embedding")
        return isinstance(emb, list) and len(emb) > 0
    return isinstance(body, dict) and "error" not in body


async def _probe_embedding(base: str, key: str, model: str, timeout: float) -> bool:
    url = f"{base.rstrip('/')}/embeddings"
    headers = auth_headers(key, json_body=True)
    payload = {"model": model, "input": "ping"}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if not (200 <= resp.status_code < 300):
            return False
        return _embedding_response_ok(resp.json())
    except Exception:
        return False


def _silent_wav(seconds: float = 0.2, rate: int = 16000) -> bytes:
    """生成一小段静音 WAV，用于 ASR 端点探测（无需真实语音文件）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


async def _probe_asr(base: str, key: str, model: str, timeout: float) -> bool:
    """ASR 探测：发送静音 WAV，超时与语音识别调用一致。

    2xx 视为健康；401/403/404/5xx/网络错误视为异常；
    其他 4xx（如静音被拒）说明服务可达且鉴权通过，不判为异常。
    """
    url = f"{base.rstrip('/').replace('/chat/completions', '')}/audio/transcriptions"
    headers = auth_headers(key)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url,
                headers=headers,
                data={"model": model},
                files={"file": ("ping.wav", _silent_wav(), "audio/wav")},
            )
        if 200 <= resp.status_code < 300:
            return True
        return resp.status_code not in (401, 403, 404) and resp.status_code < 500
    except Exception:
        return False


# 每类模型：(前缀, Key, Base, Model, 探测方式, 探测超时=业务调用超时, 是否参与检测)
_MODEL_SPECS = {
    "text": ("LLM", LLM_API_KEY, LLM_API_BASE, LLM_MODEL, "chat", LLM_TIMEOUT, LLM_MONITOR),
    "vision": ("VISION", VISION_API_KEY, VISION_API_BASE, VISION_MODEL, "chat", VISION_TIMEOUT, VISION_MONITOR),
    "asr": ("ASR", ASR_API_KEY, ASR_API_BASE, ASR_MODEL, "asr", ASR_TIMEOUT, ASR_MONITOR),
    "embedding": ("EMBEDDING", EMBEDDING_API_KEY, EMBEDDING_API_BASE, EMBEDDING_MODEL, "embedding", EMBEDDING_TIMEOUT, EMBEDDING_MONITOR),
}

_model_cache: tuple[float, dict[str, ModelHealth]] | None = None
_model_lock = asyncio.Lock()


async def _probe_models() -> dict[str, ModelHealth]:
    async def probe_one(kind: str) -> tuple[str, ModelHealth]:
        _, key, base, model, mode, timeout, enabled = _MODEL_SPECS[kind]
        if not _should_probe(enabled, base, model):
            return kind, ModelHealth(configured=False, ok=None)
        if mode == "asr":
            ok = await _probe_asr(base, key, model, timeout)
        elif mode == "embedding":
            ok = await _probe_embedding(base, key, model, timeout)
        else:
            ok = await _probe_chat(base, key, model, timeout)
        return kind, ModelHealth(configured=True, ok=ok)

    pairs = await asyncio.gather(*(probe_one(kind) for kind in _MODEL_SPECS))
    return dict(pairs)


async def _get_model_health() -> dict[str, ModelHealth]:
    """带缓存的模型状态：健康结果缓存 5 分钟，异常结果缓存 1 分钟。"""
    global _model_cache
    now = time.monotonic()
    if _model_cache is not None:
        ts, cached = _model_cache
        has_error = any(m.configured and m.ok is False for m in cached.values())
        ttl = _MODEL_ERROR_TTL if has_error else _MODEL_CACHE_TTL
        if now - ts < ttl:
            return cached

    async with _model_lock:
        now = time.monotonic()
        if _model_cache is not None:
            ts, cached = _model_cache
            has_error = any(m.configured and m.ok is False for m in cached.values())
            ttl = _MODEL_ERROR_TTL if has_error else _MODEL_CACHE_TTL
            if now - ts < ttl:
                return cached
        fresh = await _probe_models()
        _model_cache = (time.monotonic(), fresh)
        return fresh


async def _monitor_loop() -> None:
    """后台巡检：按 HEALTH_MONITOR_INTERVAL（默认 600 秒）更新状态；模型按缓存 TTL 探测。"""
    global _snapshot
    while True:
        try:
            neo4j_ok, qdrant_ok = await asyncio.gather(
                _safe_ping(neo4j_store.ping_async()),
                _safe_ping(vector_store.ping()),
            )
            # 先更新数据库状态，模型探测较慢时不阻塞快照可用
            _snapshot = FullHealth(
                neo4j=neo4j_ok,
                qdrant=qdrant_ok,
                models=(_snapshot.models if _snapshot else {}),
            )
            models = await _get_model_health()
            _snapshot = FullHealth(neo4j=neo4j_ok, qdrant=qdrant_ok, models=models)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Health monitor iteration failed", exc_info=True)
            _snapshot = FullHealth(
                neo4j=False,
                qdrant=False,
                models=(_snapshot.models if _snapshot else {}),
            )
        await asyncio.sleep(_MONITOR_INTERVAL)


def start_monitor() -> None:
    """启动后台巡检（幂等：双 uvicorn 共用 app 时只启动一次）。"""
    global _monitor_task
    if _monitor_task is not None and not _monitor_task.done():
        return
    _monitor_task = asyncio.create_task(_monitor_loop(), name="health-monitor")


async def stop_monitor() -> None:
    global _monitor_task
    task, _monitor_task = _monitor_task, None
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@router.get("/deps", response_model=FullHealth)
async def dependency_health():
    """只读：返回后台巡检的最新快照，不触发任何探测。"""
    return _snapshot or FullHealth(models={})


@router.post("/deps/check", response_model=FullHealth)
async def check_dependency_health():
    """手动触发一次完整检测（Neo4j/Qdrant + 强制模型探测），更新并返回最新快照。"""
    global _snapshot, _model_cache
    async with _check_lock:
        neo4j_ok, qdrant_ok = await asyncio.gather(
            _safe_ping(neo4j_store.ping_async()),
            _safe_ping(vector_store.ping()),
        )
        # 与后台巡检共用模型探测锁 + 缓存，避免同一时刻重复探测
        async with _model_lock:
            models = await _probe_models()
            _model_cache = (time.monotonic(), models)
        _snapshot = FullHealth(neo4j=neo4j_ok, qdrant=qdrant_ok, models=models)
        return _snapshot
