import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk, EntityInfo
from app.auth import get_client_cert, CertInfo
from app.routes.graph import invalidate_graph_cache
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


def _schedule_embedding_recompute(chunks: list):
    """Schedule async embedding recomputation for modified chunks.

    Uses chunk IDs to create an independent DB session inside the async task,
    ensuring embeddings are committed even after the request session closes.
    """
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
            for ch in db_chunks:
                try:
                    vec = await get_embedding(ch.chunk_text)
                    ch.embedding = json.dumps(vec)
                except Exception:
                    logger.warning("Failed to compute embedding for chunk %s", ch.id, exc_info=True)
            db2.commit()
        except Exception:
            logger.warning("Background embedding recompute failed", exc_info=True)
            db2.rollback()
        finally:
            db2.close()

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(recompute())
    except RuntimeError:
        # No running event loop (called from sync route) — run in new loop
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(recompute())
            loop.close()
        except Exception:
            logger.warning("Background embedding recompute failed", exc_info=True)


@router.get("", response_model=list[str])
def list_entities(db: Session = Depends(get_db)):
    articles = db.query(Article).all()
    entity_set: set[str] = set()
    for article in articles:
        if not article.entities:
            continue
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        for e in ent_data.get("entities", []):
            name = e.get("name", "")
            if name:
                entity_set.add(name)
    return sorted(entity_set)


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

    all_matched_chunks: list = []
    for article in articles:
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            ent_data = {"entities": [], "relations": []}
        ents = ent_data.get("entities", [])
        if not any(e.get("name") == name for e in ents):
            ents.append({"name": name, "type": etype, "created_by": user_cn, "created_at": now})
            ent_data["entities"] = ents
            article.entities = json.dumps(ent_data, ensure_ascii=False)

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
                # Article has no chunks yet — create one for the entity
                db.add(ArticleChunk(
                    article_id=article.id,
                    chunk_index="entity_tag",
                    chunk_text=f"[实体标签] {name} ({etype})",
                    embedding=None,
                ))

        all_matched_chunks.extend(matched_chunks)

    # Commit BEFORE scheduling so the recompute task reads the latest chunk
    # text and the newly-created chunks have their IDs assigned.
    db.commit()
    if all_matched_chunks:
        _schedule_embedding_recompute(all_matched_chunks)
    invalidate_graph_cache()
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

    articles = db.query(Article).all()
    count = 0
    for article in articles:
        if not article.entities:
            continue
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        ents = ent_data.get("entities", [])
        rels = ent_data.get("relations", [])
        # Check: user must be entity creator or article creator
        for e in ents:
            if e.get("name") == old:
                creator = e.get("created_by", "") or ""
                article_creator = article.created_by or ""
                if creator != user_cn and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有创建人可以修改实体「{old}」")
                # If no creator info, still allow article creator
                if not creator and article_creator and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有文章创建人可以修改实体「{old}」")
                break
        changed = False
        for e in ents:
            if e.get("name") == old:
                if new_name:
                    e["name"] = new_name
                if new_type:
                    e["type"] = new_type
                changed = True
        for r in rels:
            if new_name and r.get("source") == old:
                r["source"] = new_name
                changed = True
            if new_name and r.get("target") == old:
                r["target"] = new_name
                changed = True
        if changed:
            article.entities = json.dumps(ent_data, ensure_ascii=False)
            count += 1

    db.commit()
    invalidate_graph_cache()
    return {"old": old, "name": new_name, "type": new_type, "count": count}


@router.put("/rename")
def rename_entity(body: EntityRenameRequest, db: Session = Depends(get_db),
                  cert: CertInfo = Depends(get_client_cert)):
    """Rename an entity across all articles (creator only)."""
    old = body.old_name.strip()
    new = body.new_name.strip()
    user_cn = cert.display_name or ""
    if not old or not new:
        raise HTTPException(status_code=400, detail="Entity names cannot be empty")

    articles = db.query(Article).all()
    count = 0
    for article in articles:
        if not article.entities:
            continue
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        ents = ent_data.get("entities", [])
        rels = ent_data.get("relations", [])
        # Check creator
        for e in ents:
            if e.get("name") == old:
                creator = e.get("created_by", "") or ""
                article_creator = article.created_by or ""
                if creator != user_cn and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有创建人可以修改实体「{old}」")
                if not creator and article_creator and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有文章创建人可以修改实体「{old}」")
                break
        changed = False
        for e in ents:
            if e.get("name") == old:
                e["name"] = new
                changed = True
        for r in rels:
            if r.get("source") == old:
                r["source"] = new
                changed = True
            if r.get("target") == old:
                r["target"] = new
                changed = True
        if changed:
            article.entities = json.dumps(ent_data, ensure_ascii=False)
            count += 1

    # Cascade rename to EntityInfo and chunk entity-tag lines
    db.query(EntityInfo).filter(EntityInfo.entity_name == old).update(
        {EntityInfo.entity_name: new}, synchronize_session=False,
    )
    tag_old = f"[实体: {old}"
    tag_new = f"[实体: {new}"
    affected_chunks = []
    for ch in db.query(ArticleChunk).all():
        if ch.chunk_text and tag_old in ch.chunk_text:
            ch.chunk_text = ch.chunk_text.replace(tag_old, tag_new)
            affected_chunks.append(ch)

    db.commit()
    if affected_chunks:
        _schedule_embedding_recompute(affected_chunks)
    invalidate_graph_cache()
    return {"old": old, "new": new, "count": count}


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
    count = 0
    for article in articles:
        if not article.entities:
            continue
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        ents = ent_data.get("entities", [])
        rels = ent_data.get("relations", [])
        # Check creator before removing
        for e in ents:
            if e.get("name") == name:
                creator = e.get("created_by", "") or ""
                article_creator = article.created_by or ""
                if creator != user_cn and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有创建人可以删除实体「{name}」")
                if not creator and article_creator and article_creator != user_cn:
                    raise HTTPException(status_code=403, detail=f"只有文章创建人可以删除实体「{name}」")
                break
        ents = [e for e in ents if e.get("name") != name]
        rels = [r for r in rels if r.get("source") != name and r.get("target") != name]
        ent_data["entities"] = ents
        ent_data["relations"] = rels
        article.entities = json.dumps(ent_data, ensure_ascii=False)
        count += 1

    # Clean up entity tag lines from article chunks
    import re
    chunk_tag_pattern = re.compile(rf'^\[实体:\s*{re.escape(name)}\b.*\]\s*\n?', re.MULTILINE)
    affected_chunks = []
    for article in articles:
        chunks = db.query(ArticleChunk).filter(ArticleChunk.article_id == article.id).all()
        for chunk in chunks:
            if chunk.chunk_text and f"[实体: {name}" in chunk.chunk_text:
                chunk.chunk_text = chunk_tag_pattern.sub("", chunk.chunk_text).rstrip()
                affected_chunks.append(chunk)

    # If the entity no longer exists in any article, drop its EntityInfo records.
    still_exists = False
    for article in db.query(Article).filter(Article.entities.isnot(None)).all():
        try:
            ent_data = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        if any(e.get("name") == name for e in ent_data.get("entities", [])):
            still_exists = True
            break
    if not still_exists:
        db.query(EntityInfo).filter(EntityInfo.entity_name == name).delete(synchronize_session=False)

    db.commit()
    if affected_chunks:
        _schedule_embedding_recompute(affected_chunks)
    invalidate_graph_cache()
    return {"entity": name, "count": count}


# ── Entity Info sync helper ──

def _sync_entity_info_to_chunks(entity_name: str, db: Session) -> list:
    """Sync entity additional info to all matching article chunks for Q&A recall.

    For each article that contains this entity, find chunks mentioning the entity
    name and append/update info reference lines. Returns list of modified chunks.
    """
    # Get all current infos for this entity
    infos = db.query(EntityInfo).filter(
        EntityInfo.entity_name == entity_name
    ).all()

    # Find all articles containing this entity
    articles = db.query(Article).all()
    related_articles: list = []
    for article in articles:
        if not article.entities:
            continue
        try:
            ent_data: dict = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        if any(e.get("name") == entity_name for e in ent_data.get("entities", [])):
            related_articles.append(article)

    if not related_articles:
        return []

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
    matched_chunks = _sync_entity_info_to_chunks(entity_name, db)
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
    matched_chunks = _sync_entity_info_to_chunks(entity_name, db)
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
    matched_chunks = _sync_entity_info_to_chunks(entity_name, db)
    if matched_chunks:
        _schedule_embedding_recompute(matched_chunks)

    return None
