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
    name: str | None = None   # new name (if changing)
    type: str | None = None   # new type (if changing)


class EntityAddRequest(BaseModel):
    entity: dict  # {"name": "...", "type": "..."}
    article_ids: list[str]


class EntityRenameRequest(BaseModel):
    old_name: str
    new_name: str


class EntityRemoveRequest(BaseModel):
    entity_name: str
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


def _check_entity_modify_permission(name: str, user_cn: str, db: Session) -> None:
    """实体修改权限（update/rename/remove 共用）：实体创建人，或任一提及文章的
    创建人即放行；实体与提及文章均无创建人记录时放行（沿用旧版宽松语义）。

    旧版只检查第一个匹配文章（依赖扫描顺序），迁移后按全部提及文章判定——更一致。
    """
    creator, aids = neo4j_store.entity_creator_and_articles_sync(name)
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
            if not await neo4j_store.article_has_entity_name(article.id, name):
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
    user_cn = cert.display_name or ""
    if not old:
        raise HTTPException(status_code=400, detail="Entity name cannot be empty")

    new_name = body.name.strip() if body.name else None
    new_type = body.type.strip() if body.type else None
    if not new_name and not new_type:
        raise HTTPException(status_code=400, detail="Nothing to update")

    try:
        _check_entity_modify_permission(old, user_cn, db)
        _, aids = neo4j_store.entity_creator_and_articles_sync(old)
        # 节点属性 SET：关系边指向节点，改名/改类型后边端点自动跟随（修复旧 JSON
        # 时代 relations[].source_type 不同步的问题）
        neo4j_store.update_entity_props_sync(old, new_name, new_type)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e
    return {"old": old, "name": new_name, "type": new_type, "count": len(aids)}


@router.put("/rename")
def rename_entity(body: EntityRenameRequest, db: Session = Depends(get_db),
                  cert: CertInfo = Depends(get_client_cert)):
    """Rename an entity across all articles (creator only)."""
    old = body.old_name.strip()
    new = body.new_name.strip()
    user_cn = cert.display_name or ""
    if not old or not new:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")

    try:
        _check_entity_modify_permission(old, user_cn, db)
        _, aids = neo4j_store.entity_creator_and_articles_sync(old)
        neo4j_store.rename_entity_sync(old, new)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    # Cascade rename to EntityInfo and chunk entity-tag lines（SQLite，不变）
    db.query(EntityInfo).filter(EntityInfo.entity_name == old).update(
        {EntityInfo.entity_name: new}, synchronize_session=False,
    )
    # 词边界：只匹配「[实体: 旧名 (」前缀（旧名后必须紧跟类型括号），
    # 防止旧名是其他实体名的前缀时误替换（如「AI」与「AI 助手」）
    tag_pattern = re.compile(rf"\[实体:\s*{re.escape(old)}\s*\(")
    affected_chunks = []
    for ch in db.query(ArticleChunk).all():
        if ch.chunk_text and f"[实体: {old}" in ch.chunk_text:
            new_text = tag_pattern.sub(f"[实体: {new} (", ch.chunk_text)
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
        _check_entity_modify_permission(name, user_cn, db)
        _, aids = neo4j_store.entity_creator_and_articles_sync(name)
        neo4j_store.remove_entity_sync(name, body.article_ids or None)
        # If the entity no longer exists in any article, drop its EntityInfo records.
        still_exists = neo4j_store.entity_mentioned_anywhere_sync(name)
    except Neo4jStoreError as e:
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    # Clean up entity tag lines from article chunks（SQLite，不变）
    # 词边界：实体名后必须紧跟类型括号（(，防止「AI」误删「AI 助手」的标签行
    chunk_tag_pattern = re.compile(rf'^\[实体:\s*{re.escape(name)}\s*\(.*\]\s*\n?', re.MULTILINE)
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
