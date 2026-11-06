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


@router.get("/expand", response_model=GraphResponse)
def expand_graph(node_id: str, depth: int = 1, db: Session = Depends(get_db)):
    """展开选中节点的 n 层关系：Neo4j 直查全量数据（n=1..5，默认 1）。

    /graph 受 2000 节点安全上限截断，此接口按需直查 Neo4j，返回邻域节点与边。
    目录节点在 Neo4j 中无数据 → 返回空图（前端提示无法展开）。
    """
    depth = max(1, min(int(depth), 5))
    node_id = node_id.strip()
    start_nid: str | None = None
    if node_id.startswith("article:"):
        start_id = node_id[len("article:"):]
        if not start_id:
            raise HTTPException(status_code=400, detail="无效的节点 id")
        start_nid = f"article:{start_id}"
        node_match = "MATCH (n0:Article {id: $start_id})"
        params = {"start_id": start_id}
    elif node_id.startswith("entity:"):
        rest = node_id[len("entity:"):]
        name, _, etype = rest.partition("::")
        if not name:
            raise HTTPException(status_code=400, detail="无效的节点 id")
        start_nid = f"entity:{name}::{etype}"
        node_match = "MATCH (n0:Entity {name: $name, type: $etype})"
        params = {"name": name, "etype": etype}
    elif node_id.startswith("category:"):
        # 目录数据在 SQLite，无 Neo4j 节点/边
        return GraphResponse(nodes=[], edges=[])
    else:
        raise HTTPException(status_code=400, detail="无效的节点 id")

    try:
        node_recs, rel_recs = neo4j_store.expand_graph_sync(node_match, params, depth)
    except Neo4jStoreError as e:
        logger.warning("Graph expand query failed: %s", e)
        raise HTTPException(status_code=503, detail="知识图谱服务（Neo4j）不可用，请稍后重试") from e

    # 文章节点标题来自 SQLite（与 /graph 一致）
    titles = {a.id: a.title for a in db.query(Article).all()}

    def _node_id_of(n) -> str | None:
        if "Article" in n.labels:
            return f"article:{n.get('id')}"
        if "Entity" in n.labels:
            return f"entity:{n.get('name') or ''}::{n.get('type') or ''}"
        return None

    nodes: list[GraphNode] = []
    seen_node_ids: set[str] = set()
    for rec in node_recs:
        n = rec["n"]
        nid = _node_id_of(n)
        if not nid or nid in seen_node_ids:
            continue
        seen_node_ids.add(nid)
        if "Article" in n.labels:
            aid = n.get("id")
            nodes.append(GraphNode(
                id=nid,
                label=titles.get(aid) or aid,
                type="article",
                url=f"/articles/{aid}",
            ))
        else:
            name = n.get("name") or ""
            etype = n.get("type") or ""
            nodes.append(GraphNode(
                id=nid,
                label=name,
                type="entity",
                url=f"/articles?search={name}",
                entity_type=etype or None,
            ))

    edges: list[GraphEdge] = []
    seen_edge_keys: set[tuple] = set()
    for rec in rel_recs:
        rel = rec["rel"]
        # 端点来自查询中显式返回的 startNode/endNode（rel.nodes 是未水合的壳）
        src = rec["s"]
        tgt = rec["e"]
        src_id = _node_id_of(src)
        tgt_id = _node_id_of(tgt)
        if not src_id or not tgt_id:
            continue
        label = "提及" if rel.type == "MENTIONS" else (rel.get("label") or "关联")
        key = (src_id, tgt_id, label)
        if key in seen_edge_keys:
            continue
        seen_edge_keys.add(key)
        edges.append(GraphEdge(source=src_id, target=tgt_id, label=label))

    # 节点与关系分两条查询、各有独立上限：截断后可能留下端点不在 nodes 中的边，
    # D3 会静默丢弃这类边。这里显式过滤，避免出现“关系数虚高但画不出来”。
    returned_node_ids = {n.id for n in nodes}
    edges = [e for e in edges if e.source in returned_node_ids and e.target in returned_node_ids]
    # 节点查询会走 RELATES（包括已删除墓碑），可能带出只经由删除边可达的节点；
    # 关系查询已过滤墓碑，这里把没有任何可见边的节点一并去掉（保留起点）。
    edge_node_ids = {e.source for e in edges} | {e.target for e in edges}
    nodes = [n for n in nodes if n.id == start_nid or n.id in edge_node_ids]

    return GraphResponse(nodes=nodes, edges=edges)


@router.get("", response_model=GraphResponse)
def get_graph(db: Session = Depends(get_db)):
    """知识图谱：文章/目录节点来自 SQLite（标题/颜色），实体/提及/关系边来自 Neo4j。

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
    # 去重：同一文章对同一实体的 MENTIONS 可能来自多个 source（body/comment:xx），
    # 图谱中只保留一条提及边
    seen_mention_keys: set[tuple] = set()
    for rec in mention_recs:
        name = rec.get("name") or ""
        if not name:
            continue
        nid = ensure_entity_node(name, rec.get("type") or "")
        key = (f"article:{rec['aid']}", nid)
        if key in seen_mention_keys:
            continue
        seen_mention_keys.add(key)
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
