import json
import logging
import math
import os
import re
from dotenv import load_dotenv
load_dotenv()

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk, EntityInfo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/qa", tags=["qa"])

# ─── Config ────────────────────────────────────────

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "embedding-3")  # Zhipu default

# ─── Schemas ───────────────────────────────────────

class QAMessage(BaseModel):
    role: str
    content: str

class QARequest(BaseModel):
    question: str
    history: list[QAMessage] = Field(default_factory=list, max_length=20)

class QASource(BaseModel):
    article_id: str
    title: str
    excerpt: str
    relevance: float

class QAResponse(BaseModel):
    answer: str
    sources: list[QASource]


# ─── Embedding helpers ─────────────────────────────

MAX_CHUNK_CHARS = 2000  # Keep chunks within embedding model token limits

def chunk_article(content: str) -> list[str]:
    """Split article into chunks by markdown headings, then by size."""
    # Split by headings but keep the heading text with its content
    sections = re.split(r'\n(?=#{1,3}\s)', content)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue
        # Split long sections into sub-chunks
        chunks.extend(_split_long_text(section, MAX_CHUNK_CHARS))

    # Ensure we have at least one chunk
    if not chunks:
        chunks = [content[:MAX_CHUNK_CHARS]]

    return chunks


def _split_long_text(text: str, max_chars: int) -> list[str]:
    """Split text into chunks of at most max_chars, trying to break at natural boundaries."""
    if len(text) <= max_chars:
        return [text]

    result: list[str] = []
    # First try splitting by double newlines (paragraphs)
    paragraphs = text.split('\n\n')
    current = ''
    for para in paragraphs:
        if len(current) + len(para) + 2 <= max_chars:
            current = (current + '\n\n' + para).strip()
        else:
            if current:
                result.append(current)
            # If a single paragraph is still too long, split by single newlines
            if len(para) > max_chars:
                lines = para.split('\n')
                sub = ''
                for line in lines:
                    if len(sub) + len(line) + 1 <= max_chars:
                        sub = (sub + '\n' + line).strip()
                    else:
                        if sub:
                            result.append(sub)
                        # If a single line is too long, hard split by char count
                        if len(line) > max_chars:
                            for i in range(0, len(line), max_chars):
                                result.append(line[i:i + max_chars])
                        else:
                            sub = line
                if sub:
                    result.append(sub)
            else:
                current = para
    if current:
        result.append(current)

    return result


async def get_embedding(text: str) -> list[float]:
    """Get embedding vector from the configured API (OpenAI-compatible /v1/embeddings)."""
    import httpx

    # Truncate to avoid exceeding model token limits
    text = text[:2000]

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{LLM_API_BASE.rstrip('/')}/embeddings",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": EMBEDDING_MODEL,
                "input": text,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"][0]["embedding"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# Track last-known article count to skip repeated ensure_embeddings scans
_embedded_article_count: int | None = None


async def ensure_embeddings(db: Session, force: bool = False):
    """Compute embeddings for articles missing them (incremental, not full table scan)."""
    global _embedded_article_count
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
        # For force mode: delete old chunks first
        if force:
            db.query(ArticleChunk).filter(ArticleChunk.article_id == article.id).delete()

        # Chunk and embed
        chunks = chunk_article(article.content)
        for i, chunk_text in enumerate(chunks):
            try:
                vec = await get_embedding(chunk_text)
                db.add(ArticleChunk(
                    article_id=article.id,
                    chunk_index=str(i),
                    chunk_text=chunk_text,
                    embedding=json.dumps(vec),
                ))
            except Exception:
                logger.warning("Failed to embed chunk %s of article %s", i, article.id, exc_info=True)
                # Store chunk without embedding (will be skipped in search)
                db.add(ArticleChunk(
                    article_id=article.id,
                    chunk_index=str(i),
                    chunk_text=chunk_text,
                    embedding=None,
                ))

        db.commit()

    # Update cache (declared global at top of function)
    _embedded_article_count = db.query(Article).count()


async def semantic_search(db: Session, question: str, top_k: int = 5) -> list[tuple[float, Article, str]]:
    """
    Semantic search using embeddings.
    Returns list of (score, article, chunk_text).
    """
    # Ensure all articles have embeddings
    await ensure_embeddings(db)

    # Get question embedding
    try:
        q_embedding = await get_embedding(question)
    except Exception:
        # Fallback to keyword search if embedding API fails
        return fallback_keyword_search(db, question, top_k)

    # Compare against all chunks with embeddings
    chunks = db.query(ArticleChunk).filter(ArticleChunk.embedding.isnot(None)).all()
    if not chunks:
        return fallback_keyword_search(db, question, top_k)

    results: list[tuple[float, Article, str]] = []
    seen_articles: set[str] = set()

    for chunk in chunks:
        try:
            vec = json.loads(chunk.embedding)  # type: ignore
        except (json.JSONDecodeError, TypeError):
            continue
        score = cosine_similarity(q_embedding, vec)
        results.append((score, chunk.article, chunk.chunk_text))

    # Sort by score descending, take top results per article
    results.sort(key=lambda x: x[0], reverse=True)
    deduped: list[tuple[float, Article, str]] = []
    for score, article, text in results:
        if article.id not in seen_articles:
            seen_articles.add(article.id)
            deduped.append((score, article, text))
        if len(deduped) >= top_k:
            break

    return deduped


def fallback_keyword_search(db: Session, question: str, top_k: int = 5) -> list[tuple[float, Article, str]]:
    """Fallback: simple keyword-based search when embeddings unavailable."""
    articles = db.query(Article).all()
    results: list[tuple[float, Article, str]] = []

    # Tokenize: CJK bigrams + English words
    tokens = set()
    cjk = re.findall(r'[一-鿿]', question)
    for i in range(len(cjk) - 1):
        tokens.add(cjk[i] + cjk[i + 1])
    tokens.update(re.findall(r'[a-zA-Z]{2,}', question.lower()))

    for a in articles:
        title_lower = a.title.lower()
        content_lower = a.content.lower()
        score = 0.0
        for t in tokens:
            if t in title_lower:
                score += 3.0
            if t in content_lower:
                score += 1.0
        if score > 0:
            results.append((score, a, a.content[:500]))

    results.sort(key=lambda x: x[0], reverse=True)
    return results[:top_k]


def get_excerpt(content: str, max_len: int = 200) -> str:
    clean = re.sub(r'[#*`>\[\]()!\-|]', ' ', content)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:max_len] + ('…' if len(clean) > max_len else '')


# ─── Route ─────────────────────────────────────────

@router.post("/ask", response_model=QAResponse)
async def ask_question(body: QARequest, db: Session = Depends(get_db)):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # 1. Semantic search
    top_chunks = await semantic_search(db, question)

    sources = [
        QASource(
            article_id=a.id,
            title=a.title,
            excerpt=get_excerpt(chunk_text),
            relevance=round(score, 3),
        )
        for score, a, chunk_text in top_chunks
    ]

    # 2. Collect entity additional info for relevant entities
    entity_info_text = _collect_entity_info(question, top_chunks, db)

    # If we have entity info but no search results, still provide the info
    if not sources and not entity_info_text:
        return QAResponse(
            answer="知识库中暂无相关信息。",
            sources=[],
        )

    # 3. Try LLM if configured
    llm_failed = False
    if LLM_API_KEY:
        try:
            answer = await call_llm(question, body.history, top_chunks, entity_info_text)
            return QAResponse(answer=answer, sources=sources)
        except Exception:
            llm_failed = True

    # 4. Fallback
    fallback = build_fallback_answer(question, sources, entity_info_text, llm_failed=llm_failed)
    return QAResponse(answer=fallback, sources=sources)


async def call_llm(
    question: str,
    history: list[QAMessage],
    top_chunks: list[tuple[float, Article, str]],
    entity_info: str = "",
) -> str:
    import httpx

    context_parts: list[str] = []
    for score, article, chunk_text in top_chunks:
        context_parts.append(f"### [{article.title}]\n{chunk_text[:1500]}\n")

    context = "\n---\n".join(context_parts)
    if entity_info:
        context += entity_info

    system_prompt = (
        "你是一个知识库问答助手。请根据以下知识库文章的内容回答用户的问题。\n"
        "如果知识库中有'实体附加信息'部分，这些是知识图谱中实体的结构化补充信息，"
        "请优先参考这些信息来回答关于实体属性的问题。\n"
        "如果知识库中没有相关信息，请如实说明'知识库中暂无相关信息'。\n"
        "回答要简洁、准确，使用中文。\n\n"
        f"知识库相关内容：\n\n{context}"
    )

    messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": question})

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{LLM_API_BASE.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": LLM_MODEL,
                "messages": messages,
                "temperature": 0.4,
                "max_tokens": 1500,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def _collect_entity_info(
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

    # Also collect entity names from the retrieved articles
    for _, article, _ in top_chunks:
        if not article.entities:
            continue
        try:
            ent_data = json.loads(article.entities)
        except (json.JSONDecodeError, TypeError):
            continue
        for e in ent_data.get("entities", []):
            name = e.get("name", "")
            if name:
                entity_names.add(name)

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
            f"  - {info.category}: {info.content}"
        )

    lines = ["\n## 实体附加信息（知识图谱）\n"]
    for name, items in by_entity.items():
        lines.append(f"**{name}**:")
        lines.extend(items)
        lines.append("")

    return "\n".join(lines)


def build_fallback_answer(question: str, sources: list[QASource], entity_info: str = "", llm_failed: bool = False) -> str:
    lines: list[str] = []

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
