import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.dependencies import get_db
from app.models import Article, Category
from app import neo4j_store
from app.neo4j_store import Neo4jStoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/graph", tags=["graph"])


class GraphNode(BaseModel):
    id: str
    label: str
    type: str  # "article" | "category" | "entity"
    url: str
    color: str | None = None
    entity_type: str | None = None  # 实体语义类型（人物/组织/地点…），前端据此渲染图标


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


@router.get("", response_model=GraphResponse)
def get_graph(db: Session = Depends(get_db)):
    """知识图谱：文章/分类节点来自 SQLite（标题/颜色），实体/提及/关系边来自 Neo4j。

    v2.3 前这里全表扫描 articles.entities JSON 现搭图（30s TTL 缓存）；
    Neo4j 直查后无需缓存，前端已有 articleVersion → refetchGraph 刷新机制。
    """
    try:
        entity_recs, mention_recs, relate_recs = neo4j_store.graph_data_sync()
    except Neo4jStoreError as e:
        logger.warning("Graph data query failed: %s", e)
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    articles = db.query(Article).all()
    categories = db.query(Category).all()

    MAX_NODES = 2000  # Safety limit to prevent unbounded memory use

    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    seen_category_ids: set[str] = set()
    seen_entity_ids: set[str] = set()

    # Category nodes
    for cat in categories:
        node_id = f"category:{cat.id}"
        if node_id not in seen_category_ids:
            seen_category_ids.add(node_id)
            nodes.append(GraphNode(
                id=node_id,
                label=cat.name,
                type="category",
                url=f"/articles?category={cat.id}",
                color=cat.color,
            ))

    # Article nodes + 属于 edges
    for article in articles:
        article_node_id = f"article:{article.id}"
        nodes.append(GraphNode(
            id=article_node_id,
            label=article.title,
            type="article",
            url=f"/articles/{article.id}",
        ))
        if article.category_id:
            cat_node_id = f"category:{article.category_id}"
            if cat_node_id in seen_category_ids:
                edges.append(GraphEdge(
                    source=article_node_id,
                    target=cat_node_id,
                    label="属于",
                ))

    # 实体节点以「名称+类型」为标识 → 节点 id = entity:{name}::{type}
    def ensure_entity_node(name: str, etype: str) -> str:
        nid = f"entity:{name}::{etype}"
        if nid not in seen_entity_ids:
            seen_entity_ids.add(nid)
            # 标签只显示名称，类型通过 entity_type 字段下发，前端按类型渲染图标
            nodes.append(GraphNode(
                id=nid,
                label=name,
                type="entity",
                url=f"/articles?search={name}",
                entity_type=etype or None,
            ))
        return nid

    # Entity nodes + article → entity 提及 edges
    for rec in mention_recs:
        name = rec.get("name") or ""
        if not name:
            continue
        nid = ensure_entity_node(name, rec.get("type") or "")
        edges.append(GraphEdge(
            source=f"article:{rec['aid']}",
            target=nid,
            label="提及",
        ))

    # Relation edges: entity → entity（Neo4j 中两端已带类型，无需旧格式解析）
    seen_rel_keys: set[tuple] = set()
    for rec in relate_recs:
        src = rec.get("source") or ""
        tgt = rec.get("target") or ""
        if not src or not tgt:
            continue
        key = (src, rec.get("source_type") or "", tgt, rec.get("target_type") or "", rec.get("label") or "关联")
        if key in seen_rel_keys:
            continue
        seen_rel_keys.add(key)
        src_id = ensure_entity_node(src, rec.get("source_type") or "")
        tgt_id = ensure_entity_node(tgt, rec.get("target_type") or "")
        edges.append(GraphEdge(source=src_id, target=tgt_id, label=rec.get("label") or "关联"))

    # Safety cap: if graph exceeds limit, return truncated data
    if len(nodes) > MAX_NODES:
        nodes = nodes[:MAX_NODES]
        edge_node_ids = {n.id for n in nodes}
        edges = [e for e in edges if e.source in edge_node_ids and e.target in edge_node_ids]

    return GraphResponse(nodes=nodes, edges=edges)
