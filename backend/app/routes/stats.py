import json
import logging
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, Category
from app.schemas import StatsResponse
from app import neo4j_store
from app.neo4j_store import Neo4jStoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    article_count = db.query(Article).count()
    category_count = db.query(Category).count()

    # Count unique tags (only load the needed column)
    tag_set: set[str] = set()
    for (tags_str,) in db.query(Article.tags).all():
        try:
            tag_set.update(json.loads(tags_str) if tags_str else [])
        except (json.JSONDecodeError, TypeError):
            pass

    # 实体计数来自 Neo4j（实体唯一存储）；不可用时降级为 0（公开端点不能 500）
    try:
        entity_count = neo4j_store.count_distinct_entity_names_sync()
    except Neo4jStoreError as e:
        logger.warning("Entity count query failed: %s", e)
        entity_count = 0

    return StatsResponse(
        article_count=article_count,
        category_count=category_count,
        tag_count=len(tag_set),
        entity_count=entity_count,
    )
