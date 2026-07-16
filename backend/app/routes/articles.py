import json
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc
from app.dependencies import get_db
from app.models import Article, Category
from app.schemas import ArticleCreate, ArticleUpdate, ArticleResponse

router = APIRouter(prefix="/api/articles", tags=["articles"])


@router.get("", response_model=list[ArticleResponse])
def list_articles(
    category_id: str | None = Query(default=None, alias="category_id"),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    q = db.query(Article).order_by(desc(Article.updated_at))

    if category_id:
        q = q.filter(Article.category_id == category_id)

    if search:
        like = f"%{search}%"
        q = q.filter(
            Article.title.ilike(like) | Article.content.ilike(like)
        )

    if tag:
        # tags stored as JSON array string: ["tag1","tag2"]
        # search for the quoted tag value inside the JSON string
        q = q.filter(Article.tags.contains(f'"{tag}"'))

    articles = q.all()
    return articles


@router.get("/{article_id}", response_model=ArticleResponse)
def get_article(article_id: str, db: Session = Depends(get_db)):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return article


@router.post("", response_model=ArticleResponse, status_code=201)
def create_article(body: ArticleCreate, db: Session = Depends(get_db)):
    article = Article(
        title=body.title,
        content=body.content,
        category_id=body.category_id,
        tags=json.dumps(body.tags, ensure_ascii=False),
        entities=json.dumps(body.entities, ensure_ascii=False) if body.entities else None,
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    return article


@router.put("/{article_id}", response_model=ArticleResponse)
def update_article(article_id: str, body: ArticleUpdate, db: Session = Depends(get_db)):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    update_data = body.model_dump(exclude_unset=True)
    if "tags" in update_data and update_data["tags"] is not None:
        update_data["tags"] = json.dumps(update_data["tags"], ensure_ascii=False)
    if "entities" in update_data and update_data["entities"] is not None:
        update_data["entities"] = json.dumps(update_data["entities"], ensure_ascii=False)

    for key, value in update_data.items():
        setattr(article, key, value)

    db.commit()
    db.refresh(article)
    return article


@router.delete("/{article_id}", status_code=204)
def delete_article(article_id: str, db: Session = Depends(get_db)):
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    db.delete(article)
    db.commit()
    return None
