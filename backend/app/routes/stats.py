import json
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, Category
from app.schemas import StatsResponse

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    article_count = db.query(Article).count()
    category_count = db.query(Category).count()

    # Count unique tags across all articles
    articles = db.query(Article.tags).all()
    tag_set: set[str] = set()
    for (tags_str,) in articles:
        try:
            tags: list[str] = json.loads(tags_str)
            tag_set.update(tags)
        except (json.JSONDecodeError, TypeError):
            pass

    return StatsResponse(
        article_count=article_count,
        category_count=category_count,
        tag_count=len(tag_set),
    )
