import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk, EntityInfo
from app.auth import get_client_cert, CertInfo
from app import vector_store
from app import neo4j_store
from app.neo4j_store import Neo4jStoreError
import asyncio

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/entities", tags=["entities"])

MAX_ARTICLE_IDS = 500  # Keep well under SQLite's ~999 bind variable limit


def _validate_aid(aid: str) -> None:
    """Validate article ID — accepts UUIDs and legacy short IDs (e.g. 'a1')."""
    if not aid or len(aid) > 36:
        raise HTTPException(status_code=400, detail=f"Invalid article ID: {aid}")
    if len(aid) == 36 and '-' in aid:
        try:
            uuid.UUID(aid)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid article ID: {aid}")


class EntityUpdateRequest(BaseModel):
    old_name: str
    old_type: str | None = None  # 限定要修改的类型变体（同名不同类型是不同实体）
    name: str | None = None      # new name (if changing)
    type: str | None = None      # new type (if changing)


class EntityAddRequest(BaseModel):
    entity: dict  # {"name": "...", "type": "..."}
    article_ids: list[str]


class EntityRenameRequest(BaseModel):
    old_name: str
    old_type: str | None = None
    new_name: str


class EntityRemoveRequest(BaseModel):
    entity_name: str
    entity_type: str | None = None  # 限定类型变体（None = 按名称移除全部类型）
    article_ids: list[str] | None = None


# ── Entity relation (RELATES) schemas ──

class EntityRelationResponse(BaseModel):
    source_name: str
    source_type: str
    target_name: str
    target_type: str
    label: str
    article_ids: list[str] = []


class RelationQueryRequest(BaseModel):
    entity_name: str
    entity_type: str | None = None
    article_ids: list[str] | None = None


class RelationCreateRequest(BaseModel):
    # 权限主体：实体信息面板当前选中的实体（方向 ← 时它是 target）
    owner_name: str | None = None
    owner_type: str | None = None
    source_name: str
    source_type: str | None = None
    target_name: str
    target_type: str | None = None
    label: str = "关联"
    article_ids: list[str] | None = None


class RelationUpdateRequest(BaseModel):
    owner_name: str            # 权限校验对象：实体信息面板当前选中的实体
    owner_type: str | None = None
    source_name: str
    source_type: str | None = None
    target_name: str
    target_type: str | None = None
    old_label: str
    new_source_name: str
    new_source_type: str | None = None
    new_target_name: str
    new_target_type: str | None = None
    new_label: str = "关联"
    article_ids: list[str] | None = None


class RelationDeleteRequest(BaseModel):
    owner_name: str
    owner_type: str | None = None
    source_name: str
    source_type: str | None = None
    target_name: str
    target_type: str | None = None
    label: str = "关联"
    article_ids: list[str] | None = None


# ── Entity Info schemas ──

class EntityInfoCreate(BaseModel):
    name: str = ""
    content: str = ""


class EntityInfoUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None


class EntityInfoResponse(BaseModel):
    id: str
    entity_name: str
    name: str
    content: str
    created_by: Optional[str] = None
    created_at: str
    updated_at: str


# 主事件循环引用：sync 路由（线程池）经 run_coroutine_threadsafe 把嵌入重算
# 投递到主循环，避免请求线程阻塞在数十秒的 LLM 嵌入调用上
_embed_main_loop = None


def _schedule_embedding_recompute(chunks: list):
    """Schedule async embedding recomputation for modified chunks.

    Uses chunk IDs to create an independent DB session inside the async task,
    ensuring embeddings are committed even after the request session closes.
    """
    global _embed_main_loop

    # Capture only IDs — the request session may close before the async task runs
    chunk_ids = [ch.id for ch in chunks if ch.id]

    async def recompute():
        from app.database import SessionLocal
        from app.routes.qa import get_embedding
        from app.models import ArticleChunk

        db2 = SessionLocal()
        try:
            db_chunks = db2.query(ArticleChunk).filter(
                ArticleChunk.id.in_(chunk_ids)
            ).all()
            # 向量只存 Qdrant：计算后直接 upsert（payload 携带更新后的 chunk_text）
            points = []
            for ch in db_chunks:
                try:
                    vec = await get_embedding(ch.chunk_text)
                    points.append(vector_store.make_point(
                        ch.id, vec, ch.article_id, ch.chunk_index, ch.chunk_text,
                    ))
                except Exception:
                    logger.warning("Failed to compute embedding for chunk %s", ch.id, exc_info=True)
            if points:
                await vector_store.upsert_chunks(points)
        except Exception:
            logger.warning("Background embedding recompute failed", exc_info=True)
        finally:
            db2.close()

    try:
        loop = asyncio.get_running_loop()
        _embed_main_loop = loop
        loop.create_task(recompute())
    except RuntimeError:
        # sync 路由（线程池）：投递到主事件循环异步执行；主循环尚未捕获
        # （启动早期等极端场景）才退回同步兜底
        if _embed_main_loop is not None and _embed_main_loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(recompute(), _embed_main_loop)
                return
            except Exception:
                logger.warning("Failed to schedule recompute onto main loop", exc_info=True)
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(recompute())
            loop.close()
        except Exception:
            logger.warning("Background embedding recompute failed", exc_info=True)


def _check_entity_modify_permission(
    name: str,
    user_cn: str,
    db: Session,
    etype: str | None = None,
) -> None:
    """实体修改权限（update/rename/remove 共用）：实体创建人，或任一提及文章的
    创建人即放行；实体与提及文章均无创建人记录时放行（沿用旧版宽松语义）。

    etype 非 None 时按 (name, type) 判定——同名不同类型的实体不共享权限。
    旧版只检查第一个匹配文章（依赖扫描顺序），迁移后按全部提及文章判定——更一致。
    """
    creator, aids = neo4j_store.entity_creator_and_articles_sync(name, etype)
    if creator and creator == user_cn:
        return
    article_creators: list[str] = []
    # aids 来自 Neo4j（无上限）：按 500 分块查询，避免 SQLite 绑定变量超限
    for i in range(0, len(aids), 500):
        rows = db.query(Article.created_by).filter(Article.id.in_(aids[i:i + 500])).all()
        article_creators.extend(row[0] or "" for row in rows)
    if any(ac == user_cn for ac in article_creators):
        return
    if not creator and not any(article_creators):
        return
    raise HTTPException(status_code=403, detail=f"只有创建人可以修改实体「{name}」")


@router.get("", response_model=list[str])
def list_entities(db: Session = Depends(get_db)):
    # 实体名来自 Neo4j（唯一存储）；不可用时降级为空列表（面板空显示，不 500）
    try:
        return neo4j_store.all_entity_names_sync()
    except Neo4jStoreError as e:
        logger.warning("Entity list query failed: %s", e)
        return []


@router.post("", status_code=201)
async def add_entity(body: EntityAddRequest, db: Session = Depends(get_db),
                     cert: CertInfo = Depends(get_client_cert)):
    """Add an entity to specified articles."""
    ent = body.entity
    name = ent.get("name", "").strip()
    etype = ent.get("type", "").strip() or "concept"
    user_cn = cert.display_name or ""
    now = datetime.now(timezone.utc).isoformat()
    if not name:
        raise HTTPException(status_code=400, detail="Entity name cannot be empty")
    if not body.article_ids:
        raise HTTPException(status_code=400, detail="No articles selected")
    if len(body.article_ids) > MAX_ARTICLE_IDS:
        raise HTTPException(status_code=400, detail=f"Too many article IDs (max {MAX_ARTICLE_IDS})")
    for aid in body.article_ids:
        _validate_aid(aid)

    articles = db.query(Article).filter(Article.id.in_(body.article_ids)).all()
    if not articles:
        raise HTTPException(status_code=404, detail="Articles not found")

    # Neo4j 写入先行（按名去重后单事务批量 MERGE）；失败 503，SQLite 不动。
    # 单事务保证全部成功或全部失败——避免逐篇写中途失败产生半态（部分文章
    # 已有边但标签行未写、重试被去重跳过导致标签行永久缺失）
    try:
        entries = []
        for article in articles:
            if not await neo4j_store.article_has_entity_name(article.id, name, etype):
                entries.append({
                    "aid": article.id,
                    "name": name,
                    "type": etype,
                    "created_by": user_cn,
                    "created_at": now,
                })
        await neo4j_store.add_entities_to_articles_bulk(entries)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    all_matched_chunks: list = []
    for article in articles:
        # Link entity to chunks for QA recall
        chunks = db.query(ArticleChunk).filter(
            ArticleChunk.article_id == article.id
        ).all()
        tag_line = f"\n[实体: {name} ({etype})]"
        matched_chunks = []
        for ch in chunks:
            if name.lower() in ch.chunk_text.lower() and tag_line not in ch.chunk_text:
                ch.chunk_text = ch.chunk_text.rstrip() + tag_line
                matched_chunks.append(ch)

        # If no chunk mentions the entity, add tag to the first chunk (or create one)
        if not matched_chunks:
            if chunks:
                chunks[0].chunk_text = chunks[0].chunk_text.rstrip() + tag_line
                matched_chunks.append(chunks[0])
            else:
                # Article has no chunks yet — create one for the entity；
                # 向量由下方 _schedule_embedding_recompute 计算并写入 Qdrant
                tag_chunk = ArticleChunk(
                    article_id=article.id,
                    chunk_index="entity_tag",
                    chunk_text=f"[实体标签] {name} ({etype})",
                )
                db.add(tag_chunk)
                matched_chunks.append(tag_chunk)

        all_matched_chunks.extend(matched_chunks)

    # Commit BEFORE scheduling so the recompute task reads the latest chunk
    # text and the newly-created chunks have their IDs assigned.
    db.commit()
    if all_matched_chunks:
        _schedule_embedding_recompute(all_matched_chunks)
    return {"name": name, "type": etype, "count": len(articles)}


@router.put("/update")
def update_entity(body: EntityUpdateRequest, db: Session = Depends(get_db),
                  cert: CertInfo = Depends(get_client_cert)):
    """Update an entity's name and/or type (creator only)."""
    old = body.old_name.strip()
    old_type = body.old_type.strip() if isinstance(body.old_type, str) else None
    user_cn = cert.display_name or ""
    if not old:
        raise HTTPException(status_code=400, detail="Entity name cannot be empty")

    new_name = body.name.strip() if body.name else None
    new_type = body.type.strip() if body.type else None
    if not new_name and not new_type:
        raise HTTPException(status_code=400, detail="Nothing to update")

    try:
        if not neo4j_store.entity_exists_sync(old, old_type):
            raise HTTPException(status_code=404, detail=f"实体不存在：{old}")
        _check_entity_modify_permission(old, user_cn, db, old_type)
        _, aids = neo4j_store.entity_creator_and_articles_sync(old, old_type)
        # 节点属性 SET：关系边指向节点，改名/改类型后边端点自动跟随（修复旧 JSON
        # 时代 relations[].source_type 不同步的问题）。old_type 限定类型变体，
        # 避免同名其他类型的节点被一起改掉。
        neo4j_store.update_entity_props_sync(old, new_name, new_type, old_type)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    # 类型变更同步分块实体标签（QA 召回依赖标签里的类型）；名称变更由 /rename 负责。
    affected_chunks = []
    if new_type is not None:
        if old_type is None:
            type_tag_pattern = re.compile(
                rf"\[实体:\s*{re.escape(old)}\s*\([^)]*\)\]",
            )
        else:
            type_tag_pattern = re.compile(
                rf"\[实体:\s*{re.escape(old)}\s*\({re.escape(old_type)}\)\]",
            )
        tag_replacement = f"[实体: {old} ({new_type})]"
        for ch in db.query(ArticleChunk).all():
            if ch.chunk_text and f"[实体: {old}" in ch.chunk_text:
                new_text = type_tag_pattern.sub(tag_replacement, ch.chunk_text)
                if new_text != ch.chunk_text:
                    ch.chunk_text = new_text
                    affected_chunks.append(ch)
        if affected_chunks:
            db.commit()
            _schedule_embedding_recompute(affected_chunks)
    return {"old": old, "name": new_name, "type": new_type, "count": len(aids)}


@router.put("/rename")
def rename_entity(body: EntityRenameRequest, db: Session = Depends(get_db),
                  cert: CertInfo = Depends(get_client_cert)):
    """Rename an entity across all articles (creator only).

    old_type 非 None 时只重命名该类型变体。附加信息按名称共享，只有旧名称下
    已无其他类型变体时才级联改名；分块标签行带类型，按类型精确更新。
    """
    old = body.old_name.strip()
    old_type = body.old_type.strip() if isinstance(body.old_type, str) else None
    new = body.new_name.strip()
    user_cn = cert.display_name or ""
    if not old or not new:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")

    try:
        if not neo4j_store.entity_exists_sync(old, old_type):
            raise HTTPException(status_code=404, detail=f"实体不存在：{old}")
        _check_entity_modify_permission(old, user_cn, db, old_type)
        _, aids = neo4j_store.entity_creator_and_articles_sync(old, old_type)
        neo4j_store.rename_entity_sync(old, new, old_type)
        remaining_old_name = neo4j_store.count_entity_nodes_named_sync(old)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    affected_chunks = []
    # EntityInfo 按名称共享：只有旧名称下已无其他类型变体时才级联改名。
    if remaining_old_name == 0:
        db.query(EntityInfo).filter(EntityInfo.entity_name == old).update(
            {EntityInfo.entity_name: new}, synchronize_session=False,
        )
    # 分块标签行带类型：即使其他类型变体仍保留旧名称，也只替换本类型的标签。
    # 词边界：只匹配「[实体: 旧名 (」，防止旧名是其他实体名的前缀。
    if old_type is None:
        tag_pattern = re.compile(rf"\[实体:\s*{re.escape(old)}\s*\(")
        tag_replacement = f"[实体: {new} ("
    else:
        tag_pattern = re.compile(
            rf"\[实体:\s*{re.escape(old)}\s*\({re.escape(old_type)}\)\]",
        )
        tag_replacement = f"[实体: {new} ({old_type})]"
    for ch in db.query(ArticleChunk).all():
        if ch.chunk_text and f"[实体: {old}" in ch.chunk_text:
            new_text = tag_pattern.sub(tag_replacement, ch.chunk_text)
            if new_text != ch.chunk_text:
                ch.chunk_text = new_text
                affected_chunks.append(ch)

    db.commit()
    if affected_chunks:
        _schedule_embedding_recompute(affected_chunks)
    return {"old": old, "new": new, "count": len(aids)}


@router.delete("/remove", status_code=200)
def remove_entity(body: EntityRemoveRequest, db: Session = Depends(get_db),
                  cert: CertInfo = Depends(get_client_cert)):
    """Remove an entity from specified articles (creator only)."""
    name = body.entity_name.strip()
    etype = body.entity_type.strip() if isinstance(body.entity_type, str) else None
    user_cn = cert.display_name or ""
    if not name:
        raise HTTPException(status_code=400, detail="Entity name cannot be empty")

    query = db.query(Article)
    if body.article_ids:
        if len(body.article_ids) > MAX_ARTICLE_IDS:
            raise HTTPException(status_code=400, detail=f"Too many article IDs (max {MAX_ARTICLE_IDS})")
        for aid in body.article_ids:
            _validate_aid(aid)
        query = query.filter(Article.id.in_(body.article_ids))

    articles = query.all()

    # Neo4j 删除先行（权限 + 删边）：失败 503，SQLite（标签行/EntityInfo）不动
    try:
        _check_entity_modify_permission(name, user_cn, db, etype)
        _, aids = neo4j_store.entity_creator_and_articles_sync(name, etype)
        neo4j_store.remove_entity_sync(name, body.article_ids or None, etype)
        # If the entity no longer exists in any article, drop its EntityInfo records.
        # 同名其他类型仍存在时仍为 True → 保留共享的附加信息。
        still_exists = neo4j_store.entity_mentioned_anywhere_sync(name)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    # Clean up entity tag lines from article chunks（SQLite，不变）
    # 词边界：实体名后必须紧跟类型括号（(，防止「AI」误删「AI 助手」的标签行。
    # 指定类型时只清理该类型的标签，保留同名其他类型的标签行。
    if etype is None:
        chunk_tag_pattern = re.compile(
            rf'^\[实体:\s*{re.escape(name)}\s*\(.*\]\s*\n?', re.MULTILINE,
        )
    else:
        chunk_tag_pattern = re.compile(
            rf'^\[实体:\s*{re.escape(name)}\s*\({re.escape(etype)}\)\]\s*\n?',
            re.MULTILINE,
        )
    affected_chunks = []
    for article in articles:
        chunks = db.query(ArticleChunk).filter(ArticleChunk.article_id == article.id).all()
        for chunk in chunks:
            if chunk.chunk_text and f"[实体: {name}" in chunk.chunk_text:
                chunk.chunk_text = chunk_tag_pattern.sub("", chunk.chunk_text).rstrip()
                affected_chunks.append(chunk)

    if not still_exists:
        db.query(EntityInfo).filter(EntityInfo.entity_name == name).delete(synchronize_session=False)

    db.commit()
    if affected_chunks:
        _schedule_embedding_recompute(affected_chunks)
    count = len(articles) if body.article_ids else len(aids)
    return {"entity": name, "count": count}


# ── Entity relation (RELATES) CRUD ──
# 关联信息编辑：对端只能选择本文章中的实体（服务端用「两端实体在同一文章
# 被提及」的 MATCH 强制校验，前端下拉也仅列出当前文章的实体）。

def _relation_aids(
    article_ids: list[str] | None,
    *,
    required: bool = False,
) -> list[str] | None:
    """校验并规范化文章范围。

    查询（required=False）：None/空表示全部文章。
    写入（required=True）：必须显式给出文章范围——关系边按文章存储，缺省
    “全部文章”会把删除/新增悄悄扩散到所有共同提及的文章。
    """
    if not article_ids:
        if required:
            raise HTTPException(status_code=400, detail="缺少文章范围（article_ids）")
        return None
    if len(article_ids) > MAX_ARTICLE_IDS:
        raise HTTPException(status_code=400, detail=f"Too many article IDs (max {MAX_ARTICLE_IDS})")
    for aid in article_ids:
        _validate_aid(aid)
    return article_ids


def _resolve_relation_owner(
    owner: str,
    owner_type: str | None,
    source_name: str,
    source_type: str | None,
    target_name: str,
    target_type: str | None,
) -> str:
    """确认 owner 是关系端点，并返回其精确类型（供按类型权限检查）。

    owner_type 缺省时自动从端点推导；若同名两端类型不同则要求显式指定，
    避免按名称放行同名不同类的实体。
    """
    if source_type is None or target_type is None:
        raise HTTPException(status_code=400, detail="写关系必须提供两端实体的明确类型")
    matches: list[str] = []
    if owner == source_name:
        matches.append(source_type)
    if owner == target_name:
        matches.append(target_type)
    if not matches:
        raise HTTPException(status_code=400, detail="关联修改对象必须是该关联的一端实体")
    if owner_type is not None:
        normalized = owner_type.strip()
        if normalized not in matches:
            raise HTTPException(status_code=400, detail="关联修改对象的类型必须与端点一致")
        return normalized
    if len(set(matches)) != 1:
        raise HTTPException(status_code=400, detail="同名实体存在多个类型，请指定 owner_type")
    return matches[0]


@router.post("/relations/query", response_model=list[EntityRelationResponse])
def query_entity_relations(body: RelationQueryRequest):
    """某实体的关系列表（可按当前文章范围过滤；用于实体信息面板展示）。"""
    name = body.entity_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Entity name cannot be empty")
    try:
        return neo4j_store.get_entity_relations_sync(
            name, body.entity_type, _relation_aids(body.article_ids),
        )
    except Neo4jStoreError as e:
        logger.warning("Entity relation query failed: %s", e)
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e


@router.post("/relations", status_code=201)
def create_entity_relation(body: RelationCreateRequest, db: Session = Depends(get_db),
                           cert: CertInfo = Depends(get_client_cert)):
    """新增实体关系（source → target）；对端必须是本文章中的实体。"""
    src = body.source_name.strip()
    tgt = body.target_name.strip()
    # 方向 ← 时当前选中实体是 target；权限主体必须始终是 owner，而不是 source
    owner = (body.owner_name or src).strip()
    label = (body.label or "").strip() or "关联"
    user_cn = cert.display_name or ""
    if not src or not tgt or not owner:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")
    if src == tgt and (body.source_type or "") == (body.target_type or ""):
        raise HTTPException(status_code=400, detail="不能创建实体到自身的关联")
    aids = _relation_aids(body.article_ids, required=True)
    try:
        owner_type = _resolve_relation_owner(
            owner, body.owner_type, src, body.source_type, tgt, body.target_type,
        )
        _check_entity_modify_permission(owner, user_cn, db, owner_type)
        # 对端必须与本端共同出现在（范围内）文章中
        if not neo4j_store.articles_mentioning_both_sync(
            src, body.source_type, tgt, body.target_type, aids,
        ):
            raise HTTPException(status_code=400, detail="对端实体不在当前文章实体中")
        n = neo4j_store.create_entity_relation_sync(
            src, body.source_type, tgt, body.target_type, label, aids,
        )
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e
    if n == 0:
        raise HTTPException(status_code=400, detail="对端实体不在当前文章实体中")
    return {"created": n}


@router.put("/relations")
def update_entity_relation(body: RelationUpdateRequest, db: Session = Depends(get_db),
                           cert: CertInfo = Depends(get_client_cert)):
    """修改实体关系：关系名、方向或对端实体；只作用于旧关系实际存在的文章。"""
    owner = body.owner_name.strip()
    src = body.source_name.strip()
    tgt = body.target_name.strip()
    new_src = body.new_source_name.strip()
    new_tgt = body.new_target_name.strip()
    old_label = (body.old_label or "").strip() or "关联"
    new_label = (body.new_label or "").strip() or "关联"
    user_cn = cert.display_name or ""
    if not owner or not src or not tgt or not new_src or not new_tgt:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")
    if new_src == new_tgt and (body.new_source_type or "") == (body.new_target_type or ""):
        raise HTTPException(status_code=400, detail="不能创建实体到自身的关联")
    aids = _relation_aids(body.article_ids, required=True)
    skipped = 0
    try:
        old_owner_type = _resolve_relation_owner(
            owner, body.owner_type, src, body.source_type, tgt, body.target_type,
        )
        new_owner_type = _resolve_relation_owner(
            owner, body.owner_type, new_src, body.new_source_type,
            new_tgt, body.new_target_type,
        )
        if old_owner_type != new_owner_type:
            raise HTTPException(status_code=400, detail="关联修改对象的类型不能改变")
        _check_entity_modify_permission(owner, user_cn, db, old_owner_type)
        # 未变化直接返回（避免删旧建新把自动抽取边改成手工边）
        if (src, body.source_type or "", tgt, body.target_type or "", old_label) == (
            new_src, body.new_source_type or "", new_tgt, body.new_target_type or "", new_label,
        ):
            return {"updated": 0, "skipped": 0}
        # 只修改旧关系实际存在的文章：不能因为两端在范围内其他文章共同出现
        # 就凭空新增关系（旧实现会这样扩散）。
        old_aids = neo4j_store.get_entity_relation_article_ids_sync(
            src, body.source_type, tgt, body.target_type, old_label, aids,
        )
        if not old_aids:
            raise HTTPException(status_code=404, detail="关联不存在或已被删除")
        old_spec = {
            "source_name": src, "source_type": body.source_type,
            "target_name": tgt, "target_type": body.target_type,
            "label": old_label,
        }
        new_spec = {
            "source_name": new_src, "source_type": body.new_source_type,
            "target_name": new_tgt, "target_type": body.new_target_type,
            "label": new_label,
        }
        old_pair = (src, body.source_type or "", tgt, body.target_type or "")
        new_pair = (new_src, body.new_source_type or "", new_tgt, body.new_target_type or "")
        if old_pair == new_pair:
            # 两端不变、只改关系名：原地改名（可处理带类型但未共同提及的端点）
            updated = neo4j_store.rename_entity_relation_label_sync(old_spec, new_label, old_aids)
        elif old_pair == (new_tgt, body.new_target_type or "", new_src, body.new_source_type or ""):
            # 仅切换方向：在旧边所在文章中反向建边
            updated = neo4j_store.reorient_entity_relation_sync(old_spec, new_spec, old_aids)
        else:
            # 对端发生变化：只在“旧边存在且新对端也能成立”的文章中替换；
            # 其余文章保留原关系，避免静默丢失。
            common_aids = neo4j_store.articles_mentioning_both_sync(
                new_src, body.new_source_type, new_tgt, body.new_target_type, old_aids,
            )
            if not common_aids:
                raise HTTPException(status_code=400, detail="修改后的对端与原关联不在同一篇文章中")
            updated = neo4j_store.update_entity_relation_sync(old_spec, new_spec, common_aids)
            skipped = len(set(old_aids) - set(common_aids))
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e
    return {"updated": updated, "skipped": skipped}


@router.delete("/relations")
def delete_entity_relation(body: RelationDeleteRequest, db: Session = Depends(get_db),
                           cert: CertInfo = Depends(get_client_cert)):
    """删除实体关系（按两端实体 + 关系名；必须指定文章范围）。"""
    owner = body.owner_name.strip()
    src = body.source_name.strip()
    tgt = body.target_name.strip()
    label = (body.label or "").strip() or "关联"
    user_cn = cert.display_name or ""
    if not owner or not src or not tgt:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")
    aids = _relation_aids(body.article_ids, required=True)
    try:
        owner_type = _resolve_relation_owner(
            owner, body.owner_type, src, body.source_type, tgt, body.target_type,
        )
        _check_entity_modify_permission(owner, user_cn, db, owner_type)
        n = neo4j_store.delete_entity_relation_sync(
            src, body.source_type, tgt, body.target_type, label, aids,
        )
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e
    return {"deleted": n}


# ── Entity Info sync helper ──

async def _sync_entity_info_to_chunks(entity_name: str, db: Session) -> list:
    """Sync entity additional info to all matching article chunks for Q&A recall.

    For each article that contains this entity, find chunks mentioning the entity
    name and append/update info reference lines. Returns list of modified chunks.
    """
    # Get all current infos for this entity
    infos = db.query(EntityInfo).filter(
        EntityInfo.entity_name == entity_name
    ).all()

    # 提及该实体的文章来自 Neo4j（唯一存储）；不可用时跳过同步——附加信息
    # 的 CRUD 本身不受影响，分块信息行下次同步补上
    try:
        aids = await neo4j_store.articles_mentioning(entity_name)
    except Neo4jStoreError as e:
        logger.warning("Entity info chunk sync skipped (Neo4j unavailable): %s", e)
        return []
    if not aids:
        return []
    related_articles: list = []
    # aids 来自 Neo4j（无上限）：按 500 分块查询，避免 SQLite 绑定变量超限
    for i in range(0, len(aids), 500):
        related_articles.extend(db.query(Article).filter(Article.id.in_(aids[i:i + 500])).all())

    # Build current info tag lines
    info_lines = []
    for info in infos:
        info_lines.append(f"[实体信息: {entity_name} | {info.name}: {info.content}]")

    # Remove old info lines and add current ones
    info_prefix = f"[实体信息: {entity_name} |"
    matched_chunks = []
    for article in related_articles:
        chunks = db.query(ArticleChunk).filter(
            ArticleChunk.article_id == article.id
        ).all()
        for ch in chunks:
            # Remove old info lines for this entity
            lines = ch.chunk_text.split("\n")
            new_lines = [line for line in lines if not line.startswith(info_prefix)]
            ch.chunk_text = "\n".join(new_lines)

            # If chunk mentions entity, add current info lines
            if entity_name.lower() in ch.chunk_text.lower():
                for line in info_lines:
                    if line not in ch.chunk_text:
                        ch.chunk_text = ch.chunk_text.rstrip() + "\n" + line
                matched_chunks.append(ch)

    db.commit()
    return matched_chunks


# ── Entity Info CRUD (附加信息) ──

@router.get("/{entity_name}/info", response_model=list[EntityInfoResponse])
def list_entity_infos(entity_name: str, db: Session = Depends(get_db)):
    """List all additional info entries for an entity."""
    infos = db.query(EntityInfo).filter(
        EntityInfo.entity_name == entity_name
    ).order_by(EntityInfo.created_at.asc()).all()
    return [
        EntityInfoResponse(
            id=info.id,
            entity_name=info.entity_name,
            name=info.name,
            content=info.content,
            created_by=info.created_by,
            created_at=info.created_at.isoformat() if info.created_at else "",
            updated_at=info.updated_at.isoformat() if info.updated_at else "",
        )
        for info in infos
    ]


@router.post("/{entity_name}/info", response_model=EntityInfoResponse, status_code=201)
async def create_entity_info(entity_name: str, body: EntityInfoCreate,
                               db: Session = Depends(get_db),
                               cert: CertInfo = Depends(get_client_cert)):
    """Create a new additional info entry for an entity."""
    user_cn = cert.display_name or ""
    info = EntityInfo(
        entity_name=entity_name,
        name=body.name.strip(),
        content=body.content.strip(),
        created_by=user_cn or None,
    )
    db.add(info)
    db.commit()
    db.refresh(info)

    # Sync info to chunks for Q&A recall
    matched_chunks = await _sync_entity_info_to_chunks(entity_name, db)
    if matched_chunks:
        _schedule_embedding_recompute(matched_chunks)

    return EntityInfoResponse(
        id=info.id,
        entity_name=info.entity_name,
        name=info.name,
        content=info.content,
        created_by=info.created_by,
        created_at=info.created_at.isoformat() if info.created_at else "",
        updated_at=info.updated_at.isoformat() if info.updated_at else "",
    )


@router.put("/{entity_name}/info/{info_id}", response_model=EntityInfoResponse)
async def update_entity_info(entity_name: str, info_id: str, body: EntityInfoUpdate,
                               db: Session = Depends(get_db),
                               cert: CertInfo = Depends(get_client_cert)):
    """Update an additional info entry (creator only)."""
    info = db.query(EntityInfo).filter(
        EntityInfo.id == info_id,
        EntityInfo.entity_name == entity_name,
    ).first()
    if not info:
        raise HTTPException(status_code=404, detail="Info entry not found")
    user_cn = cert.display_name or ""
    if info.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有创建人可以修改该信息")
    if body.name is not None:
        info.name = body.name.strip()
    if body.content is not None:
        info.content = body.content.strip()
    db.commit()
    db.refresh(info)

    # Sync info to chunks for Q&A recall
    matched_chunks = await _sync_entity_info_to_chunks(entity_name, db)
    if matched_chunks:
        _schedule_embedding_recompute(matched_chunks)

    return EntityInfoResponse(
        id=info.id,
        entity_name=info.entity_name,
        name=info.name,
        content=info.content,
        created_by=info.created_by,
        created_at=info.created_at.isoformat() if info.created_at else "",
        updated_at=info.updated_at.isoformat() if info.updated_at else "",
    )


@router.delete("/{entity_name}/info/{info_id}", status_code=204)
async def delete_entity_info(entity_name: str, info_id: str,
                               db: Session = Depends(get_db),
                               cert: CertInfo = Depends(get_client_cert)):
    """Delete an additional info entry (creator only)."""
    info = db.query(EntityInfo).filter(
        EntityInfo.id == info_id,
        EntityInfo.entity_name == entity_name,
    ).first()
    if not info:
        raise HTTPException(status_code=404, detail="Info entry not found")
    user_cn = cert.display_name or ""
    if info.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有创建人可以删除该信息")
    db.delete(info)
    db.commit()

    # Sync remaining infos (or clear all) to chunks
    matched_chunks = await _sync_entity_info_to_chunks(entity_name, db)
    if matched_chunks:
        _schedule_embedding_recompute(matched_chunks)

    return None
