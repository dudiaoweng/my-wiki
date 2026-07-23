import json
import logging
import os
import re
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Path as PathParam
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import desc
from app.dependencies import get_db
from app.models import Article, Category, EntityInfo
from app.schemas import ArticleCreate, ArticleUpdate, ArticleResponse
from app.llm_extract import extract_tags_and_entities
import uuid

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/articles", tags=["articles"])

MAX_PAGE_SIZE = 200
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))


def _validate_article_id(article_id: str) -> None:
    """Validate article ID — accepts UUIDs and legacy short IDs (e.g. 'a1')."""
    if not article_id or len(article_id) > 36:
        raise HTTPException(status_code=400, detail="Invalid article ID format")
    # Only strict-validate if it looks like a UUID (36 chars with dashes)
    if len(article_id) == 36 and '-' in article_id:
        try:
            uuid.UUID(article_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid article ID format")


def _extract_and_merge(article: Article, user_tags: list[str], db: Session) -> None:
    """Call LLM to extract tags + entities from article content, then merge with
    user-provided tags and update the article in the database."""
    llm_tags, entities = extract_tags_and_entities(article.content)

    if llm_tags or entities:
        merged_tags = list(dict.fromkeys([*user_tags, *llm_tags]))
        article.tags = json.dumps(merged_tags, ensure_ascii=False)
        if entities:
            article.entities = json.dumps(entities, ensure_ascii=False)
        db.commit()
        logger.info(
            "LLM extraction success for article %s: %d tags, %d entities",
            article.id, len(llm_tags), len(entities.get("entities", [])) if entities else 0,
        )


@router.get("", response_model=list[ArticleResponse])
def list_articles(
    category_id: str | None = Query(default=None, alias="category_id"),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=MAX_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
):
    q = db.query(Article).options(joinedload(Article.category)).order_by(desc(Article.updated_at))

    if category_id:
        q = q.filter(Article.category_id == category_id)

    if search:
        like = f"%{search}%"
        q = q.filter(
            Article.title.ilike(like) | Article.content.ilike(like)
        )

    if tag:
        # tags stored as JSON array string: ["tag1","tag2"]
        # use LIKE with quoted tag value inside the JSON string
        q = q.filter(Article.tags.like(f'%"{tag}"%'))

    articles = q.offset(skip).limit(limit).all()
    return articles


@router.get("/{article_id}", response_model=ArticleResponse)
def get_article(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return article


@router.post("", response_model=ArticleResponse, status_code=201)
def create_article(body: ArticleCreate, db: Session = Depends(get_db)):
    user_tags = list(dict.fromkeys(body.tags))  # dedup, preserve order
    article = Article(
        title=body.title,
        content=body.content,
        category_id=body.category_id,
        tags=json.dumps(user_tags, ensure_ascii=False),
        entities=json.dumps(body.entities, ensure_ascii=False) if body.entities else None,
    )
    db.add(article)
    db.commit()
    db.refresh(article)

    # Extract tags + entities + relations via LLM
    if body.content.strip():
        _extract_and_merge(article, user_tags, db)
        db.refresh(article)

    return article


@router.put("/{article_id}", response_model=ArticleResponse)
def update_article(
    body: ArticleUpdate,
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    update_data = body.model_dump(exclude_unset=True)
    user_tags = update_data.get("tags") if "tags" in update_data else None

    if "tags" in update_data and update_data["tags"] is not None:
        update_data["tags"] = json.dumps(update_data["tags"], ensure_ascii=False)
    if "entities" in update_data and update_data["entities"] is not None:
        update_data["entities"] = json.dumps(update_data["entities"], ensure_ascii=False)

    for key, value in update_data.items():
        setattr(article, key, value)

    db.commit()
    db.refresh(article)

    # Extract tags + entities via LLM when content was updated (best-effort)
    content_changed = "content" in update_data
    if content_changed and article.content.strip():
        _extract_and_merge(
            article,
            user_tags if isinstance(user_tags, list) else [],
            db,
        )
        db.refresh(article)

    return article


@router.get("/{article_id}/download")
def download_attachment(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    """Download the original attachment file for an article."""
    _validate_article_id(article_id)

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    if not article.attachment_path:
        raise HTTPException(status_code=404, detail="No attachment for this article")

    # Resolve file path — attachment_path stores the safe filename
    file_path = UPLOAD_DIR / article.attachment_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Use the original filename for the download, fall back to stored name
    download_name = article.attachment_name or file_path.name

    return FileResponse(
        path=str(file_path),
        filename=download_name,
        media_type="application/octet-stream",
    )


@router.delete("/{article_id}", status_code=204)
def delete_article(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    # Collect entity names from this article before deleting
    entity_names: set[str] = set()
    if article.entities:
        try:
            ent_data = json.loads(article.entities)
            for e in ent_data.get("entities", []):
                name = e.get("name", "")
                if name:
                    entity_names.add(name)
        except (json.JSONDecodeError, TypeError):
            pass

    db.delete(article)
    db.commit()

    # Clean up entity_infos that no longer appear in any article
    if entity_names:
        still_used: set[str] = set()
        all_articles = db.query(Article.entities).filter(Article.entities.isnot(None)).all()
        for (ent_str,) in all_articles:
            try:
                ent_data = json.loads(ent_str) if isinstance(ent_str, str) else ent_str
                for e in ent_data.get("entities", []):
                    name = e.get("name", "")
                    if name:
                        still_used.add(name)
            except (json.JSONDecodeError, TypeError):
                pass
        orphaned = entity_names - still_used
        if orphaned:
            db.query(EntityInfo).filter(EntityInfo.entity_name.in_(orphaned)).delete(synchronize_session=False)
            db.commit()
            logger.info(f"Cleaned up entity_infos for orphaned entities: {orphaned}")

    # Invalidate knowledge graph cache
    from app.routes.graph import invalidate_graph_cache
    invalidate_graph_cache()

    return None
