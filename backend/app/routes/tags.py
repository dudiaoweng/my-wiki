import json
import uuid
from fastapi import APIRouter, Depends, HTTPException, Body
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article

router = APIRouter(prefix="/api/tags", tags=["tags"])

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


class TagAddRequest(BaseModel):
    tag: str
    article_ids: list[str]


class TagRenameRequest(BaseModel):
    old_name: str
    new_name: str


class TagRemoveRequest(BaseModel):
    tag: str
    article_ids: list[str] | None = None  # None = remove from all articles


@router.get("", response_model=list[str])
def list_tags(db: Session = Depends(get_db)):
    articles = db.query(Article.tags).all()
    tag_set: set[str] = set()
    for (tags_str,) in articles:
        try:
            tags: list[str] = json.loads(tags_str)
            tag_set.update(tags)
        except (json.JSONDecodeError, TypeError):
            pass
    return sorted(tag_set)


@router.post("", status_code=201)
def add_tag(body: TagAddRequest, db: Session = Depends(get_db)):
    """Add a tag to specified articles."""
    tag = body.tag.strip()
    if not tag:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")
    if not body.article_ids:
        raise HTTPException(status_code=400, detail="No articles selected")
    if len(body.article_ids) > MAX_ARTICLE_IDS:
        raise HTTPException(status_code=400, detail=f"Too many article IDs (max {MAX_ARTICLE_IDS})")
    for aid in body.article_ids:
        _validate_aid(aid)

    articles = db.query(Article).filter(Article.id.in_(body.article_ids)).all()
    if not articles:
        raise HTTPException(status_code=404, detail="Articles not found")

    for article in articles:
        try:
            tags: list[str] = json.loads(article.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
        if tag not in tags:
            tags.append(tag)
            article.tags = json.dumps(tags, ensure_ascii=False)

    db.commit()
    return {"tag": tag, "count": len(articles)}


@router.put("/rename")
def rename_tag(body: TagRenameRequest, db: Session = Depends(get_db)):
    """Rename a tag across all articles."""
    old = body.old_name.strip()
    new = body.new_name.strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="Tag names cannot be empty")

    articles = db.query(Article).all()
    count = 0
    for article in articles:
        try:
            tags: list[str] = json.loads(article.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
        if old in tags:
            tags = [new if t == old else t for t in tags]
            article.tags = json.dumps(tags, ensure_ascii=False)
            count += 1

    db.commit()
    return {"old": old, "new": new, "count": count}


@router.post("/remove", status_code=200)
def remove_tag(body: TagRemoveRequest, db: Session = Depends(get_db)):
    """Remove a tag from specified articles (or all if not specified)."""
    tag = body.tag.strip()
    if not tag:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")

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
        try:
            tags: list[str] = json.loads(article.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
        if tag in tags:
            tags.remove(tag)
            article.tags = json.dumps(tags, ensure_ascii=False)
            count += 1

    db.commit()
    return {"tag": tag, "count": count}


class TagsByArticleResponse(BaseModel):
    article_id: str
    title: str
    tags: list[str]


@router.get("/by-article", response_model=list[TagsByArticleResponse])
def tags_by_article(
    article_ids: str | None = None,
    db: Session = Depends(get_db),
):
    """Get tags grouped by article, optionally filtered by article IDs (comma-separated)."""
    query = db.query(Article)
    if article_ids:
        ids = [i.strip() for i in article_ids.split(",") if i.strip()]
        if ids:
            query = query.filter(Article.id.in_(ids))

    articles = query.all()
    return [
        TagsByArticleResponse(
            article_id=a.id,
            title=a.title,
            tags=json.loads(a.tags) if a.tags else [],
        )
        for a in articles
    ]
