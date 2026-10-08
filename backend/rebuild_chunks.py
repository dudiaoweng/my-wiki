"""一次性全量重建脚本：按当前 MAX_CHUNK_CHARS（512）重建全库分块。

流程（每篇文章）：
1. rebuild_article_chunks —— 按 512 规则重建正文分块（旧分块与旧 Qdrant 点删除）
2. 回填实体标签行 `[实体: 名称 (类型)]`（add_entity 同款逻辑，重新切分后丢失）
3. 回填实体附加信息行 `[实体信息: …]`（复用 _sync_entity_info_to_chunks）
4. embed_chunk_rows —— 重算嵌入并写入 Qdrant
评论分块经 _embed_comment_content 同样重建；最后 sync_qdrant 做差异清理。

注意：文章级实体在 Neo4j，不受重建影响；QA 来源卡片的实体 chips 由 Neo4j
实体名与 chunk_text 即时派生，无需按分块保存快照（v2.3 起）。

用法：在 backend/ 目录下执行
    .venv/Scripts/python.exe rebuild_chunks.py
"""

import asyncio
import logging
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

from app.database import init_db, SessionLocal  # noqa: E402
from app.models import Article, ArticleChunk, Comment  # noqa: E402
from app.routes.qa import rebuild_article_chunks, embed_chunk_rows, sync_qdrant  # noqa: E402
from app.routes.comments import _embed_comment_content  # noqa: E402
from app.routes.entities import _sync_entity_info_to_chunks  # noqa: E402
from app import vector_store  # noqa: E402
from app import neo4j_store  # noqa: E402
from app.neo4j_store import Neo4jStoreError  # noqa: E402


def _reapply_entity_tags(db, article: Article) -> None:
    """回填实体标签行：重新切分后 chunk_text 丢失了 [实体: …] 标签。
    实体列表来自 Neo4j（唯一存储）；不可用时跳过（警告）。"""
    try:
        ent_data = neo4j_store.get_entities_for_articles_sync([article.id]).get(article.id)
    except Neo4jStoreError as e:
        logging.warning("  [!] 实体查询失败（Neo4j 不可用），跳过标签回填: %s", e)
        return
    entities = ent_data.get("entities", []) if isinstance(ent_data, dict) else []
    if not entities:
        return

    chunks = (
        db.query(ArticleChunk)
        .filter(
            ArticleChunk.article_id == article.id,
            ~ArticleChunk.chunk_index.like("comment.%"),
        )
        .all()
    )
    for e in entities:
        name, etype = e.get("name", ""), e.get("type", "")
        if not name:
            continue
        tag_line = f"\n[实体: {name} ({etype})]"
        matched = False
        for ch in chunks:
            if name.lower() in ch.chunk_text.lower() and tag_line not in ch.chunk_text:
                ch.chunk_text = ch.chunk_text.rstrip() + tag_line
                matched = True
        if not matched and chunks:
            chunks[0].chunk_text = chunks[0].chunk_text.rstrip() + tag_line
    db.commit()


async def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        articles = db.query(Article).all()
        logging.info("开始重建 %d 篇文章的分块（512 规则）…", len(articles))
        for i, a in enumerate(articles, 1):
            await rebuild_article_chunks(db, a.id, a.content or "")
            _reapply_entity_tags(db, a)
            # 回填实体附加信息行（含评论分块）——实体名来自 Neo4j
            try:
                for name in neo4j_store.get_entity_names_mentioned_in_sync(a.id):
                    await _sync_entity_info_to_chunks(name, db)
            except Neo4jStoreError as e:
                logging.warning("  [!] 实体名查询失败（Neo4j 不可用），跳过信息行回填: %s", e)
            body = (
                db.query(ArticleChunk)
                .filter(
                    ArticleChunk.article_id == a.id,
                    ~ArticleChunk.chunk_index.like("comment.%"),
                )
                .all()
            )
            await embed_chunk_rows(db, body)
            logging.info("  [%d/%d] %s: %d 个分块", i, len(articles), a.title[:30], len(body))

        comments = db.query(Comment).all()
        logging.info("重建 %d 条评论的分块…", len(comments))
        for c in comments:
            await _embed_comment_content(c, db)

        db.close()

        logging.info("Qdrant 差异同步（孤儿清理 + 兜底补齐）…")
        await sync_qdrant()
        logging.info("✅ 全量重建完成")
    finally:
        try:
            db.close()
        except Exception:
            pass
        await vector_store.close()
        await neo4j_store.close()


if __name__ == "__main__":
    asyncio.run(main())
