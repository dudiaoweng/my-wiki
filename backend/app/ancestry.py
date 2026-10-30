"""文章层级辅助：祖先链与子文章树组装。

独立的轻量模块（articles/upload 路由共用，避免循环导入）。
父链约束（同目录 + 无环）由写路径校验保证，此处按已存储数据组装，
对异常数据做防御性环检测。
"""
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models import Article


def _build_trees(db: Session, root_ids: list[str]) -> dict[str, list[dict]]:
    """一次多级查询构建 root_ids 各节点的完整子孙树。

    每层按 updated_at 降序；环防御（seen = 已入树节点）；整批 O(层数) 次
    查询，与 root 数量无关。根节点本身可以是其他根的后代（列表场景常见），
    因此 seen 不从 root_ids 预置——已入树的节点才跳过。
    """
    by_parent: dict[str, list[dict]] = {}
    frontier = list(root_ids)
    seen: set[str] = set()
    while frontier:
        rows = (
            db.query(
                Article.id, Article.title, Article.parent_id,
                Article.created_by, Article.updated_at,
            )
            .filter(Article.parent_id.in_(frontier))
            .order_by(desc(Article.updated_at))
            .all()
        )
        frontier = []
        for aid, atitle, apid, acreated, aupdated in rows:
            if aid in seen:  # 已入树（环防御 / 去重）
                continue
            seen.add(aid)
            by_parent.setdefault(apid, []).append({
                "id": aid,
                "title": atitle,
                "created_by": acreated,
                "updated_at": aupdated,
                "children": [],
            })
            frontier.append(aid)

    def build(pid: str, path: set[str] | None = None) -> list[dict]:
        if path is None:
            path = set()
        if pid in path:
            return []  # 环防御：数据异常时截断
        path.add(pid)
        nodes = by_parent.get(pid, [])
        for n in nodes:
            n["children"] = build(n["id"], path)
        return nodes

    return {rid: build(rid) for rid in root_ids}


def attach_ancestry(db: Session, article: Article) -> None:
    """把 ancestors（根→直接父）、children（直接子文章）与 children_tree
    （子文章递归树）挂到 ORM 临时属性。

    响应模型 ArticleResponse 通过 from_attributes 直读这些属性；
    未调用时默认空列表。
    """
    children = (
        db.query(Article)
        .filter(Article.parent_id == article.id)
        .order_by(desc(Article.updated_at))
        .all()
    )
    article.children = [{"id": c.id, "title": c.title} for c in children]
    article.children_tree = _build_trees(db, [article.id])[article.id]

    chain: list[dict] = []
    seen: set[str] = {article.id}
    cur = article
    while cur.parent_id and cur.parent_id not in seen:
        seen.add(cur.parent_id)
        parent = db.query(Article).filter(Article.id == cur.parent_id).first()
        if parent is None:
            break
        chain.append({"id": parent.id, "title": parent.title})
        cur = parent
    chain.reverse()
    article.ancestors = chain


def attach_children_trees(db: Session, articles: list[Article]) -> None:
    """为列表条目批量组装 children_tree（各文章全部子孙），整批 O(层数) 次查询。

    列表接口响应模型（ArticleListItem）默认空列表兜底，此函数仅覆盖有子文章的条目。
    """
    if not articles:
        return
    trees = _build_trees(db, [a.id for a in articles])
    for a in articles:
        a.children_tree = trees.get(a.id, [])
