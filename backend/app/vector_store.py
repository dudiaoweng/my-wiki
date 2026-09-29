"""Qdrant 向量存储封装。

SQLite（ArticleChunk）仍是数据真相源；Qdrant 仅作检索索引（派生数据，
可随时从 SQLite 重建）。本模块不 import 任何 app.routes.*，避免循环依赖。

写入路径 best-effort：Qdrant 掉线时仅 log warning，不影响主流程；
检索路径严格依赖 Qdrant：失败抛 VectorStoreError，由调用方决定降级文案。
"""

import asyncio
import logging

from qdrant_client import AsyncQdrantClient, models

from app.config import (
    QDRANT_URL,
    QDRANT_API_KEY,
    QDRANT_COLLECTION,
    QDRANT_VECTOR_SIZE,
    QDRANT_TIMEOUT,
)

logger = logging.getLogger(__name__)

UPSERT_BATCH_SIZE = 100
SCROLL_BATCH_SIZE = 256


class VectorStoreError(Exception):
    """Qdrant 不可用（连接失败 / collection 缺失等）。"""


_client: AsyncQdrantClient | None = None
_main_loop: asyncio.AbstractEventLoop | None = None


def get_client() -> AsyncQdrantClient:
    """懒加载单例客户端；首次在异步上下文调用时捕获主事件循环
    （供 sync 路由线程经 run_coroutine_threadsafe 调度删除操作）。"""
    global _client, _main_loop
    if _client is None:
        try:
            _main_loop = asyncio.get_running_loop()
        except RuntimeError:
            pass  # sync 上下文（线程池路由）——无 loop，调度时跳过
        _client = AsyncQdrantClient(
            url=QDRANT_URL,
            api_key=QDRANT_API_KEY or None,
            timeout=QDRANT_TIMEOUT,
        )
    return _client


async def close() -> None:
    """幂等关闭客户端（lifespan 退出时调用）。"""
    global _client
    if _client is not None:
        try:
            await _client.close()
        except Exception:
            logger.warning("Qdrant client close failed", exc_info=True)
        finally:
            _client = None


async def ping() -> bool:
    """健康检查：连接 Qdrant 并确认集合存在。"""
    try:
        client = get_client()
        return bool(await client.collection_exists(QDRANT_COLLECTION))
    except Exception:
        return False


async def ensure_collection(sample_dim: int | None = None) -> int:
    """确保集合存在且维度一致，返回生效的向量维度。

    - 不存在：按 sample_dim（DB 采样）或 QDRANT_VECTOR_SIZE 创建
    - 存在但维度不符：recreate（Qdrant 是派生数据，可从 SQLite 重建）
    - 创建 article_id 的 KEYWORD payload 索引（幂等，已存在报错忽略）
    """
    client = get_client()
    dim = sample_dim or QDRANT_VECTOR_SIZE
    try:
        if not await client.collection_exists(QDRANT_COLLECTION):
            await client.create_collection(
                collection_name=QDRANT_COLLECTION,
                vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
            )
            logger.info("Qdrant collection created: %s (dim=%d)", QDRANT_COLLECTION, dim)
        else:
            info = await client.get_collection(QDRANT_COLLECTION)
            existing_dim = info.config.params.vectors.size
            if existing_dim != dim:
                await client.recreate_collection(
                    collection_name=QDRANT_COLLECTION,
                    vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
                )
                logger.warning(
                    "Qdrant collection dim mismatch (%d != %d) — recreated, full re-sync required",
                    existing_dim, dim,
                )

        try:
            await client.create_payload_index(
                collection_name=QDRANT_COLLECTION,
                field_name="article_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:
            pass  # 索引已存在 → 报错忽略（幂等）

        return dim
    except Exception as e:
        raise VectorStoreError(f"Qdrant collection 初始化失败：{e}") from e


def make_point(
    chunk_id: str,
    vector: list[float],
    article_id: str,
    chunk_index: str,
    chunk_text: str,
) -> models.PointStruct:
    """构造 Qdrant point：id = 分块 uuid（跨 payload 更新稳定），
    payload 供按文章过滤删除。entities 不入 payload——DB 是唯一真相源。"""
    return models.PointStruct(
        id=chunk_id,
        vector=vector,
        payload={
            "article_id": article_id,
            "chunk_index": chunk_index,
            "chunk_text": chunk_text,
        },
    )


async def upsert_chunks(points: list[models.PointStruct]) -> None:
    """Best-effort 批量 upsert；失败仅 log warning（SQLite 仍为真相源）。"""
    if not points:
        return
    client = get_client()
    for i in range(0, len(points), UPSERT_BATCH_SIZE):
        batch = points[i:i + UPSERT_BATCH_SIZE]
        try:
            await client.upsert(
                collection_name=QDRANT_COLLECTION,
                points=batch,
                wait=True,
            )
        except Exception:
            logger.warning(
                "Qdrant upsert failed (%d points, batch %d)", len(batch), i // UPSERT_BATCH_SIZE,
                exc_info=True,
            )
            return  # 失败即中止后续批次，避免刷屏；启动同步会补差


async def delete_points(ids: list[str]) -> None:
    """按点 ID 删除（best-effort）。"""
    if not ids:
        return
    client = get_client()
    try:
        await client.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=models.PointIdsList(points=ids),
            wait=True,
        )
    except Exception:
        logger.warning("Qdrant delete failed (%d point ids)", len(ids), exc_info=True)


async def delete_by_article(article_id: str) -> None:
    """按 article_id payload 过滤删除该文章全部分块点（best-effort）。"""
    client = get_client()
    try:
        await client.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[models.FieldCondition(
                        key="article_id",
                        match=models.MatchValue(value=article_id),
                    )],
                ),
            ),
            wait=True,
        )
    except Exception:
        logger.warning("Qdrant delete by article failed: %s", article_id, exc_info=True)


async def search(query_vector: list[float], limit: int) -> list[models.ScoredPoint]:
    """语义检索。Cosine 距离下 score 即相似度（越大越相关）。

    检索路径严格依赖 Qdrant：失败抛 VectorStoreError，由调用方决定降级。
    """
    client = get_client()
    try:
        res = await client.query_points(
            collection_name=QDRANT_COLLECTION,
            query=query_vector,
            limit=limit,
            with_payload=True,
            with_vectors=False,
        )
    except Exception as e:
        raise VectorStoreError(f"Qdrant 检索失败：{e}") from e
    return list(res.points)


async def list_existing_ids() -> set[str]:
    """scroll 遍历集合内所有点 ID（with_payload/vectors 关闭，只取 id）。"""
    client = get_client()
    ids: set[str] = set()
    offset = None
    while True:
        try:
            points, offset = await client.scroll(
                collection_name=QDRANT_COLLECTION,
                limit=SCROLL_BATCH_SIZE,
                offset=offset,
                with_payload=False,
                with_vectors=False,
            )
        except Exception as e:
            raise VectorStoreError(f"Qdrant scroll 失败：{e}") from e
        ids.update(p.id for p in points)
        if offset is None:
            break
    return ids


def schedule_delete_points(ids: list[str]) -> None:
    """线程安全 fire-and-forget 删除（sync 路由从线程池调用）。

    主事件循环存在时经 run_coroutine_threadsafe 调度；否则 log 跳过——
    下次启动的孤儿清理会兜底清除泄漏点。
    """
    if not ids:
        return
    if _main_loop is not None and _main_loop.is_running():
        try:
            asyncio.run_coroutine_threadsafe(delete_points(ids), _main_loop)
        except Exception:
            logger.warning("Qdrant scheduled delete failed (%d ids)", len(ids), exc_info=True)
    else:
        logger.warning(
            "Qdrant client not initialised — skip deleting %d points (startup orphan clean will heal)",
            len(ids),
        )


def schedule_delete_by_article(article_id: str) -> None:
    """线程安全 fire-and-forget 按文章删除（sync 路由从线程池调用）。"""
    if _main_loop is not None and _main_loop.is_running():
        try:
            asyncio.run_coroutine_threadsafe(delete_by_article(article_id), _main_loop)
        except Exception:
            logger.warning("Qdrant scheduled delete failed: %s", article_id, exc_info=True)
    else:
        logger.warning(
            "Qdrant client not initialised — skip deleting article %s (startup orphan clean will heal)",
            article_id,
        )
