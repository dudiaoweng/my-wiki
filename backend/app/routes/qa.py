import asyncio
import html
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload
from app.dependencies import get_db
from app.models import Article, ArticleChunk, Comment, EntityInfo
from app import vector_store
from app import neo4j_store
from app.neo4j_store import Neo4jStoreError
from app.config import (
    LLM_API_KEY, LLM_API_BASE, LLM_MODEL,
    VISION_API_KEY, VISION_API_BASE, VISION_MODEL,
    ASR_API_KEY, ASR_API_BASE, ASR_MODEL,
    EMBEDDING_API_KEY, EMBEDDING_API_BASE, EMBEDDING_MODEL,
    QA_TEMPERATURE, QA_MIN_RELEVANCE, MAX_CHUNK_CHARS, CHUNK_OVERLAP,
    LLM_TIMEOUT, VISION_TIMEOUT, ASR_TIMEOUT, EMBEDDING_TIMEOUT, FFMPEG_TIMEOUT,
    UPLOAD_DIR as UPLOAD_DIR_STR,
)
from app.utils import find_ffmpeg, read_upload_limited
from app.prompts import (
    QA_VIDEO_DESCRIPTION,
    QA_WITH_KB_INTRO,
    QA_WITH_KB_INSTRUCTIONS,
    QA_WITH_KB_IMAGES,
    QA_WITH_KB_FALLBACK,
    QA_CLOSING,
    QA_NO_KB,
)

logger = logging.getLogger(__name__)
# Ensure custom log messages are visible alongside uvicorn access logs
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

router = APIRouter(prefix="/api/qa", tags=["qa"])

# ─── Config ────────────────────────────────────────

UPLOAD_DIR = Path(UPLOAD_DIR_STR)

# ─── Schemas ───────────────────────────────────────

class QAMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)

class FileContext(BaseModel):
    filename: str
    content: str           # text content, or base64 data for images
    content_type: str = "text/plain"  # MIME type
    is_image: bool = False # True → pass as vision content to LLM

class QARequest(BaseModel):
    question: str = Field(max_length=2000)
    history: list[QAMessage] = Field(default_factory=list, max_length=50)
    file_contexts: list[FileContext] = Field(default_factory=list, max_length=5)
    kb_enabled: bool = True  # False → skip knowledge base, use LLM directly

class QASource(BaseModel):
    article_id: str
    title: str
    excerpt: str
    relevance: float
    entities: list[dict] = []  # 命中块相关的实体 [{name, type}]（Neo4j 实体名与块文本匹配派生）

class QAResponse(BaseModel):
    answer: str
    sources: list[QASource]


# ─── Embedding helpers ─────────────────────────────

class EmbeddingError(Exception):
    """嵌入模型调用失败（无法获得查询/分块向量）。"""


# MAX_CHUNK_CHARS 从 app.config 导入（.env 可配置，默认 512）

def chunk_article(content: str) -> list[str]:
    """Split article into chunks by markdown headings, then by size.

    HTML 注释（doc-attachment / attachments-order 附件标记）是元数据，
    分块前移除，避免产生无意义噪声块。
    """
    content = re.sub(r'<!--.*?-->', '', content)
    # Split by headings but keep the heading text with its content
    sections = re.split(r'\n(?=#{1,3}\s)', content)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue
        # Split long sections into sub-chunks（重叠只作用于段内，不跨标题边界）
        chunks.extend(_split_long_text(section, MAX_CHUNK_CHARS, CHUNK_OVERLAP))

    # Ensure we have at least one chunk
    if not chunks:
        chunks = [content[:MAX_CHUNK_CHARS]]

    return chunks


def _split_long_text(text: str, max_chars: int, overlap: int = 0) -> list[str]:
    """Split text into chunks of at most max_chars, trying to break at natural boundaries.

    overlap > 0 时相邻分块共享尾部字符（滑动窗口语义）：基础切分按
    max_chars - overlap 进行，块 i 开头前置块 i-1 的尾部 overlap 字符，
    保证块总长仍 ≤ max_chars。
    """
    overlap = max(0, min(overlap, max_chars // 2))  # 防参数滥用
    if len(text) <= max_chars:
        return [text]

    base_limit = max_chars - overlap - 1  # 预留重叠空间（-1 为前置重叠时的 '\n' 分隔符）

    result: list[str] = []
    # First try splitting by double newlines (paragraphs)
    paragraphs = text.split('\n\n')
    current = ''
    for para in paragraphs:
        if len(current) + len(para) + 2 <= base_limit:
            current = (current + '\n\n' + para).strip()
        else:
            if current:
                result.append(current)
            # If a single paragraph is still too long, split by single newlines
            if len(para) > base_limit:
                lines = para.split('\n')
                sub = ''
                for line in lines:
                    if len(sub) + len(line) + 1 <= base_limit:
                        sub = (sub + '\n' + line).strip()
                    else:
                        if sub:
                            result.append(sub)
                        # If a single line is too long, hard split by char count
                        if len(line) > base_limit:
                            for i in range(0, len(line), base_limit):
                                result.append(line[i:i + base_limit])
                        else:
                            sub = line
                if sub:
                    result.append(sub)
            else:
                current = para
    if current:
        result.append(current)

    # 重叠后处理：块 i 开头前置块 i-1 的尾部 overlap 字符
    if overlap and len(result) > 1:
        overlapped = [result[0]]
        for prev, cur in zip(result, result[1:]):
            overlapped.append((prev[-overlap:] + '\n' + cur).strip())
        result = overlapped

    return result


async def get_embedding(text: str) -> list[float]:
    """Get embedding vector from the configured API (OpenAI-compatible /v1/embeddings)."""
    import httpx

    # Truncate to avoid exceeding model token limits
    text = text[:2000]

    async with httpx.AsyncClient(timeout=EMBEDDING_TIMEOUT) as client:
        resp = await client.post(
            f"{EMBEDDING_API_BASE.rstrip('/')}/embeddings",
            headers={
                "Authorization": f"Bearer {EMBEDDING_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": EMBEDDING_MODEL,
                "input": text,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        # llama.cpp b10775 路由版返回原生格式 [{"index":0,"embedding":[[...]]}]，
        # 与 OpenAI 的 {"data":[{"embedding":[...]}]} 不同，两种都兼容
        if isinstance(data, list):
            emb = data[0]["embedding"]
            if emb and isinstance(emb[0], list):
                emb = emb[0]  # 单输入时向量多套了一层
            return emb
        return data["data"][0]["embedding"]


# Track last-known article count to skip repeated ensure_embeddings scans
_embedded_article_count: int | None = None
_embedding_lock = asyncio.Lock()


async def ensure_embeddings(db: Session, force: bool = False):
    """Compute embeddings for articles missing them (incremental, not full table scan)."""
    global _embedded_article_count

    async with _embedding_lock:
        if not force and _embedded_article_count is not None:
            total = db.query(Article).count()
            if total == _embedded_article_count:
                return  # All articles already embedded

        if not force:
            from sqlalchemy import exists, select
            has_chunks = exists().where(ArticleChunk.article_id == Article.id)
            articles = db.query(Article).filter(~has_chunks).all()
        else:
            articles = db.query(Article).all()

        for article in articles:
            # For force mode: delete old chunks first（先清 Qdrant 点再删行）
            if force:
                await vector_store.delete_by_article(article.id)
                db.query(ArticleChunk).filter(ArticleChunk.article_id == article.id).delete()

            # 本次循环内计算成功的 (chunk_row, vector) 对——向量只写 Qdrant，不落 SQLite
            embedded_pairs: list[tuple[ArticleChunk, list[float]]] = []

            # Chunk and embed article content
            chunks = chunk_article(article.content)
            for i, chunk_text in enumerate(chunks):
                row = ArticleChunk(
                    article_id=article.id,
                    chunk_index=str(i),
                    chunk_text=chunk_text,
                )
                db.add(row)
                try:
                    embedded_pairs.append((row, await get_embedding(chunk_text)))
                except Exception:
                    logger.warning("Failed to embed chunk %s of article %s", i, article.id, exc_info=True)

            # Chunk and embed comments
            comments = db.query(Comment).filter(
                Comment.article_id == article.id,
                Comment.content.isnot(None),
                Comment.content != "",
            ).all()
            for c in comments:
                # Strip HTML tags from comment content for clean embedding
                clean_comment = re.sub(r'<[^>]*>', '', c.content or '')
                clean_comment = re.sub(r'<!--.*?-->', '', clean_comment)
                clean_comment = re.sub(r'\s+', ' ', clean_comment).strip()
                if not clean_comment:
                    continue
                comment_chunks = chunk_article(clean_comment)
                for i, chunk_text in enumerate(comment_chunks):
                    idx = f"comment.{c.id[:8]}.{i}"
                    row = ArticleChunk(
                        article_id=article.id,
                        chunk_index=idx,
                        chunk_text=f"[评论] {chunk_text}",
                    )
                    db.add(row)
                    try:
                        embedded_pairs.append((row, await get_embedding(chunk_text)))
                    except Exception:
                        logger.warning(
                            "Failed to embed comment chunk %s of article %s", idx, article.id, exc_info=True,
                        )

            db.commit()

            # 同步写入 Qdrant（best-effort；失败的分块无向量，启动同步会重算补上）
            if embedded_pairs:
                await vector_store.upsert_chunks([
                    vector_store.make_point(
                        r.id, vec, r.article_id, r.chunk_index, r.chunk_text,
                    )
                    for r, vec in embedded_pairs
                ])

        # Update cache
        _embedded_article_count = db.query(Article).count()


# ─── 启动懒迁移：SQLite → Qdrant ──────────────────

_sync_started = False
_QDRANT_SYNC_RETRIES = 5
_QDRANT_SYNC_RETRY_DELAY = 30.0  # 秒


def _start_qdrant_sync() -> None:
    """lifespan 调用：fire-and-forget，幂等（run.py 双 uvicorn 共用 app → lifespan 跑两次）。"""
    global _sync_started
    if _sync_started:
        return
    _sync_started = True
    asyncio.get_running_loop().create_task(sync_qdrant())


async def sync_qdrant() -> None:
    """启动时同步 SQLite 分块 → Qdrant（Qdrant 是向量的唯一存储）。

    Qdrant 缺失的分块重新计算嵌入并 upsert；Qdrant 多出的点（DB 已删）
    为孤儿 → 清理。Qdrant 连不上时最多重试数次后放弃——服务器照常启动，
    问答返回 Qdrant 错误文案；下次启动重新同步。幂等：中断后重启再次执行
    同一差集（已 upsert 的分块不重算）。
    """
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        # 1. 集合就绪（维度按 QDRANT_VECTOR_SIZE；与嵌入模型实际输出不符时，
        #    以首个新向量的维度自动纠正重建）
        col_dim: int | None = None
        for attempt in range(_QDRANT_SYNC_RETRIES):
            try:
                col_dim = await vector_store.ensure_collection(None)
                break
            except vector_store.VectorStoreError:
                logger.warning(
                    "Qdrant 连接失败（第 %d/%d 次），%ds 后重试…",
                    attempt + 1, _QDRANT_SYNC_RETRIES, _QDRANT_SYNC_RETRY_DELAY,
                )
                await asyncio.sleep(_QDRANT_SYNC_RETRY_DELAY)
        if col_dim is None:
            logger.error("Qdrant 启动同步放弃：服务不可用（问答将返回错误提示）")
            return

        # 2. 无分块文章建分块（含嵌入+upsert；勿持 _embedding_lock 调用——Lock 不可重入）
        await ensure_embeddings(db)

        # 3. 差异同步：DB 有而 Qdrant 无的分块 → 重算嵌入并 upsert
        #    （Qdrant 卷丢失/重建集合时，本步自动全量重建）
        try:
            have = await vector_store.list_existing_ids()
        except vector_store.VectorStoreError as e:
            logger.error("Qdrant 差异同步失败：%s", e)
            return

        db_ids = {r[0] for r in db.query(ArticleChunk.id).all()}
        missing_ids = sorted(db_ids - have)

        async with _embedding_lock:
            upserted = 0
            dim_corrected = False  # 每次同步最多纠正一次集合维度
            # 分块批量处理，避免 SQLite IN 子句超出 999 绑定变量上限
            start = 0
            while start < len(missing_ids):
                batch = missing_ids[start:start + 500]
                points = []
                restart = False
                for ch in db.query(ArticleChunk).filter(ArticleChunk.id.in_(batch)).all():
                    try:
                        vec = await get_embedding(ch.chunk_text)
                    except Exception:
                        logger.warning(
                            "Sync embed failed for chunk %s of article %s",
                            ch.chunk_index, ch.article_id, exc_info=True,
                        )
                        continue
                    if len(vec) != col_dim:
                        if not dim_corrected:
                            # 嵌入模型实际维度与配置不符 → 以实际维度重建集合
                            logger.warning(
                                "嵌入模型输出维度 %d 与集合维度 %d 不符，重建集合",
                                len(vec), col_dim,
                            )
                            col_dim = await vector_store.ensure_collection(len(vec))
                            have = await vector_store.list_existing_ids()
                            # 集合已重建为空：缺失集扩大为全部 DB 分块，从头重跑
                            missing_ids = sorted(db_ids - have)
                            restart = True
                            dim_corrected = True
                        else:
                            logger.error(
                                "嵌入维度仍不符（%d != %d），跳过 chunk %s",
                                len(vec), col_dim, ch.id,
                            )
                        break
                    points.append(vector_store.make_point(
                        ch.id, vec, ch.article_id, ch.chunk_index, ch.chunk_text,
                    ))
                if restart:
                    start = 0
                    continue
                if points:
                    await vector_store.upsert_chunks(points)
                    upserted += len(points)
                start += 500

        # 4. 孤儿清理：Qdrant 有而 DB 无的点
        orphans = have - db_ids
        if orphans:
            await vector_store.delete_points(list(orphans))

        logger.info(
            "Qdrant sync complete: %d upserted, %d orphans removed",
            upserted, len(orphans),
        )
    except Exception:
        logger.warning("Qdrant 启动同步异常", exc_info=True)
    finally:
        db.close()


# 候选检索数：去重后取 top_k；约为 top_k 的 10 倍以容忍同文章多块命中
SEARCH_LIMIT = 50


async def semantic_search(db: Session, question: str, top_k: int = 5) -> list[tuple[float, Article, ArticleChunk | None]]:
    """
    Semantic search via Qdrant.

    Returns list of (score, article, chunk) — chunk 为命中的分块行。
    检索路径严格依赖 Qdrant：失败抛 VectorStoreError / EmbeddingError，由调用方降级。
    """
    # Ensure all articles have embeddings（新文章首次问答时懒建分块并写入 Qdrant）
    await ensure_embeddings(db)

    # Get question embedding
    try:
        q_embedding = await get_embedding(question)
    except Exception as e:
        raise EmbeddingError(f"嵌入模型调用失败：{e}") from e

    # Qdrant 检索（Cosine 距离下 score 即相似度，越大越相关）
    hits = await vector_store.search(q_embedding, limit=SEARCH_LIMIT)
    if not hits:
        return []

    # 按 point id 回查分块行：跳过 DB 中已删除的陈旧点；每文章取最高分块去重
    ids = [h.id for h in hits]
    score_by_id = {h.id: h.score for h in hits}
    rows = (
        db.query(ArticleChunk)
        .options(joinedload(ArticleChunk.article))
        .filter(ArticleChunk.id.in_(ids))
        .all()
    )
    rows_by_id = {r.id: r for r in rows}

    results: list[tuple[float, Article, ArticleChunk]] = []
    seen_articles: set[str] = set()
    for pid in ids:
        row = rows_by_id.get(pid)
        if not row or not row.article:
            continue  # 陈旧点兜底：文章/分块已删 → 跳过（下次启动孤儿清理清除）
        if row.article.id in seen_articles:
            continue
        seen_articles.add(row.article.id)
        results.append((score_by_id[pid], row.article, row))
        if len(results) >= top_k:
            break

    return results


def get_excerpt(content: str, max_len: int = 200) -> str:
    clean = re.sub(r'[#*`>\[\]()!\-|]', ' ', content)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:max_len] + ('…' if len(clean) > max_len else '')


# ─── 向量分块共享助手（提取与 Q&A 检索共用同一套切分） ───

async def rebuild_article_chunks(db: Session, article_id: str, content: str) -> list[ArticleChunk]:
    """删除文章正文分块后按最终内容重建（embedding 由调用方或 ensure_embeddings 补充）。

    async：删除 DB 行前收集旧 id，commit 后同步清理 Qdrant 点（best-effort）。
    """
    old_ids = [
        r[0] for r in db.query(ArticleChunk.id).filter(
            ArticleChunk.article_id == article_id,
            ~ArticleChunk.chunk_index.like("comment.%"),
        ).all()
    ]
    db.query(ArticleChunk).filter(
        ArticleChunk.article_id == article_id,
        ~ArticleChunk.chunk_index.like("comment.%"),
    ).delete()
    rows: list[ArticleChunk] = []
    for i, text in enumerate(chunk_article(content)):
        rows.append(ArticleChunk(
            article_id=article_id, chunk_index=str(i), chunk_text=text,
        ))
    db.add_all(rows)
    db.commit()
    if old_ids:
        await vector_store.delete_points(old_ids)
    return rows


async def embed_chunk_rows(db: Session, chunks: list[ArticleChunk]) -> None:
    """对分块逐条计算嵌入并写入 Qdrant（向量只存 Qdrant，不落 SQLite）。

    best-effort：嵌入失败的分块没有向量，启动同步会重算补上。
    """
    points = []
    for ch in chunks:
        try:
            vec = await get_embedding(ch.chunk_text)
            points.append(vector_store.make_point(
                ch.id, vec, ch.article_id, ch.chunk_index, ch.chunk_text,
            ))
        except Exception:
            logger.warning(
                "Failed to embed chunk %s of article %s", ch.chunk_index, ch.article_id, exc_info=True,
            )
    db.commit()  # 兜底提交分块行（多数调用方已提交）
    if points:
        await vector_store.upsert_chunks(points)


def get_article_chunks(db: Session, article_id: str) -> list[ArticleChunk]:
    """按序返回文章正文分块行（不含评论分块）——提取与检索共用同一套切分。"""
    rows = db.query(ArticleChunk).filter(
        ArticleChunk.article_id == article_id,
        ~ArticleChunk.chunk_index.like("comment.%"),
    ).all()
    rows.sort(key=lambda c: int(c.chunk_index) if c.chunk_index.isdigit() else 10 ** 9)
    return rows


def get_comment_chunks(db: Session, comment_id: str) -> list[ArticleChunk]:
    """按序返回评论分块行（chunk_text 带 [评论] 前缀，喂给提取时需剥离）。"""
    rows = db.query(ArticleChunk).filter(
        ArticleChunk.chunk_index.like(f"comment.{comment_id[:8]}.%"),
    ).all()
    rows.sort(key=lambda c: int(c.chunk_index.rsplit(".", 1)[-1]) if c.chunk_index.rsplit(".", 1)[-1].isdigit() else 10 ** 9)
    return rows


def _entities_in_chunk(chunk_text: str, name_types: dict[str, str]) -> list[dict]:
    """命中块的实体 chips：Neo4j 实体名与块文本（含 [实体: …] 标签行）子串匹配派生。

    v2.3 前来自块级实体标注（article_chunks.entities 快照——改名不传播、重新分块即丢）；
    现从 Neo4j 即时派生，永远与图谱一致。与实体直召同规则：实体名长度 ≥ 2 防单字噪声。
    """
    if not chunk_text or not name_types:
        return []
    hits = sorted(n for n in name_types if len(n) >= 2 and n in chunk_text)
    return [{"name": n, "type": name_types[n]} for n in hits]


# ─── File parsing for Q&A context ──────────────────

# Reuse upload.py parsing functions
from app.routes.upload import (
    parse_text_from_bytes, parse_docx, parse_xlsx, parse_pptx, parse_pdf,
    TEXT_EXTENSIONS, WORD_EXTENSIONS, EXCEL_EXTENSIONS, PPT_EXTENSIONS,
    PDF_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
)

# MIME map for image types
IMAGE_MIME_MAP = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
}

# Re-parse helper for QA: extracts text or encodes images for LLM context
# ─── Audio / Video Q&A helpers ──────────────────────


async def parse_audio_for_qa(content_bytes: bytes, filename: str) -> str:
    """Transcribe audio for Q&A context. Returns transcribed text or error message."""
    import io
    import subprocess
    import wave
    import audioop
    import httpx

    ext = Path(filename).suffix.lower()

    # ── Convert to mono 16kHz WAV ──
    if ext == '.wav':
        try:
            with wave.open(io.BytesIO(content_bytes), 'rb') as wf:
                nchannels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                framerate = wf.getframerate()
                frames = wf.readframes(wf.getnframes())
            if nchannels > 1:
                frames = audioop.tomono(frames, sampwidth, 1.0, 1.0)
            if framerate != 16000:
                frames = audioop.ratecv(frames, sampwidth, 1, framerate, 16000, None)[0]
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(sampwidth)
                wf.setframerate(16000)
                wf.writeframes(frames)
            mono_bytes = buf.getvalue()
        except Exception as e:
            return f"[音频转换失败：{e}]"
    else:
        ffmpeg_path = find_ffmpeg()
        if not ffmpeg_path:
            return "[音频识别失败：需要安装 ffmpeg 来转换非 WAV 格式的音频。]"
        try:
            result = subprocess.run(
                [ffmpeg_path, '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'],
                input=content_bytes, capture_output=True, timeout=FFMPEG_TIMEOUT,
            )
            if result.returncode != 0:
                return f"[音频转换失败：ffmpeg 无法解码此文件]"
            mono_bytes = result.stdout
        except Exception as e:
            return f"[音频转换失败：{e}]"

    # ── Call ASR ──
    if not ASR_API_KEY:
        return "[音频识别失败：未配置语音识别模型 API。]"
    try:
        async with httpx.AsyncClient(timeout=ASR_TIMEOUT) as client:
            resp = await client.post(
                f"{ASR_API_BASE.rstrip('/').replace('/chat/completions', '')}/audio/transcriptions",
                headers={"Authorization": f"Bearer {ASR_API_KEY}"},
                files={"file": ("audio.wav", mono_bytes, "audio/wav")},
                data={"model": ASR_MODEL},
            )
            if resp.status_code == 200:
                data = resp.json()
                text = data.get("text", "").strip()
                if text:
                    return f"[音频转录：{filename}]\n{text}"
                return "[音频识别结果为空。]"
            err_detail = resp.text[:300]
            return f"[音频识别失败（HTTP {resp.status_code}）：{err_detail}]"
    except Exception as e:
        return f"[音频识别异常：{e}]"


from contextlib import contextmanager


@contextmanager
def _temp_video_file(content_bytes: bytes, suffix: str):
    """Write video bytes to a named temp file for OpenCV, guaranteeing cleanup."""
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(content_bytes)
        tmp.close()
        yield tmp.name
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


async def parse_video_for_qa(content_bytes: bytes, filename: str) -> str:
    """Extract frames from video and describe for Q&A context.
    Temp file is cleaned up immediately after frame extraction, before the slow API call."""
    import base64
    import cv2
    import httpx

    if not VISION_API_KEY:
        return "[视频识别失败：未配置视觉模型 API。]"

    ext = Path(filename).suffix
    name_no_ext = Path(filename).stem
    frames_b64: list[str] = []
    duration = 0

    # ── Phase 1: Write temp file → extract frames → delete temp file ──
    with _temp_video_file(content_bytes, ext) as video_path:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return "[视频识别失败：无法打开视频文件。]"

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        duration = total_frames / fps if fps > 0 else 0

        # Extract up to 4 frames
        positions = [0, 0.3, 0.6, 0.85]
        for pos in positions:
            frame_idx = int(total_frames * pos)
            if frame_idx >= total_frames:
                frame_idx = total_frames - 1
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if ret and frame is not None:
                h, w = frame.shape[:2]
                max_side = max(h, w)
                if max_side > 1024:
                    scale = 1024 / max_side
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
                _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                frames_b64.append(base64.b64encode(buf).decode('utf-8'))
        cap.release()
    # Temp file is now deleted — API call below doesn't need it

    if not frames_b64:
        return "[视频识别失败：无法从视频中提取画面。]"

    # ── Phase 2: Call vision model ──
    user_content: list[dict] = [
        {
            "type": "text",
            "text": (
                QA_VIDEO_DESCRIPTION.format(
                    name=name_no_ext, frame_count=len(frames_b64), duration=duration,
                ),
            ),
        }
    ]
    for b64 in frames_b64:
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    try:
        async with httpx.AsyncClient(timeout=VISION_TIMEOUT) as client:
            resp = await client.post(
                f"{VISION_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {VISION_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": VISION_MODEL,
                    "messages": [{"role": "user", "content": user_content}],
                    "max_tokens": 500,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                desc = data["choices"][0]["message"]["content"].strip()
                return f"[视频描述：{filename}]\n{desc}"
            return f"[视频识别失败（HTTP {resp.status_code}）：{resp.text[:200]}]"
    except Exception as e:
        return f"[视频识别异常：{e}]"


async def parse_file_for_qa(content_bytes: bytes, file_path: str, content_type: str) -> dict:
    """Parse a file for Q&A context.
    Returns {"content": str, "content_type": str, "is_image": bool}.
    Images are encoded as base64 for direct vision-model use; text files are extracted locally.
    No LLM calls are made in this function."""
    import base64
    ext = Path(file_path).suffix.lower()
    filename = Path(file_path).name

    if ext in IMAGE_EXTENSIONS:
        mime = IMAGE_MIME_MAP.get(ext, 'image/png')
        b64 = base64.b64encode(content_bytes).decode('utf-8')
        return {"content": b64, "content_type": mime, "is_image": True, "filename": filename}
    elif ext in TEXT_EXTENSIONS:
        text = parse_text_from_bytes(content_bytes)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in WORD_EXTENSIONS:
        text = await asyncio.to_thread(parse_docx, file_path)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in EXCEL_EXTENSIONS and ext != '.csv':
        text = await asyncio.to_thread(parse_xlsx, file_path)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in PPT_EXTENSIONS:
        text = await asyncio.to_thread(parse_pptx, file_path)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in PDF_EXTENSIONS:
        text = await asyncio.to_thread(parse_pdf, file_path)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in AUDIO_EXTENSIONS:
        text = await parse_audio_for_qa(content_bytes, filename)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    elif ext in VIDEO_EXTENSIONS:
        text = await parse_video_for_qa(content_bytes, filename)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}
    else:
        text = parse_text_from_bytes(content_bytes)
        return {"content": text, "content_type": "text/plain", "is_image": False, "filename": filename}


# Extensions that need a file path on disk (parsers that can't work from bytes)
EXTENSIONS_NEEDING_DISK = WORD_EXTENSIONS | EXCEL_EXTENSIONS | PPT_EXTENSIONS | PDF_EXTENSIONS

# In-memory store for async file processing status
_qa_file_store: dict[str, dict] = {}


def _extract_video_thumbnail(video_path: str, thumb_path: str) -> bool:
    """Extract the first frame from a video and save as a JPEG thumbnail.
    Returns True on success, False if the frame could not be extracted."""
    import cv2
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            logger.warning("Video thumbnail: OpenCV cannot open %s", video_path)
            return False
        ret, frame = cap.read()
        cap.release()
        if not ret or frame is None:
            logger.warning("Video thumbnail: failed to read first frame from %s", video_path)
            return False
        # Resize to a small thumbnail (max 256px on longest side)
        h, w = frame.shape[:2]
        max_side = max(h, w)
        if max_side > 256:
            scale = 256 / max_side
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        cv2.imwrite(thumb_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        logger.info("Video thumbnail saved: %s (%dx%d)", thumb_path, w, h)
        return True
    except Exception as e:
        logger.warning("Video thumbnail extraction failed for %s: %s", video_path, e)
        return False


async def _process_qa_file(file_id: str, storage_path: str, filename: str, content_type: str):
    """Background task: parse file content and update the in-memory store."""
    logger.info("QA file background processing started: %s (id=%s)", filename, file_id)
    storage_name = Path(storage_path).name
    thumb_url = ""

    # For video files, extract a thumbnail for the UI card.
    # Check both MIME type (may be empty from browser) and file extension.
    ext = Path(filename).suffix.lower()
    is_video = content_type.startswith("video/") or ext in VIDEO_EXTENSIONS
    if is_video:
        thumb_name = storage_name + ".thumb.jpg"
        thumb_path = str(Path(storage_path).parent / thumb_name)
        if _extract_video_thumbnail(storage_path, thumb_path):
            thumb_url = f"/api/media/{thumb_name}"
            logger.info("Video thumbnail extracted: %s", thumb_name)

    try:
        # Read bytes from disk
        with open(storage_path, "rb") as f:
            content_bytes = f.read()

        result = await parse_file_for_qa(content_bytes, storage_path, content_type)

        # result["content"] may contain the storage filename in description
        # strings (e.g. "[音频转录：_qa_xxx_name.mp3]").  Patch it back to the
        # original filename for display.
        content = result["content"]
        if storage_name != filename:
            content = content.replace(storage_name, filename)

        # Preserve the original MIME type from upload (parse_file_for_qa always
        # returns "text/plain" for audio/video, which would break frontend detection).
        final_content_type = content_type or result["content_type"]
        _qa_file_store[file_id].update({
            "status": "done",
            "content": content,
            "content_type": final_content_type,
            "is_image": result["is_image"],
            "thumb_url": thumb_url,
        })
        logger.info("QA file background processing complete: %s (id=%s)", filename, file_id)
    except Exception as e:
        logger.exception("QA file background processing failed: %s (id=%s)", filename, file_id)
        _qa_file_store[file_id].update({
            "status": "error",
            "error": str(e),
            "thumb_url": thumb_url,
        })
    finally:
        # Keep the file on disk so the frontend can serve it for
        # thumbnail / preview via /api/media/{storage_name}.
        # Stale files are cleaned up on next server start (see main.py).
        pass


@router.post("/parse-file")
async def parse_file_for_question(file: UploadFile = File(...)):
    """Upload a file for Q&A context. Returns immediately with a file_id;
    processing happens asynchronously in the background.  Poll /file-status/{file_id}
    to get the result when ready."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    content_bytes = await read_upload_limited(file, 50 * 1024 * 1024)

    # Always save to disk — background task needs the file
    file_id = uuid.uuid4().hex
    safe_fname = re.sub(r'[^\w.\-]', '_', file.filename)
    storage_name = f"_qa_{file_id}_{safe_fname}"
    storage_path = UPLOAD_DIR / storage_name
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with open(storage_path, "wb") as f:
        f.write(content_bytes)

    is_image = ext in IMAGE_EXTENSIONS

    # Register in the in-memory store
    _qa_file_store[file_id] = {
        "status": "processing",
        "filename": file.filename,
        "content_type": file.content_type or "",
        "is_image": is_image,
        "content": None,
        "error": None,
        "storage_name": storage_name,
    }

    # Schedule background processing as an asyncio task (runs in the same
    # event loop, after the response has been sent — no thread-pool overhead).
    asyncio.create_task(
        _process_qa_file(file_id, str(storage_path), file.filename, file.content_type or "")
    )
    logger.info("QA file upload accepted: %s (id=%s), background task scheduled", file.filename, file_id)

    return {
        "file_id": file_id,
        "filename": file.filename,
        "content_type": file.content_type or "",
        "is_image": is_image,
        "status": "processing",
        "media_url": f"/api/media/{storage_name}",
    }


@router.get("/file-status/{file_id}")
async def get_file_status(file_id: str):
    """Poll the processing status of an uploaded Q&A file."""
    info = _qa_file_store.get(file_id)
    if not info:
        raise HTTPException(status_code=404, detail="File not found")
    storage_name = info.get("storage_name", "")
    return {
        "file_id": file_id,
        "status": info["status"],
        "filename": info["filename"],
        "content": info.get("content"),
        "content_type": info.get("content_type", "text/plain"),
        "is_image": info.get("is_image", False),
        "error": info.get("error"),
        "media_url": f"/api/media/{storage_name}" if storage_name else "",
        "thumb_url": info.get("thumb_url", ""),
    }


# ─── Routes ────────────────────────────────────────

@router.post("/ask", response_model=QAResponse)
async def ask_question(body: QARequest, db: Session = Depends(get_db)):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # 1. Semantic search (skip if knowledge base disabled)
    MIN_RELEVANCE = QA_MIN_RELEVANCE

    if body.kb_enabled:
        try:
            top_chunks = await semantic_search(db, question)
        except vector_store.VectorStoreError:
            return QAResponse(
                answer="抱歉，知识库向量检索服务（Qdrant）当前不可用，无法检索知识库。请稍后重试，或检查 Qdrant 服务是否已启动。",
                sources=[],
            )
        except EmbeddingError:
            return QAResponse(
                answer="抱歉，嵌入模型调用失败，无法进行语义检索。请稍后重试。",
                sources=[],
            )

        # 实体名→类型映射（Neo4j 一次查询）：直召与来源卡片实体 chips 共用
        name_types = await _collect_all_entity_name_types(db)

        # 图谱实体直召补充：问句中含知识图谱实体名时，把提及该实体的分块
        # 作为候选——确定性匹配（实体名出现在分块文本中），不经过向量相似度
        # 阈值过滤；与向量结果按文章去重（向量命中优先）
        recalled = await entity_recall(db, question, name_types)
        merged = list(top_chunks)
        have_articles = {a.id for _, a, _ in merged}
        for item in recalled:
            if item[1].id not in have_articles:
                have_articles.add(item[1].id)
                merged.append(item)

        def _make_source(score: float, a: Article, c: ArticleChunk | None) -> QASource:
            return QASource(
                article_id=a.id,
                title=a.title,
                excerpt=get_excerpt(c.chunk_text if c else ""),
                relevance=round(score, 3),
                entities=_entities_in_chunk(c.chunk_text if c else "", name_types),
            )

        # 来源与上下文：向量命中（阈值过滤）+ 实体直召（不受阈值限制）
        sources: list[QASource] = []
        relevant_chunks: list[tuple[float, Article, ArticleChunk | None]] = []
        seen_articles: set[str] = set()
        for score, a, c in top_chunks:
            if score < MIN_RELEVANCE:
                continue
            seen_articles.add(a.id)
            sources.append(_make_source(score, a, c))
            relevant_chunks.append((score, a, c))
        for _, a, c in recalled:
            if a.id in seen_articles:
                continue  # 向量已命中该文章，直召跳过
            seen_articles.add(a.id)
            sources.append(_make_source(ENTITY_RECALL_SCORE, a, c))
            relevant_chunks.append((ENTITY_RECALL_SCORE, a, c))

        entity_info_text = await _collect_entity_info(question, merged, db)
    else:
        top_chunks = []
        sources = []
        entity_info_text = ""
        relevant_chunks = []

    # Convert file_contexts to dicts for internal use
    file_ctxs = [fc.model_dump() for fc in body.file_contexts] if body.file_contexts else []

    # Determine if we have any KB context to provide
    has_kb = bool(relevant_chunks or entity_info_text or file_ctxs)

    # 3. Try LLM if configured (even without KB context — use general knowledge)
    llm_failed = False
    if LLM_API_KEY:
        try:
            answer = await call_llm(question, body.history, relevant_chunks, entity_info_text, file_ctxs)
            return QAResponse(answer=answer, sources=sources)
        except Exception:
            llm_failed = True

    # 4. Fallback: LLM not configured or failed
    if has_kb:
        fallback = build_fallback_answer(question, sources, entity_info_text, llm_failed=llm_failed, file_contexts=file_ctxs)
        return QAResponse(answer=fallback, sources=sources)

    # No LLM and no KB — truly nothing to work with
    if llm_failed:
        return QAResponse(answer="抱歉，LLM 调用失败且知识库中暂无相关信息。请稍后重试。", sources=[])
    return QAResponse(answer="知识库中暂无相关信息。配置 LLM API Key 后可直接利用大模型知识回答。", sources=[])


async def call_llm(
    question: str,
    history: list[QAMessage],
    top_chunks: list[tuple[float, Article, ArticleChunk | None]],
    entity_info: str = "",
    file_contexts: list[dict] | None = None,
) -> str:
    import httpx
    import base64

    context_parts: list[str] = []
    image_contexts: list[dict] = []  # for multimodal messages

    # Separate text files from image files
    if file_contexts:
        for fc in file_contexts:
            fname = html.escape(str(fc.get("filename", "文件")))
            if fc.get("is_image"):
                image_contexts.append(fc)
            else:
                fcontent = fc.get("content", "")
                context_parts.append(f"### [上传文件: {fname}]\n{fcontent[:3000]}\n")

    for score, article, chunk in top_chunks:
        chunk_text = chunk.chunk_text if chunk else (article.content or "")[:500]
        context_parts.append(f"### [{article.title}]\n{chunk_text[:1500]}\n")

    context = "\n---\n".join(context_parts)
    if entity_info:
        context += entity_info

    has_kb = bool(context_parts or entity_info)
    has_images = bool(image_contexts)

    if has_kb or has_images:
        prompt_parts = [QA_WITH_KB_INTRO]
        if has_kb:
            prompt_parts.append(QA_WITH_KB_INSTRUCTIONS)
        if has_images:
            prompt_parts.append(QA_WITH_KB_IMAGES)
        prompt_parts.append(QA_WITH_KB_FALLBACK)
        prompt_parts.append(QA_CLOSING)
        if has_kb:
            prompt_parts.append(f"\n知识库相关内容：\n\n{context}")
        system_prompt = "\n".join(prompt_parts)
    else:
        system_prompt = QA_NO_KB

    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for h in history:
        messages.append({"role": h.role, "content": h.content})

    # Build user message — multimodal if images present
    if image_contexts:
        user_content: list[dict] = [{"type": "text", "text": question}]
        for img in image_contexts:
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{img.get('content_type', 'image/png')};base64,{img.get('content', '')}",
                },
            })
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": question})

    request_body: dict = {
        "model": VISION_MODEL if image_contexts else LLM_MODEL,
        "messages": messages,
        "temperature": QA_TEMPERATURE,
        "max_tokens": 1500,
    }

    # Use vision credentials for image Q&A, LLM credentials for text Q&A
    api_base = VISION_API_BASE if image_contexts else LLM_API_BASE
    api_key = VISION_API_KEY if image_contexts else LLM_API_KEY

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(
            f"{api_base.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=request_body,
        )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"].get("content", "") or ""
        # GLM-5.2 (reasoning model) may return empty content if reasoning consumed all tokens;
        # fall back to the reasoning_content as a best-effort answer
        if not content.strip():
            reasoning = data["choices"][0]["message"].get("reasoning_content", "") or ""
            if reasoning.strip():
                # Take the last part of reasoning as it's closest to the conclusion
                content = reasoning
        return content


# 实体直召保底分数：实体名直接出现在分块文本中属于确定性匹配信号，
# 高于默认 MIN_RELEVANCE（0.3），低于典型向量命中（0.9+）
ENTITY_RECALL_SCORE = 0.5


async def _collect_all_entity_name_types(db: Session) -> dict[str, str]:
    """收集知识图谱全部实体名→类型映射（Neo4j 实体节点；不可用降级空字典）。"""
    try:
        return await neo4j_store.all_entity_name_types()
    except Neo4jStoreError as e:
        logger.warning("Entity names query failed (Neo4j unavailable): %s", e)
        return {}


async def entity_recall(
    db: Session,
    question: str,
    name_types: dict[str, str],
) -> list[tuple[float, Article, ArticleChunk]]:
    """图谱实体直召：问句中的实体名 → 含该实体的文章 → 提及该实体的分块。

    与向量检索互补的确定性路径：即使 embedding 对专有名词不敏感
    （相似度低于阈值），只要问句中出现知识图谱里的实体名，就能定位到
    相关分块。返回 (保底分数, 文章, 分块) 列表，每篇文章最多一条。
    """
    # 问句中出现的知识图谱实体名（长度 ≥ 2 防单字噪声；子串匹配不要求分词）
    hit_names = [n for n in name_types if len(n) >= 2 and n in question]
    if not hit_names:
        return []

    # 文章级匹配（Neo4j MENTIONS 边）：哪些文章包含问句命中的实体
    try:
        by_name = await neo4j_store.article_ids_by_entity_names(hit_names)
    except Neo4jStoreError as e:
        logger.warning("Entity recall query failed (Neo4j unavailable): %s", e)
        return []
    aid_hits: dict[str, list[str]] = {}
    for name, aids in by_name.items():
        for aid in aids:
            aid_hits.setdefault(aid, []).append(name)
    if not aid_hits:
        return []

    matched: list[tuple[Article, list[str]]] = []
    # 命中文章数来自 Neo4j（无上限）：按 500 分块查询，避免 SQLite 绑定变量超限
    aid_list = list(aid_hits.keys())
    for i in range(0, len(aid_list), 500):
        for a in db.query(Article).filter(Article.id.in_(aid_list[i:i + 500])).all():
            matched.append((a, aid_hits[a.id]))

    # 分块级匹配：提及实体名的分块，每篇文章取第一条（SQLite 分块文本）
    results: list[tuple[float, Article, ArticleChunk]] = []
    for a, hits in matched:
        chunks = db.query(ArticleChunk).filter(ArticleChunk.article_id == a.id).all()
        for ch in chunks:
            if any(n in ch.chunk_text for n in hits):
                results.append((ENTITY_RECALL_SCORE, a, ch))
                break
    return results


async def _collect_entity_info(
    question: str,
    top_chunks: list[tuple[float, Article, str]],
    db: Session,
) -> str:
    """Extract entity names from question and retrieved articles, then look up
    additional info (附加信息) for those entities. Returns a formatted string
    suitable for injection into the LLM context, or empty string if no info found."""
    # Collect entity names from retrieved articles
    entity_names: set[str] = set()
    # Also try to find entity names from the question by scanning for known entities
    # (simple heuristic: check if any entity name from the DB appears in the question)
    all_entity_infos = db.query(EntityInfo.entity_name).distinct().all()
    known_entities = {row[0] for row in all_entity_infos}
    for name in known_entities:
        if name.lower() in question.lower():
            entity_names.add(name)

    # 检索命中文章的实体名来自 Neo4j（MENTIONS 边）；不可用时跳过——问答照常
    try:
        names_by_article = await neo4j_store.entity_names_for_articles(
            [a.id for _, a, _ in top_chunks]
        )
    except Neo4jStoreError as e:
        logger.warning("Entity names query failed (Neo4j unavailable): %s", e)
        names_by_article = {}
    for names in names_by_article.values():
        entity_names.update(names)

    if not entity_names:
        return ""

    # Look up additional info for all relevant entities
    infos = db.query(EntityInfo).filter(
        EntityInfo.entity_name.in_(list(entity_names))
    ).order_by(EntityInfo.entity_name, EntityInfo.created_at.asc()).all()

    if not infos:
        return ""

    # Format entity info lines
    by_entity: dict[str, list[str]] = {}
    for info in infos:
        by_entity.setdefault(info.entity_name, []).append(
            f"  - {info.name}: {info.content}"
        )

    lines = ["\n## 实体附加信息（知识图谱）\n"]
    for name, items in by_entity.items():
        lines.append(f"**{name}**:")
        lines.extend(items)
        lines.append("")

    return "\n".join(lines)


def build_fallback_answer(question: str, sources: list[QASource], entity_info: str = "", llm_failed: bool = False, file_contexts: list[dict] | None = None) -> str:
    lines: list[str] = []

    if file_contexts:
        lines.append("以下是与上传文件相关的内容：\n")
        for fc in file_contexts:
            fname = html.escape(str(fc.get("filename", "文件")))
            if fc.get("is_image"):
                lines.append(f"**📎 {fname}** (图片，已传递给视觉模型)\n")
            else:
                fcontent = fc.get("content", "")
                lines.append(f"**📎 {fname}**")
                lines.append(f"> {fcontent[:500]}…\n" if len(fcontent) > 500 else f"> {fcontent}\n")

    if sources:
        lines.append("以下是与您问题最相关的知识库内容摘要：\n")
        for i, src in enumerate(sources, 1):
            lines.append(f"**{i}. {src.title}**（相关度：{src.relevance:.1%}）")
            lines.append(f"> {src.excerpt}\n")

    if entity_info:
        if lines:
            lines.append("---")
        lines.append(entity_info.strip())

    if not sources and not entity_info:
        lines.append("知识库中暂无相关信息。")

    if llm_failed:
        lines.append("\n---")
        lines.append("*提示：LLM 调用失败，以上是基于关键词匹配的备选结果。*")
    elif not LLM_API_KEY:
        lines.append("\n---")
        lines.append("💡 *提示：配置 LLM API Key 后可获得智能回答。*")
    return "\n".join(lines)
