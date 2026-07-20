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

    # Count unique tags and entities (only load the needed columns)
    articles_data = db.query(Article.tags, Article.entities).all()
    tag_set: set[str] = set()
    entity_set: set[str] = set()
    for tags_str, entities_str in articles_data:
        try:
            tags: list[str] = json.loads(tags_str) if tags_str else []
            tag_set.update(tags)
        except (json.JSONDecodeError, TypeError):
            pass
        if entities_str:
            try:
                ent_data = json.loads(entities_str) if isinstance(entities_str, str) else entities_str
                for e in ent_data.get("entities", []):
                    name = e.get("name", "")
                    if name:
                        entity_set.add(name)
            except (json.JSONDecodeError, TypeError):
                pass

    return StatsResponse(
        article_count=article_count,
        category_count=category_count,
        tag_count=len(tag_set),
        entity_count=len(entity_set),
    )
