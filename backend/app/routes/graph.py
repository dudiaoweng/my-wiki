import json
import time
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.dependencies import get_db
from app.models import Article, Category

router = APIRouter(prefix="/api/graph", tags=["graph"])

# Simple TTL cache to avoid full table scans on every graph request
_graph_cache: dict | None = None
_graph_cache_ts: float = 0.0
_GRAPH_CACHE_TTL: float = 30.0  # seconds


def invalidate_graph_cache() -> None:
    """Invalidate the graph cache (call after article mutations)."""
    global _graph_cache, _graph_cache_ts
    _graph_cache = None
    _graph_cache_ts = 0.0


class GraphNode(BaseModel):
    id: str
    label: str
    type: str  # "article" | "category" | "entity"
    url: str
    color: str | None = None


class GraphEdge(BaseModel):
    source: str
    target: str
    label: str


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


@router.get("", response_model=GraphResponse)
def get_graph(db: Session = Depends(get_db)):
    global _graph_cache, _graph_cache_ts
    now = time.monotonic()
    if _graph_cache is not None and (now - _graph_cache_ts) < _GRAPH_CACHE_TTL:
        return GraphResponse(**_graph_cache)

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

    # Article nodes + edges
    for article in articles:
        article_node_id = f"article:{article.id}"
        nodes.append(GraphNode(
            id=article_node_id,
            label=article.title,
            type="article",
            url=f"/articles/{article.id}",
        ))

        # Edge: article → category
        if article.category_id:
            cat_node_id = f"category:{article.category_id}"
            if cat_node_id in seen_category_ids:
                edges.append(GraphEdge(
                    source=article_node_id,
                    target=cat_node_id,
                    label="属于",
                ))

        # Entity nodes + edges from LLM extraction
        if article.entities:
            try:
                ent_data: dict = json.loads(article.entities)
            except (json.JSONDecodeError, TypeError):
                ent_data = {}

            ents = ent_data.get("entities", [])
            rels = ent_data.get("relations", [])

            # 实体以「名称+类型」为标识 → 节点 id = entity:{name}::{type}
            # 用于解析旧格式关系（无类型）：name → 该文章中出现过的类型集合
            name_types: dict[str, set[str]] = {}
            for ent in ents:
                name = ent.get("name", "")
                if name:
                    name_types.setdefault(name, set()).add(ent.get("type") or "")

            def ensure_entity_node(name: str, etype: str) -> str:
                nid = f"entity:{name}::{etype}"
                if nid not in seen_entity_ids:
                    seen_entity_ids.add(nid)
                    label = f"{name}（{etype}）" if etype else name
                    nodes.append(GraphNode(
                        id=nid,
                        label=label,
                        type="entity",
                        url=f"/articles?search={name}",
                    ))
                return nid

            # Entity nodes + "article → entity" edges
            for ent in ents:
                name = ent.get("name", "")
                if not name:
                    continue
                nid = ensure_entity_node(name, ent.get("type") or "")
                edges.append(GraphEdge(
                    source=article_node_id,
                    target=nid,
                    label="提及",
                ))

            # Relation edges: entity → entity
            for rel in rels:
                src = rel.get("source", "")
                tgt = rel.get("target", "")
                lbl = rel.get("label", "关联")
                if not src or not tgt:
                    continue
                src_type = rel.get("source_type") or ""
                tgt_type = rel.get("target_type") or ""

                # 新格式带类型 → 精确指向该 (name, type) 节点；
                # 旧格式无类型 → 按名称解析：唯一类型直接指向，多类型分别连边，无记录建无类型节点
                if src_type:
                    src_ids = [ensure_entity_node(src, src_type)]
                else:
                    src_ids = [ensure_entity_node(src, t) for t in sorted(name_types.get(src) or {""})]
                if tgt_type:
                    tgt_ids = [ensure_entity_node(tgt, tgt_type)]
                else:
                    tgt_ids = [ensure_entity_node(tgt, t) for t in sorted(name_types.get(tgt) or {""})]

                for sid in src_ids:
                    for tid in tgt_ids:
                        edges.append(GraphEdge(source=sid, target=tid, label=lbl))

    # Safety cap: if graph exceeds limit, return truncated data
    if len(nodes) > MAX_NODES:
        nodes = nodes[:MAX_NODES]
        edge_node_ids = {n.id for n in nodes}
        edges = [e for e in edges if e.source in edge_node_ids and e.target in edge_node_ids]

    result = GraphResponse(nodes=nodes, edges=edges)
    _graph_cache = result.model_dump()
    _graph_cache_ts = now
    return result
