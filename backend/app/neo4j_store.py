"""Neo4j 图存储封装——实体/关系的唯一存储（v2.3 起）。

Neo4j 完全接管实体与关系数据：实体节点、文章提及边（MENTIONS）、实体关系边
（RELATES）只存 Neo4j；SQLite 仅保留文章/评论/分块文本与 entity_infos 附加信息。
本模块不 import 任何 app.routes.*，避免循环依赖。

与 Qdrant（向量是派生数据、可随时从 SQLite 重建）不同：实体数据在列删除后
没有 SQLite 备份来源，因此写路径**严格**——存储层内置 3 次退避重试，重试
耗尽抛 Neo4jStoreError，由调用方按失败策略决定降级或报错。
读路径同样抛 Neo4jStoreError，调用方自行降级（前端容忍 entities=null）。

sync 路由（线程池）用同步 driver；async 路由/后台任务用异步 driver。
同步 driver 线程安全、每调用独立 session；异步 driver 仅在事件循环内创建使用。
"""

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone

from neo4j import GraphDatabase, AsyncGraphDatabase
from neo4j.exceptions import (
    ServiceUnavailable,
    TransientError,
    SessionExpired,
)

from app.config import (
    NEO4J_URI,
    NEO4J_USER,
    NEO4J_PASSWORD,
    NEO4J_DATABASE,
    NEO4J_TIMEOUT,
)

logger = logging.getLogger(__name__)
# Ensure custom log messages are visible alongside uvicorn access logs（qa.py 同款）
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

_WRITE_RETRIES = 3
_RETRY_BACKOFF = (1.0, 2.0)  # 秒；共 3 次尝试（2 次退避睡眠）

# 启动迁移重试：Neo4j 容器启动较慢时最多等 5×30s，之后放弃（下次启动重试）
_MIGRATION_RETRIES = 5
_MIGRATION_RETRY_DELAY = 30.0


class Neo4jStoreError(Exception):
    """Neo4j 不可用（连接失败 / 语法错误 / 认证失败等）。"""


_sync_driver = None
_async_driver = None
_migration_started = False
_driver_lock = threading.Lock()

# 熔断降级：Neo4j 连接级故障后 30 秒内快速失败（避免每次读路径阻塞 10s 超时
# 拖垮线程池）；任何操作成功后立即复位
_down_until = 0.0
_FAIL_FAST_SECONDS = 30.0


# ─── 连接层 ──────────────────────────────────────

def get_sync_driver():
    """懒加载同步 driver（线程安全，供线程池中的 sync 路由使用）。"""
    global _sync_driver
    if _sync_driver is None:
        with _driver_lock:
            if _sync_driver is None:
                _sync_driver = GraphDatabase.driver(
                    NEO4J_URI,
                    auth=(NEO4J_USER, NEO4J_PASSWORD),
                    connection_timeout=NEO4J_TIMEOUT,
                    connection_acquisition_timeout=NEO4J_TIMEOUT,
                )
    return _sync_driver


def get_async_driver():
    """懒加载异步 driver；必须在事件循环内创建（绑定主循环）。"""
    global _async_driver
    if _async_driver is None:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            raise Neo4jStoreError("异步 driver 必须在事件循环内初始化")
        _async_driver = AsyncGraphDatabase.driver(
            NEO4J_URI,
            auth=(NEO4J_USER, NEO4J_PASSWORD),
            connection_timeout=NEO4J_TIMEOUT,
            connection_acquisition_timeout=NEO4J_TIMEOUT,
        )
    return _async_driver


async def close() -> None:
    """幂等关闭两个 driver（lifespan 退出时调用）。"""
    global _sync_driver, _async_driver
    if _async_driver is not None:
        try:
            await _async_driver.close()
        except Exception:
            logger.warning("Neo4j async driver close failed", exc_info=True)
        finally:
            _async_driver = None
    if _sync_driver is not None:
        try:
            _sync_driver.close()
        except Exception:
            logger.warning("Neo4j sync driver close failed", exc_info=True)
        finally:
            _sync_driver = None


def ping_sync() -> bool:
    """健康检查：连接并验证连通性。"""
    try:
        get_sync_driver().verify_connectivity()
        return True
    except Exception:
        return False


async def ping_async() -> bool:
    try:
        await get_async_driver().verify_connectivity()
        return True
    except Exception:
        return False


# ─── 执行层 ──────────────────────────────────────

def _is_retryable(e: Exception) -> bool:
    return isinstance(e, (ServiceUnavailable, TransientError, SessionExpired, OSError))


def _check_fail_fast() -> None:
    """熔断窗口内直接抛错（快速降级），避免每次调用等满连接超时。"""
    global _down_until
    if _down_until and time.time() < _down_until:
        raise Neo4jStoreError("Neo4j 暂不可用（熔断降级中，30 秒内自动重试）")


def _note_failure(e: Exception) -> None:
    """连接级故障 → 打开熔断窗口。"""
    global _down_until
    if _is_retryable(e):
        _down_until = time.time() + _FAIL_FAST_SECONDS


def _note_success() -> None:
    global _down_until
    _down_until = 0.0


def _collect(tx, cypher: str, params: dict | None) -> list:
    """同步事务收集结果（sync driver 的 tx.run 直接返回 result）。"""
    return list(tx.run(cypher, params or {}))


async def _collect_async(tx, cypher: str, params: dict | None) -> list:
    """异步事务收集结果（async driver 的 tx.run 返回协程 → AsyncResult，
    data() 同样需 await）。"""
    result = await tx.run(cypher, params or {})
    return await result.data()


def _run_sync(cypher: str, params: dict | None = None, write: bool = False) -> list:
    """同步执行 Cypher。写路径内置 3 次退避重试（仅对可重试异常）；
    任何最终失败都包装为 Neo4jStoreError。"""
    _check_fail_fast()
    attempts = _WRITE_RETRIES if write else 1
    last = None
    for attempt in range(attempts):
        try:
            with get_sync_driver().session(database=NEO4J_DATABASE) as session:
                if write:
                    result = session.execute_write(lambda tx: _collect(tx, cypher, params))
                else:
                    result = session.execute_read(lambda tx: _collect(tx, cypher, params))
            _note_success()
            return result
        except Exception as e:
            _note_failure(e)
            last = e
            retryable = write and _is_retryable(e) and attempt < attempts - 1
            if not retryable:
                raise Neo4jStoreError(f"Neo4j 操作失败：{e}") from e
            logger.warning("Neo4j transient error, retry %d/%d: %s", attempt + 2, attempts, e)
            time.sleep(_RETRY_BACKOFF[attempt])
    raise Neo4jStoreError(f"Neo4j 操作失败：{last}")  # 不可达，防御


async def _run_async(cypher: str, params: dict | None = None, write: bool = False) -> list:
    """异步执行 Cypher（语义同 _run_sync）。"""
    _check_fail_fast()
    attempts = _WRITE_RETRIES if write else 1
    last = None
    for attempt in range(attempts):
        try:
            async with get_async_driver().session(database=NEO4J_DATABASE) as session:
                if write:
                    result = await session.execute_write(lambda tx: _collect_async(tx, cypher, params))
                else:
                    result = await session.execute_read(lambda tx: _collect_async(tx, cypher, params))
            _note_success()
            return result
        except Exception as e:
            _note_failure(e)
            last = e
            retryable = write and _is_retryable(e) and attempt < attempts - 1
            if not retryable:
                raise Neo4jStoreError(f"Neo4j 操作失败：{e}") from e
            logger.warning("Neo4j transient error, retry %d/%d: %s", attempt + 2, attempts, e)
            await asyncio.sleep(_RETRY_BACKOFF[attempt])
    raise Neo4jStoreError(f"Neo4j 操作失败：{last}")  # 不可达，防御


# ─── Schema ──────────────────────────────────────

# Article.id 唯一性约束：MERGE (a:Article {id}) 的前提。
# (name,type) 用普通索引而非唯一约束——改名/改类型可能产生合法重复节点，
# 读路径按 (name,type) 去重（created_at 最早者胜，与前端"首见即用"一致）。
_SCHEMA_STATEMENTS = [
    "CREATE CONSTRAINT article_id IF NOT EXISTS FOR (a:Article) REQUIRE a.id IS UNIQUE",
    "CREATE INDEX entity_name_type IF NOT EXISTS FOR (e:Entity) ON (e.name, e.type)",
    "CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)",
    "CREATE INDEX mentions_source IF NOT EXISTS FOR ()-[m:MENTIONS]-() ON (m.source)",
    "CREATE INDEX relates_article IF NOT EXISTS FOR ()-[r:RELATES]-() ON (r.article_id)",
]

# 孤儿 GC：现行语义"实体存在 = 至少被一篇文章提及"；删除边后清理无提及的实体节点
_Q_GC_ORPHANS = "MATCH (e:Entity) WHERE NOT EXISTS { (e)<-[:MENTIONS]-() } DETACH DELETE e"


def ensure_schema_sync() -> None:
    for stmt in _SCHEMA_STATEMENTS:
        _run_sync(stmt, write=True)


async def ensure_schema() -> None:
    for stmt in _SCHEMA_STATEMENTS:
        await _run_async(stmt, write=True)


# ─── 写操作（异步版，供 async 路由/后台任务）───

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_entities(entities, creator: str) -> list[dict]:
    """实体参数规范化：name 必填；(created_by, created_at) 缺失时回退到文章创建人。

    对非 dict 元素直接跳过（防御历史 LLM 输出的脏数据，避免单个坏元素阻断迁移）。
    """
    out = []
    for e in entities or []:
        if not isinstance(e, dict):
            continue
        name = (e.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "type": e.get("type") or "",
            "created_by": e.get("created_by") or creator or None,
            "created_at": e.get("created_at") or _now_iso(),
        })
    return out


def _normalise_relations(relations) -> list[dict]:
    out = []
    for r in relations or []:
        if not isinstance(r, dict):
            continue
        source = (r.get("source") or "").strip()
        target = (r.get("target") or "").strip()
        if not source or not target:
            continue
        out.append({
            "source": source,
            "source_type": r.get("source_type") or None,
            "target": target,
            "target_type": r.get("target_type") or None,
            "label": r.get("label") or "关联",
        })
    return out


# 实体节点 MERGE + 提及边；ON CREATE SET 保留首个创建人（与前端"首见即用"一致）
_Q_MERGE_MENTIONS = """
MERGE (a:Article {id: $aid})
WITH a
UNWIND $ents AS ent
MERGE (e:Entity {name: ent.name, type: ent.type})
  ON CREATE SET e.created_by = ent.created_by, e.created_at = ent.created_at
MERGE (a)-[:MENTIONS {source: $source}]->(e)
"""

# 关系边：缺类型（旧格式）时按"本文章提及的类型变体"解析——与旧 graph.py 的
# name_types 语义一致；两端实体不存在则该条关系跳过
# 批量添加（add_entity 用）：单事务 UNWIND，全部成功或全部失败，避免逐篇写
# 中途失败产生半态（部分文章有边但 chunk 标签行未写、重试被去重跳过）
_Q_MERGE_MENTIONS_BULK = """
UNWIND $entries AS ent
MERGE (a:Article {id: ent.aid})
MERGE (e:Entity {name: ent.name, type: ent.type})
  ON CREATE SET e.created_by = ent.created_by, e.created_at = ent.created_at
MERGE (a)-[:MENTIONS {source: 'body'}]->(e)
"""


async def add_entities_to_articles_bulk(entries: list[dict]) -> None:
    """单事务为多篇文章批量添加实体提及边。

    entries: [{aid, name, type, created_by, created_at}]——调用方已按名去重。
    """
    if not entries:
        return
    await _run_async(_Q_MERGE_MENTIONS_BULK, {"entries": entries}, write=True)


_Q_MERGE_RELATIONS = """
MATCH (a:Article {id: $aid})
UNWIND $rels AS r
MATCH (s:Entity {name: r.source})
WHERE ((r.source_type IS NULL AND EXISTS { (a)-[:MENTIONS]->(s) }) OR s.type = r.source_type)
MATCH (t:Entity {name: r.target})
WHERE ((r.target_type IS NULL AND EXISTS { (a)-[:MENTIONS]->(t) }) OR t.type = r.target_type)
  // 用户手工删除的关系留下 deleted 墓碑（source='deleted'）：
  // 重新抽取/重新上传时不得把它自动加回来；手工重新添加会清除墓碑。
  AND NOT EXISTS {
    // 无向匹配：抽取方向可能不稳定，删除过的关系不应以反方向复活
    MATCH (s)-[dr:RELATES {label: r.label, article_id: $aid}]-(t)
    WHERE dr.deleted = true
  }
MERGE (s)-[:RELATES {label: r.label, article_id: $aid, source: $source}]->(t)
"""

_Q_DELETE_MENTIONS = """
MATCH (a:Article {id: $aid})-[m:MENTIONS]->(e:Entity)
WHERE $source IS NULL OR m.source = $source
DELETE m
"""

_Q_DELETE_RELATIONS = """
MATCH ()-[r:RELATES {article_id: $aid}]->()
WHERE $source IS NULL OR r.source = $source
DELETE r
"""

_Q_REMOVE_ARTICLE_NODE = "MATCH (a:Article {id: $aid}) DETACH DELETE a"

_Q_RENAME_ENTITY = """
MATCH (e:Entity {name: $old})
WHERE $old_type IS NULL OR e.type = $old_type
SET e.name = $new
"""

_Q_UPDATE_ENTITY_PROPS = """
MATCH (e:Entity {name: $old})
WHERE $old_type IS NULL OR e.type = $old_type
SET e.name = CASE WHEN $new_name IS NULL THEN e.name ELSE $new_name END,
    e.type = CASE WHEN $new_type IS NULL THEN e.type ELSE $new_type END
"""

_Q_REMOVE_ENTITY_MENTIONS = """
MATCH (a:Article)-[m:MENTIONS]->(e:Entity {name: $name})
WHERE ($etype IS NULL OR e.type = $etype)
  AND ($aids IS NULL OR a.id IN $aids)
DELETE m
"""

_Q_REMOVE_ENTITY_RELATES = """
MATCH (e1:Entity)-[r:RELATES]->(e2:Entity)
WHERE (
    (e1.name = $name AND ($etype IS NULL OR e1.type = $etype))
    OR (e2.name = $name AND ($etype IS NULL OR e2.type = $etype))
  )
  AND ($aids IS NULL OR r.article_id IN $aids)
DELETE r
"""

_Q_HAS_ENTITY_NAME = """
MATCH (a:Article {id: $aid})-[:MENTIONS]->(e:Entity {name: $name})
WHERE $etype IS NULL OR e.type = $etype
RETURN count(e) > 0 AS has
"""


async def _write_tx(statements: list[tuple[str, dict]]) -> None:
    """在单个写事务中顺序执行多条语句（驱动级托管事务），内置 3 次退避重试。"""
    _check_fail_fast()
    last = None
    for attempt in range(_WRITE_RETRIES):
        try:
            async with get_async_driver().session(database=NEO4J_DATABASE) as session:
                async def _do(tx):
                    for cypher, params in statements:
                        await _collect_async(tx, cypher, params)
                await session.execute_write(_do)
                _note_success()
                return
        except Exception as e:
            _note_failure(e)
            last = e
            if not (_is_retryable(e) and attempt < _WRITE_RETRIES - 1):
                raise Neo4jStoreError(f"Neo4j 操作失败：{e}") from e
            logger.warning("Neo4j transient error, retry %d/%d: %s", attempt + 2, _WRITE_RETRIES, e)
            await asyncio.sleep(_RETRY_BACKOFF[attempt])
    raise Neo4jStoreError(f"Neo4j 操作失败：{last}")  # 不可达，防御


def _write_tx_sync(statements: list[tuple[str, dict]]) -> None:
    """同步版多语句写事务（语义同 _write_tx）。"""
    _check_fail_fast()
    last = None
    for attempt in range(_WRITE_RETRIES):
        try:
            with get_sync_driver().session(database=NEO4J_DATABASE) as session:
                def _do(tx):
                    for cypher, params in statements:
                        _collect(tx, cypher, params)
                session.execute_write(_do)
                _note_success()
                return
        except Exception as e:
            _note_failure(e)
            last = e
            if not (_is_retryable(e) and attempt < _WRITE_RETRIES - 1):
                raise Neo4jStoreError(f"Neo4j 操作失败：{e}") from e
            logger.warning("Neo4j transient error, retry %d/%d: %s", attempt + 2, _WRITE_RETRIES, e)
            time.sleep(_RETRY_BACKOFF[attempt])
    raise Neo4jStoreError(f"Neo4j 操作失败：{last}")  # 不可达，防御


async def add_article_mentions(
    article_id: str,
    entities,
    relations,
    source: str,
    creator: str = "",
) -> None:
    """幂等合并：MERGE 实体节点 + 提及边 + 关系边（重跑去重）。"""
    ents = _normalise_entities(entities, creator)
    rels = _normalise_relations(relations)
    await _run_async(_Q_MERGE_MENTIONS, {"aid": article_id, "ents": ents, "source": source}, write=True)
    if rels:
        await _run_async(_Q_MERGE_RELATIONS, {"aid": article_id, "rels": rels, "source": source}, write=True)


async def replace_article_mentions(
    article_id: str,
    entities,
    relations,
    source: str,
    creator: str = "",
) -> None:
    """覆盖语义：先删该 source 的旧提及边/关系边，再插入（一个事务），最后孤儿 GC。"""
    ents = _normalise_entities(entities, creator)
    rels = _normalise_relations(relations)
    statements = [
        (_Q_DELETE_MENTIONS, {"aid": article_id, "source": source}),
        (_Q_DELETE_RELATIONS, {"aid": article_id, "source": source}),
        (_Q_MERGE_MENTIONS, {"aid": article_id, "ents": ents, "source": source}),
    ]
    if rels:
        statements.append((_Q_MERGE_RELATIONS, {"aid": article_id, "rels": rels, "source": source}))
    statements.append((_Q_GC_ORPHANS, {}))
    await _write_tx(statements)


async def delete_mentions(article_id: str, source: str | None = None) -> None:
    await _write_tx([
        (_Q_DELETE_MENTIONS, {"aid": article_id, "source": source}),
        (_Q_GC_ORPHANS, {}),
    ])


async def delete_relations(article_id: str, source: str | None = None) -> None:
    await _write_tx([
        (_Q_DELETE_RELATIONS, {"aid": article_id, "source": source}),
        (_Q_GC_ORPHANS, {}),
    ])


async def remove_article(article_id: str) -> None:
    """删除文章节点（连带 MENTIONS 边）与其全部关系边 + 孤儿 GC。"""
    await _write_tx([
        (_Q_REMOVE_ARTICLE_NODE, {"aid": article_id}),
        (_Q_DELETE_RELATIONS, {"aid": article_id, "source": None}),
        (_Q_GC_ORPHANS, {}),
    ])


async def rename_entity(old_name: str, new_name: str, old_type: str | None = None) -> None:
    """重命名实体（可按类型限定）；关系边指向节点，端点名自动跟随。"""
    await _run_async(
        _Q_RENAME_ENTITY,
        {"old": old_name, "new": new_name, "old_type": _norm_rel_type(old_type)},
        write=True,
    )


async def update_entity_props(
    old_name: str,
    new_name: str | None,
    new_type: str | None,
    old_type: str | None = None,
) -> None:
    await _run_async(
        _Q_UPDATE_ENTITY_PROPS,
        {
            "old": old_name,
            "new_name": new_name,
            "new_type": new_type,
            "old_type": _norm_rel_type(old_type),
        },
        write=True,
    )


async def remove_entity(
    name: str,
    article_ids: list[str] | None = None,
    etype: str | None = None,
) -> None:
    """从（指定）文章中移除实体（可按类型）的提及边与两端关系边；孤儿节点由 GC 清理。"""
    params = {"name": name, "aids": article_ids, "etype": _norm_rel_type(etype)}
    await _write_tx([
        (_Q_REMOVE_ENTITY_MENTIONS, params),
        (_Q_REMOVE_ENTITY_RELATES, params),
        (_Q_GC_ORPHANS, {}),
    ])


async def article_has_entity_name(
    article_id: str,
    name: str,
    etype: str | None = None,
) -> bool:
    recs = await _run_async(_Q_HAS_ENTITY_NAME, {
        "aid": article_id,
        "name": name,
        "etype": _norm_rel_type(etype),
    })
    return bool(recs and recs[0]["has"])


# ─── 写操作（同步版，供线程池 sync 路由）───

def delete_mentions_sync(article_id: str, source: str | None = None) -> None:
    _write_tx_sync([
        (_Q_DELETE_MENTIONS, {"aid": article_id, "source": source}),
        (_Q_GC_ORPHANS, {}),
    ])


def delete_relations_sync(article_id: str, source: str | None = None) -> None:
    _write_tx_sync([
        (_Q_DELETE_RELATIONS, {"aid": article_id, "source": source}),
        (_Q_GC_ORPHANS, {}),
    ])


def remove_article_sync(article_id: str) -> None:
    _write_tx_sync([
        (_Q_REMOVE_ARTICLE_NODE, {"aid": article_id}),
        (_Q_DELETE_RELATIONS, {"aid": article_id, "source": None}),
        (_Q_GC_ORPHANS, {}),
    ])


def rename_entity_sync(old_name: str, new_name: str, old_type: str | None = None) -> None:
    _run_sync(
        _Q_RENAME_ENTITY,
        {"old": old_name, "new": new_name, "old_type": _norm_rel_type(old_type)},
        write=True,
    )


def update_entity_props_sync(
    old_name: str,
    new_name: str | None,
    new_type: str | None,
    old_type: str | None = None,
) -> None:
    _run_sync(
        _Q_UPDATE_ENTITY_PROPS,
        {
            "old": old_name,
            "new_name": new_name,
            "new_type": new_type,
            "old_type": _norm_rel_type(old_type),
        },
        write=True,
    )


def remove_entity_sync(
    name: str,
    article_ids: list[str] | None = None,
    etype: str | None = None,
) -> None:
    params = {"name": name, "aids": article_ids, "etype": _norm_rel_type(etype)}
    _write_tx_sync([
        (_Q_REMOVE_ENTITY_MENTIONS, params),
        (_Q_REMOVE_ENTITY_RELATES, params),
        (_Q_GC_ORPHANS, {}),
    ])


# ─── 实体关系编辑（RELATES 手工增删改）───
# 关系边按 (label, article_id, source) MERGE；手工关系 source='manual'，
# 不会被重新抽取的 replace（按 source 删除 body/comment 边）覆盖。

_Q_ENTITY_RELATIONS = """
MATCH (e1:Entity {name: $name})-[r:RELATES]-(e2:Entity)
WHERE ($etype IS NULL OR e1.type = $etype)
  AND ($aids IS NULL OR r.article_id IN $aids)
  AND coalesce(r.deleted, false) = false
RETURN startNode(r).name AS source_name, startNode(r).type AS source_type,
       endNode(r).name AS target_name, endNode(r).type AS target_type,
       r.label AS label, r.article_id AS aid
"""

# 两端实体共同出现的文章（新增/修改时校验：对端必须在本文章实体中）
_Q_ARTICLES_MENTIONING_BOTH = """
MATCH (s:Entity {name: $source_name})
WHERE $source_type IS NULL OR s.type = $source_type
MATCH (t:Entity {name: $target_name})
WHERE $target_type IS NULL OR t.type = $target_type
MATCH (a:Article)-[:MENTIONS]->(s)
MATCH (a)-[:MENTIONS]->(t)
WHERE $aids IS NULL OR a.id IN $aids
RETURN DISTINCT a.id AS aid
"""

_Q_CREATE_ENTITY_RELATION = """
MATCH (s:Entity {name: $source_name})
WHERE $source_type IS NULL OR s.type = $source_type
MATCH (t:Entity {name: $target_name})
WHERE $target_type IS NULL OR t.type = $target_type
MATCH (a:Article)-[:MENTIONS]->(s)
MATCH (a)-[:MENTIONS]->(t)
WHERE $aids IS NULL OR a.id IN $aids
MERGE (s)-[r:RELATES {label: $label, article_id: a.id}]->(t)
// 已有自动抽取边 → 升级为手工边，避免后续重新抽取时被 replace 删除；
// 已有删除墓碑 → 手工重新添加即恢复（清除墓碑）。
ON CREATE SET r.source = 'manual'
ON MATCH SET r.source = 'manual', r.deleted = null
RETURN count(r) AS n
"""

_Q_DELETE_ENTITY_RELATION = """
MATCH (s:Entity {name: $source_name})-[r:RELATES]->(t:Entity {name: $target_name})
WHERE ($source_type IS NULL OR s.type = $source_type)
  AND ($target_type IS NULL OR t.type = $target_type)
  AND r.label = $label
  AND ($aids IS NULL OR r.article_id IN $aids)
  AND coalesce(r.deleted, false) = false
WITH collect(r) AS rs
// 软删除：保留关系作为墓碑，重新抽取时由 _Q_MERGE_RELATIONS 跳过，
// 避免用户删除的自动抽取关系在重跑识别/重新上传后自动复活。
FOREACH (r IN rs | SET r.deleted = true, r.source = 'deleted')
RETURN size(rs) AS n
"""

# 仅改关系名（两端不变）：直接改属性，不删旧建新。
# 这样带类型但未在该文章 MENTIONS 中出现的端点也能改名（重建时无法通过
# “两端共同提及”校验），也不会把自动抽取边变成手工边。
_Q_RENAME_ENTITY_RELATION_LABEL = """
MATCH (s:Entity {name: $source_name})-[r:RELATES]->(t:Entity {name: $target_name})
WHERE ($source_type IS NULL OR s.type = $source_type)
  AND ($target_type IS NULL OR t.type = $target_type)
  AND r.label = $old_label
  AND ($aids IS NULL OR r.article_id IN $aids)
  AND coalesce(r.deleted, false) = false
// 改名后标记为手工边：重新抽取的 replace 只删 body/comment 边，不会把改名冲掉
SET r.label = $new_label, r.source = 'manual'
WITH s, t, r
// 同时为旧关系名留下墓碑：防止重新抽取又把旧名字加回来
MERGE (s)-[d:RELATES {label: $old_label, article_id: r.article_id}]->(t)
SET d.deleted = true, d.source = 'deleted'
RETURN count(r) AS n
"""

# 仅切换方向（两端集合不变）：在旧关系存在的文章范围内反向建边。
# 不要求 MENTIONS：旧边已经证明这两个端点在文章中存在关联。
_Q_REORIENT_ENTITY_RELATION = """
MATCH (s:Entity {name: $source_name})-[r:RELATES]->(t:Entity {name: $target_name})
WHERE ($source_type IS NULL OR s.type = $source_type)
  AND ($target_type IS NULL OR t.type = $target_type)
  AND r.label = $old_label
  AND ($aids IS NULL OR r.article_id IN $aids)
  AND coalesce(r.deleted, false) = false
WITH collect(r) AS rs, collect(DISTINCT r.article_id) AS aids
FOREACH (r IN rs | SET r.deleted = true, r.source = 'deleted')
WITH aids
UNWIND aids AS aid
MATCH (a:Article {id: aid})
MATCH (ns:Entity {name: $new_source_name})
WHERE $new_source_type IS NULL OR ns.type = $new_source_type
MATCH (nt:Entity {name: $new_target_name})
WHERE $new_target_type IS NULL OR nt.type = $new_target_type
MERGE (ns)-[nr:RELATES {label: $new_label, article_id: aid}]->(nt)
ON CREATE SET nr.source = 'manual'
ON MATCH SET nr.source = 'manual', nr.deleted = null
RETURN count(nr) AS n
"""

# 修改关系前先查出旧关系实际存在于哪些文章：只在这些文章中删旧建新，
# 不能因为两端在范围内其他文章共同出现就凭空新增边。
_Q_ENTITY_RELATION_ARTICLE_IDS = """
MATCH (s:Entity {name: $source_name})-[r:RELATES]->(t:Entity {name: $target_name})
WHERE ($source_type IS NULL OR s.type = $source_type)
  AND ($target_type IS NULL OR t.type = $target_type)
  AND r.label = $label
  AND ($aids IS NULL OR r.article_id IN $aids)
  AND coalesce(r.deleted, false) = false
RETURN DISTINCT r.article_id AS aid
"""


def _norm_rel_type(etype: str | None) -> str | None:
    """关系查询的类型参数：None = 不限定类型；'' 是合法类型（旧数据可能缺类型）。

    不能把空串折叠成 None——否则空类型实体会匹配/删除同名其他类型实体的关系。
    """
    return etype.strip() if isinstance(etype, str) else None


def get_entity_relations_sync(
    name: str,
    etype: str | None = None,
    article_ids: list[str] | None = None,
) -> list[dict]:
    """某实体的全部关系（两端聚合）：同一 (source,target,label) 的多篇文章边合并。"""
    recs = _run_sync(_Q_ENTITY_RELATIONS, {
        "name": name,
        "etype": _norm_rel_type(etype),
        "aids": article_ids or None,
    })
    agg: dict[tuple, dict] = {}
    for rec in recs:
        src_name = rec["source_name"] or ""
        tgt_name = rec["target_name"] or ""
        if not src_name or not tgt_name:
            continue
        key = (src_name, rec["source_type"] or "", tgt_name, rec["target_type"] or "", rec["label"] or "关联")
        item = agg.get(key)
        if item is None:
            item = {
                "source_name": key[0],
                "source_type": key[1],
                "target_name": key[2],
                "target_type": key[3],
                "label": key[4],
                "article_ids": [],
            }
            agg[key] = item
        aid = rec["aid"]
        if aid and aid not in item["article_ids"]:
            item["article_ids"].append(aid)
    return sorted(agg.values(), key=lambda r: (r["label"], r["target_name"], r["target_type"]))


def articles_mentioning_both_sync(
    source_name: str,
    source_type: str | None,
    target_name: str,
    target_type: str | None,
    article_ids: list[str] | None = None,
) -> list[str]:
    recs = _run_sync(_Q_ARTICLES_MENTIONING_BOTH, {
        "source_name": source_name,
        "source_type": _norm_rel_type(source_type),
        "target_name": target_name,
        "target_type": _norm_rel_type(target_type),
        "aids": article_ids or None,
    })
    return [rec["aid"] for rec in recs]


def create_entity_relation_sync(
    source_name: str,
    source_type: str | None,
    target_name: str,
    target_type: str | None,
    label: str,
    article_ids: list[str] | None = None,
) -> int:
    recs = _run_sync(_Q_CREATE_ENTITY_RELATION, {
        "source_name": source_name,
        "source_type": _norm_rel_type(source_type),
        "target_name": target_name,
        "target_type": _norm_rel_type(target_type),
        "label": label or "关联",
        "aids": article_ids or None,
    }, write=True)
    return int(recs[0]["n"]) if recs else 0


def delete_entity_relation_sync(
    source_name: str,
    source_type: str | None,
    target_name: str,
    target_type: str | None,
    label: str,
    article_ids: list[str] | None = None,
) -> int:
    recs = _run_sync(_Q_DELETE_ENTITY_RELATION, {
        "source_name": source_name,
        "source_type": _norm_rel_type(source_type),
        "target_name": target_name,
        "target_type": _norm_rel_type(target_type),
        "label": label or "关联",
        "aids": article_ids or None,
    }, write=True)
    return int(recs[0]["n"]) if recs else 0


def rename_entity_relation_label_sync(
    old: dict,
    new_label: str,
    article_ids: list[str] | None = None,
) -> int:
    """只改关系名：原地 SET label（不删边，保留自动抽取来源/边属性）。"""
    recs = _run_sync(_Q_RENAME_ENTITY_RELATION_LABEL, {
        "source_name": old["source_name"],
        "source_type": _norm_rel_type(old.get("source_type")),
        "target_name": old["target_name"],
        "target_type": _norm_rel_type(old.get("target_type")),
        "old_label": old.get("label") or "关联",
        "new_label": new_label or "关联",
        "aids": article_ids or None,
    }, write=True)
    return int(recs[0]["n"]) if recs else 0


def reorient_entity_relation_sync(
    old: dict,
    new: dict,
    article_ids: list[str] | None = None,
) -> int:
    """仅切换方向：在旧关系存在的文章内反向建边（不要求两端 MENTIONS）。"""
    recs = _run_sync(_Q_REORIENT_ENTITY_RELATION, {
        "source_name": old["source_name"],
        "source_type": _norm_rel_type(old.get("source_type")),
        "target_name": old["target_name"],
        "target_type": _norm_rel_type(old.get("target_type")),
        "old_label": old.get("label") or "关联",
        "new_source_name": new["source_name"],
        "new_source_type": _norm_rel_type(new.get("source_type")),
        "new_target_name": new["target_name"],
        "new_target_type": _norm_rel_type(new.get("target_type")),
        "new_label": new.get("label") or "关联",
        "aids": article_ids or None,
    }, write=True)
    return int(recs[0]["n"]) if recs else 0


def get_entity_relation_article_ids_sync(
    source_name: str,
    source_type: str | None,
    target_name: str,
    target_type: str | None,
    label: str,
    article_ids: list[str] | None = None,
) -> list[str]:
    """旧关系实际存在的文章 id（修改关系的作用域：只改这些文章中的边）。"""
    recs = _run_sync(_Q_ENTITY_RELATION_ARTICLE_IDS, {
        "source_name": source_name,
        "source_type": _norm_rel_type(source_type),
        "target_name": target_name,
        "target_type": _norm_rel_type(target_type),
        "label": label or "关联",
        "aids": article_ids or None,
    })
    return [rec["aid"] for rec in recs if rec.get("aid")]


def update_entity_relation_sync(
    old: dict,
    new: dict,
    article_ids: list[str] | None = None,
) -> int:
    """改关系：同一事务内删旧边、建新边（调用方已校验新对端在本文章实体中）。

    old/new 均含 source_name/source_type/target_name/target_type/label。
    调用方应传入旧关系实际存在的文章范围（get_entity_relation_article_ids_sync），
    避免在旧关系不存在的文章中凭空新增。
    """
    aids = article_ids or None
    statements = [
        (_Q_DELETE_ENTITY_RELATION, {
            "source_name": old["source_name"],
            "source_type": _norm_rel_type(old.get("source_type")),
            "target_name": old["target_name"],
            "target_type": _norm_rel_type(old.get("target_type")),
            "label": old.get("label") or "关联",
            "aids": aids,
        }),
        (_Q_CREATE_ENTITY_RELATION, {
            "source_name": new["source_name"],
            "source_type": _norm_rel_type(new.get("source_type")),
            "target_name": new["target_name"],
            "target_type": _norm_rel_type(new.get("target_type")),
            "label": new.get("label") or "关联",
            "aids": aids,
        }),
    ]
    _write_tx_sync(statements)
    return len(article_ids or [])


# ─── 读操作（同步版）───

_Q_ARTICLE_MENTIONS = """
MATCH (a:Article)-[m:MENTIONS]->(e:Entity)
WHERE a.id IN $ids
RETURN a.id AS aid, e.name AS name, e.type AS type,
       e.created_by AS created_by, e.created_at AS created_at
ORDER BY e.created_at
"""

_Q_ARTICLE_RELATIONS = """
MATCH (e1:Entity)-[r:RELATES]->(e2:Entity)
WHERE r.article_id IN $ids AND coalesce(r.deleted, false) = false
RETURN DISTINCT r.article_id AS aid, e1.name AS source, e1.type AS source_type,
       e2.name AS target, e2.type AS target_type, r.label AS label
"""


def get_entities_for_articles_sync(article_ids: list[str]) -> dict:
    """批量组装文章实体数据：{aid: {entities, relations} | None}。

    两条 Cypher 一次请求批量完成（避免 N+1）；无边的文章返回 None
    （与旧 articles.entities 为 NULL 的语义一致）。"""
    if not article_ids:
        return {}
    mention_recs = _run_sync(_Q_ARTICLE_MENTIONS, {"ids": article_ids})
    relation_recs = _run_sync(_Q_ARTICLE_RELATIONS, {"ids": article_ids})

    ents_by_aid: dict[str, list] = {}
    seen_ents: dict[str, set] = {}
    for rec in mention_recs:
        name = rec["name"] or ""
        if not name:
            continue
        aid = rec["aid"]
        key = (name, rec["type"] or "")
        seen = seen_ents.setdefault(aid, set())
        if key in seen:
            continue
        seen.add(key)
        ents_by_aid.setdefault(aid, []).append({
            "name": name,
            "type": rec["type"] or "",
            "created_by": rec["created_by"],
            "created_at": rec["created_at"],
        })

    rels_by_aid: dict[str, list] = {}
    seen_rels: dict[str, set] = {}
    for rec in relation_recs:
        aid = rec["aid"]
        key = (
            rec["source"] or "", rec["source_type"] or "",
            rec["target"] or "", rec["target_type"] or "",
            rec["label"] or "关联",
        )
        seen = seen_rels.setdefault(aid, set())
        if key in seen:
            continue
        seen.add(key)
        rels_by_aid.setdefault(aid, []).append({
            "source": rec["source"],
            "source_type": rec["source_type"] or "",
            "target": rec["target"],
            "target_type": rec["target_type"] or "",
            "label": rec["label"] or "关联",
        })

    result: dict = {}
    for aid in article_ids:
        ents = ents_by_aid.get(aid) or []
        rels = rels_by_aid.get(aid) or []
        result[aid] = {"entities": ents, "relations": rels} if (ents or rels) else None
    return result


_Q_COMMENT_MENTIONS = """
MATCH (a:Article)-[m:MENTIONS]->(e:Entity)
WHERE m.source IN $sources
RETURN m.source AS source, e.name AS name, e.type AS type,
       e.created_by AS created_by, e.created_at AS created_at
ORDER BY e.created_at
"""

_Q_COMMENT_RELATIONS = """
MATCH (e1:Entity)-[r:RELATES]->(e2:Entity)
WHERE r.source IN $sources
RETURN r.source AS source, e1.name AS source_name, e1.type AS source_type,
       e2.name AS target, e2.type AS target_type, r.label AS label
"""


def get_comment_entities_sync(comment_ids: list[str]) -> dict:
    """按评论组装其实体贡献：{comment_id: {entities, relations} | None}。"""
    if not comment_ids:
        return {}
    sources = [f"comment:{cid}" for cid in comment_ids]
    mention_recs = _run_sync(_Q_COMMENT_MENTIONS, {"sources": sources})
    relation_recs = _run_sync(_Q_COMMENT_RELATIONS, {"sources": sources})

    result: dict = {cid: None for cid in comment_ids}

    def _cid(source: str) -> str | None:
        if isinstance(source, str) and source.startswith("comment:"):
            return source[len("comment:"):]
        return None

    for rec in mention_recs:
        cid = _cid(rec["source"])
        if cid is None:
            continue
        name = rec["name"] or ""
        if not name:
            continue
        if result[cid] is None:
            result[cid] = {"entities": [], "relations": []}
        ents = result[cid]["entities"]
        if not any(e["name"] == name and e["type"] == (rec["type"] or "") for e in ents):
            ents.append({
                "name": name,
                "type": rec["type"] or "",
                "created_by": rec["created_by"],
                "created_at": rec["created_at"],
            })

    for rec in relation_recs:
        cid = _cid(rec["source"])
        if cid is None:
            continue
        if result[cid] is None:
            result[cid] = {"entities": [], "relations": []}
        rels = result[cid]["relations"]
        rel = {
            "source": rec["source_name"],
            "source_type": rec["source_type"] or "",
            "target": rec["target"],
            "target_type": rec["target_type"] or "",
            "label": rec["label"] or "关联",
        }
        if rel not in rels:
            rels.append(rel)

    return result


def get_entity_names_mentioned_in_sync(article_id: str) -> list[str]:
    recs = _run_sync(
        "MATCH (a:Article {id: $aid})-[:MENTIONS]->(e:Entity) RETURN DISTINCT e.name AS name",
        {"aid": article_id},
    )
    return [rec["name"] for rec in recs if rec["name"]]


def all_entity_names_sync() -> list[str]:
    recs = _run_sync("MATCH (e:Entity) RETURN DISTINCT e.name AS name ORDER BY e.name")
    return [rec["name"] for rec in recs if rec["name"]]


def entity_creator_and_articles_sync(
    name: str,
    etype: str | None = None,
) -> tuple[str | None, list[str]]:
    """实体创建人（最早节点胜）与其全部提及文章 id（权限检查用）。

    etype 非 None 时按 (name, type) 精确定位——同名不同类型的实体各有权限主体；
    None 保留旧的按名称匹配语义。
    """
    params = {"name": name, "etype": _norm_rel_type(etype)}
    creator_recs = _run_sync(
        "MATCH (e:Entity {name: $name}) "
        "WHERE $etype IS NULL OR e.type = $etype "
        "RETURN e.created_by AS created_by ORDER BY e.created_at LIMIT 1",
        params,
    )
    creator = creator_recs[0]["created_by"] if creator_recs else None
    aid_recs = _run_sync(
        "MATCH (a:Article)-[:MENTIONS]->(e:Entity {name: $name}) "
        "WHERE $etype IS NULL OR e.type = $etype "
        "RETURN DISTINCT a.id AS aid",
        params,
    )
    return creator, [rec["aid"] for rec in aid_recs]


def count_entity_nodes_named_sync(name: str) -> int:
    """名称下剩余的实体节点数（类型限定重命名后判断是否还有其他类型变体）。"""
    recs = _run_sync(
        "MATCH (e:Entity {name: $name}) RETURN count(e) AS n",
        {"name": name},
    )
    return int(recs[0]["n"]) if recs else 0


def entity_exists_sync(name: str, etype: str | None = None) -> bool:
    """(name, type) 实体是否存在（etype=None 时按名称判断）。"""
    recs = _run_sync(
        "MATCH (e:Entity {name: $name}) "
        "WHERE $etype IS NULL OR e.type = $etype "
        "RETURN count(e) > 0 AS exists",
        {"name": name, "etype": _norm_rel_type(etype)},
    )
    return bool(recs and recs[0]["exists"])


def entity_mentioned_anywhere_sync(name: str) -> bool:
    recs = _run_sync(
        "MATCH (:Article)-[:MENTIONS]->(e:Entity {name: $name}) RETURN count(e) > 0 AS exists",
        {"name": name},
    )
    return bool(recs and recs[0]["exists"])


def entity_names_with_mentions_sync(names: list[str]) -> set[str]:
    """批量判断哪些实体名仍被提及（删除文章后的孤儿 EntityInfo 判定，一次查询）。"""
    if not names:
        return set()
    recs = _run_sync(
        "MATCH (:Article)-[:MENTIONS]->(e:Entity) WHERE e.name IN $names RETURN DISTINCT e.name AS name",
        {"names": names},
    )
    return {rec["name"] for rec in recs}


def count_distinct_entity_names_sync() -> int:
    recs = _run_sync("MATCH (e:Entity) RETURN count(DISTINCT e.name) AS n")
    return int(recs[0]["n"]) if recs else 0


def graph_data_sync() -> tuple[list[dict], list[dict], list[dict]]:
    """图谱数据三查：(实体节点, 提及边, 关系边) —— 文章/目录节点仍由 SQLite 构建。"""
    ents = _run_sync("MATCH (e:Entity) RETURN e.name AS name, e.type AS type")
    ments = _run_sync("MATCH (a:Article)-[:MENTIONS]->(e:Entity) RETURN a.id AS aid, e.name AS name, e.type AS type")
    rels = _run_sync(
        "MATCH (e1:Entity)-[r:RELATES]->(e2:Entity) "
        "WHERE coalesce(r.deleted, false) = false "
        "RETURN DISTINCT e1.name AS source, e1.type AS source_type, "
        "e2.name AS target, e2.type AS target_type, r.label AS label"
    )
    return [dict(r) for r in ents], [dict(r) for r in ments], [dict(r) for r in rels]


def expand_graph_sync(node_match: str, params: dict, depth: int) -> tuple[list, list]:
    """n 层邻域展开：Neo4j 直查全量（不受 /graph 的 GRAPH_MAX_NODES 上限影响）。

    node_match 形如 "MATCH (n0:Article {id: $start_id})" 或
    "MATCH (n0:Entity {name: $name, type: $etype})"；
    返回 (节点记录, 关系记录) 原始 neo4j 对象列表，由调用方映射为图谱 DTO。
    """
    depth = max(1, min(int(depth), 3))
    # 上限护栏：防止枢纽节点 n=3 时变量长路径爆炸（前端 D3 也扛不住全量渲染）。
    # LIMIT 必须放在 collect 之前：先流式截断路径行，避免 collect 先把全部路径
    # 聚合成内存列表再截断（枢纽节点上会先materialize海量行）。
    nodes = _run_sync(
        f"{node_match} "
        f"OPTIONAL MATCH (n0)-[:MENTIONS|RELATES*1..{depth}]-(x) "
        "WITH n0, x LIMIT 1200 "
        "WITH collect(DISTINCT n0) + collect(DISTINCT x) AS allnodes "
        "UNWIND allnodes AS n RETURN DISTINCT n",
        params,
    )
    rels = _run_sync(
        f"{node_match} "
        f"OPTIONAL MATCH (n0)-[r:MENTIONS|RELATES*1..{depth}]-(x) "
        # 先按“路径”限流再 UNWIND：稠密邻域中 DISTINCT 只有在扫完全部
        # 指数级路径后才能收敛，必须在展开阶段就截断（安全上限）。
        "WITH r LIMIT 5000 "
        # 端点必须用 startNode/endNode 显式返回：driver 5.26 中 rel.nodes
        # 从 UNWIND 列表解出的关系携带的是未水合（无 labels/属性）的节点壳
        "UNWIND r AS rel "
        "WITH rel WHERE NOT (rel:RELATES AND coalesce(rel.deleted, false)) "
        "RETURN DISTINCT rel, startNode(rel) AS s, endNode(rel) AS e LIMIT 5000",
        params,
    )
    return nodes, rels


# ─── 读操作（异步版，供 async 的 QA 路径）───

async def all_entity_name_types() -> dict[str, str]:
    """全部实体名 → 类型映射（同名多类型取 created_at 最早节点）。

    QA 实体直召（取键集合）与来源卡片实体 chips（名与块文本子串匹配派生）共用。
    """
    recs = await _run_async(
        "MATCH (e:Entity) RETURN e.name AS name, e.type AS type ORDER BY e.name, e.created_at"
    )
    result: dict[str, str] = {}
    for rec in recs:
        name = rec["name"]
        if name and name not in result:
            result[name] = rec["type"] or ""
    return result


async def articles_mentioning(name: str) -> list[str]:
    """提及某实体的全部文章 id（实体附加信息同步到分块用）。"""
    recs = await _run_async(
        "MATCH (a:Article)-[:MENTIONS]->(e:Entity {name: $name}) RETURN DISTINCT a.id AS aid",
        {"name": name},
    )
    return [rec["aid"] for rec in recs]


async def article_ids_by_entity_names(names: list[str]) -> dict[str, list[str]]:
    """实体名 → 提及该实体的文章 id 列表（QA 实体直召用）。"""
    if not names:
        return {}
    recs = await _run_async(
        "MATCH (a:Article)-[:MENTIONS]->(e:Entity) WHERE e.name IN $names "
        "RETURN DISTINCT a.id AS aid, e.name AS name",
        {"names": names},
    )
    by_name: dict[str, list[str]] = {}
    for rec in recs:
        by_name.setdefault(rec["name"], []).append(rec["aid"])
    return by_name


async def entity_names_for_articles(article_ids: list[str]) -> dict[str, list[str]]:
    """文章 id → 该文章提及的实体名列表（QA 附加信息收集用）。"""
    if not article_ids:
        return {}
    recs = await _run_async(
        "MATCH (a:Article)-[:MENTIONS]->(e:Entity) WHERE a.id IN $ids "
        "RETURN DISTINCT a.id AS aid, e.name AS name",
        {"ids": article_ids},
    )
    by_aid: dict[str, list[str]] = {}
    for rec in recs:
        by_aid.setdefault(rec["aid"], []).append(rec["name"])
    return by_aid


# ─── 启动懒迁移 ──────────────────────────────────

def start_migration() -> None:
    """lifespan 调用：fire-and-forget，幂等（run.py 双 uvicorn 共用 app → lifespan 跑两次）。"""
    global _migration_started
    if _migration_started:
        return
    _migration_started = True
    asyncio.get_running_loop().create_task(migrate_and_drop_columns())


async def _gc_dangling() -> None:
    """悬空清理：Neo4j 中引用已不存在的 SQLite 文章/评论的边（治愈 Neo4j 宕机期间的删除）。

    安全护栏：若 SQLite 文章与 Neo4j 文章节点的 id 完全不相交（两套不同的库），
    视为「连错了数据库」而非「全部悬空」——跳过清理并告警，防止误清空整个图。
    （2026-09-30 存储统一过渡期曾因此清空过一次图，教训记录于此。）
    """
    from app.database import engine

    with engine.connect() as conn:
        sqlite_aids = {row[0] for row in conn.exec_driver_sql("SELECT id FROM articles")}
        sqlite_cids = {f"comment:{row[0]}" for row in conn.exec_driver_sql("SELECT id FROM comments")}

    neo_aids = {rec["aid"] for rec in await _run_async("MATCH (a:Article) RETURN a.id AS aid")}
    # 护栏排除固定种子 id（a1-a5）：两套不同库都会含种子，仅种子交集不能证明是同一套库
    seed_ids = {"a1", "a2", "a3", "a4", "a5"}
    if neo_aids and not ((neo_aids - seed_ids) & (sqlite_aids - seed_ids)):
        logger.error(
            "Neo4j/SQLite 文章 id 不相交（Neo4j %d 个 / SQLite %d 个，不含种子）——疑似连接了另一套数据库，"
            "跳过悬空清理以防误清空",
            len(neo_aids), len(sqlite_aids),
        )
        return
    missing = list(neo_aids - sqlite_aids)
    if missing:
        await _write_tx([("UNWIND $missing AS mid MATCH (a:Article {id: mid}) DETACH DELETE a",
                          {"missing": missing})])
        logger.info("Neo4j dangling cleanup: removed %d article node(s)", len(missing))

    # NOT IN 要求右侧非空；valid 为空时按语义删除全部对应边（无文章/评论即无边）
    await _write_tx([
        ("MATCH ()-[r:RELATES]->() WHERE NOT r.article_id IN $valid_articles DELETE r",
         {"valid_articles": list(sqlite_aids)}),
        # 评论级边治愈：source='comment:<id>' 但评论已被删除 → 删边
        ("MATCH ()-[m:MENTIONS]->() "
         "WHERE m.source STARTS WITH 'comment:' AND NOT m.source IN $valid_comments DELETE m",
         {"valid_comments": list(sqlite_cids)}),
        ("MATCH ()-[r:RELATES]->() "
         "WHERE r.source STARTS WITH 'comment:' AND NOT r.source IN $valid_comments DELETE r",
         {"valid_comments": list(sqlite_cids)}),
        (_Q_GC_ORPHANS, {}),
    ])


def _column_exists(conn, table: str, column: str) -> bool:
    rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return any(row[1] == column for row in rows)


async def migrate_and_drop_columns() -> None:
    """启动懒迁移：SQLite 实体 JSON → Neo4j，加载完成后删除 articles/comments.entities 列。

    - Neo4j 连不上：5×30s 重试后放弃，列保留，下次启动重试（数据不丢）
    - 加载幂等（MERGE）：加载与删列之间崩溃后重启安全
    - 此后 SQLite 无实体来源：所有写路径必须严格（与 Qdrant 的 best-effort 不同）
    """
    from app.database import engine

    # 1. schema + 连通性（Neo4j 容器可能还在启动）
    for attempt in range(_MIGRATION_RETRIES):
        try:
            await ensure_schema()
            if await ping_async():
                break
        except Neo4jStoreError as e:
            logger.warning("Neo4j schema/ping failed (attempt %d/%d): %s",
                           attempt + 1, _MIGRATION_RETRIES, e)
        if attempt == _MIGRATION_RETRIES - 1:
            logger.error(
                "Neo4j unavailable after %d retries — entity migration deferred to next startup",
                _MIGRATION_RETRIES,
            )
            return
        await asyncio.sleep(_MIGRATION_RETRY_DELAY)

    # 2. 悬空清理（每次启动都做；治愈 Neo4j 宕机期间的删除）
    try:
        await _gc_dangling()
    except Neo4jStoreError:
        logger.warning("Neo4j dangling GC failed", exc_info=True)

    # 3. 列仍存在 → 加载（原生 SQL：列已从 ORM 模型移除）
    try:
        n_articles, n_comments = await _migrate_load_and_drop(engine)
    except Neo4jStoreError:
        # 加载中途 Neo4j 掉线：列保留（with 上下文回滚 DDL），下次启动重试
        logger.error("Neo4j entity migration interrupted — columns kept, will retry next startup")
        return
    except Exception:
        logger.error("Neo4j entity migration failed", exc_info=True)
        return
    logger.info(
        "Neo4j entity migration complete: %d article(s), %d comment(s)",
        n_articles, n_comments,
    )


async def _migrate_load_and_drop(engine) -> tuple[int, int]:
    """加载 SQLite 实体 JSON 到 Neo4j 并删列（供 migrate_and_drop_columns 调用）。"""
    migrated_articles = migrated_comments = 0
    with engine.connect() as conn:
        if _column_exists(conn, "articles", "entities"):
            rows = conn.exec_driver_sql(
                "SELECT id, created_by, entities FROM articles WHERE entities IS NOT NULL"
            ).fetchall()
            for aid, creator, ent_str in rows:
                try:
                    data = json.loads(ent_str) if isinstance(ent_str, str) else ent_str
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Skip invalid entities JSON for article %s", aid)
                    continue
                if not isinstance(data, dict):
                    continue
                try:
                    await add_article_mentions(
                        aid,
                        data.get("entities", []),
                        data.get("relations", []),
                        source="body",
                        creator=creator or "",
                    )
                except Neo4jStoreError:
                    raise  # Neo4j 掉线 → 中止迁移保留列，下次启动重试
                except Exception:
                    logger.warning("Skip article %s: entities JSON 含非法元素", aid, exc_info=True)
                    continue
                migrated_articles += 1

        if _column_exists(conn, "comments", "entities"):
            rows = conn.exec_driver_sql(
                "SELECT id, article_id, created_by, entities FROM comments WHERE entities IS NOT NULL"
            ).fetchall()
            for cid, aid, creator, ent_str in rows:
                try:
                    data = json.loads(ent_str) if isinstance(ent_str, str) else ent_str
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Skip invalid entities JSON for comment %s", cid)
                    continue
                if not isinstance(data, dict):
                    continue
                try:
                    await add_article_mentions(
                        aid,
                        data.get("entities", []),
                        data.get("relations", []),
                        source=f"comment:{cid}",
                        creator=creator or "",
                    )
                except Neo4jStoreError:
                    raise  # Neo4j 掉线 → 中止迁移保留列，下次启动重试
                except Exception:
                    logger.warning("Skip comment %s: entities JSON 含非法元素", cid, exc_info=True)
                    continue
                migrated_comments += 1

        # 4. 加载完成 → 删列（SQLite ≥ 3.35，已有 DROP COLUMN 先例；失败仅告警）
        for table in ("articles", "comments"):
            try:
                conn.exec_driver_sql(f"ALTER TABLE {table} DROP COLUMN entities")
                logger.info("Dropped legacy column %s.entities (migrated to Neo4j)", table)
            except Exception:
                pass  # 列已不存在（新库/已迁移）
        conn.commit()

    return migrated_articles, migrated_comments
