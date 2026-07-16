import json
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.dependencies import get_db
from app.models import Article, Category

router = APIRouter(prefix="/api/graph", tags=["graph"])


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
    articles = db.query(Article).all()
    categories = db.query(Category).all()

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

            # Entity nodes
            for ent in ents:
                name = ent.get("name", "")
                if not name:
                    continue
                ent_node_id = f"entity:{name}"
                if ent_node_id not in seen_entity_ids:
                    seen_entity_ids.add(ent_node_id)
                    nodes.append(GraphNode(
                        id=ent_node_id,
                        label=name,
                        type="entity",
                        url=f"/articles?search={name}",
                    ))

                # Edge: article → entity
                edges.append(GraphEdge(
                    source=article_node_id,
                    target=ent_node_id,
                    label="提及",
                ))

            # Relation edges: entity → entity
            for rel in rels:
                src = rel.get("source", "")
                tgt = rel.get("target", "")
                lbl = rel.get("label", "关联")
                if not src or not tgt:
                    continue
                # Ensure nodes exist (lazy creation)
                for name in (src, tgt):
                    eid = f"entity:{name}"
                    if eid not in seen_entity_ids:
                        seen_entity_ids.add(eid)
                        nodes.append(GraphNode(
                            id=eid,
                            label=name,
                            type="entity",
                            url=f"/articles?search={name}",
                        ))
                edges.append(GraphEdge(
                    source=f"entity:{src}",
                    target=f"entity:{tgt}",
                    label=lbl,
                ))

    return GraphResponse(nodes=nodes, edges=edges)
