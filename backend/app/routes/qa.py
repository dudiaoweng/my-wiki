import json
import math
import os
import re
from dotenv import load_dotenv
load_dotenv()

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk

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
    history: list[QAMessage] = []

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


async def ensure_embeddings(db: Session, force: bool = False):
    """Compute embeddings for any articles missing them."""
    articles = db.query(Article).all()
    for article in articles:
        # Check if this article already has chunks with embeddings
        existing = db.query(ArticleChunk).filter(
            ArticleChunk.article_id == article.id,
            ArticleChunk.embedding.isnot(None)
        ).count()

        if existing > 0 and not force:
            continue

        # Delete old chunks if re-computing
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
            except Exception as e:
                print(f"Warning: failed to embed chunk {i} of article {article.id}: {e}")
                # Store chunk without embedding (will be skipped in search)
                db.add(ArticleChunk(
                    article_id=article.id,
                    chunk_index=str(i),
                    chunk_text=chunk_text,
                    embedding=None,
                ))

        db.commit()


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

    if not sources:
        return QAResponse(
            answer="知识库中暂无相关信息。",
            sources=[],
        )

    # 2. Try LLM if configured
    if LLM_API_KEY:
        try:
            answer = await call_llm(question, body.history, top_chunks)
            return QAResponse(answer=answer, sources=sources)
        except Exception:
            pass

    # 3. Fallback
    fallback = build_fallback_answer(question, sources)
    return QAResponse(answer=fallback, sources=sources)


async def call_llm(
    question: str,
    history: list[QAMessage],
    top_chunks: list[tuple[float, Article, str]],
) -> str:
    import httpx

    context_parts: list[str] = []
    for score, article, chunk_text in top_chunks:
        context_parts.append(f"### [{article.title}]\n{chunk_text[:1500]}\n")

    context = "\n---\n".join(context_parts)

    system_prompt = (
        "你是一个知识库问答助手。请根据以下知识库文章的内容回答用户的问题。\n"
        "如果知识库中有相关信息，请引用具体的文章内容来回答。\n"
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


def build_fallback_answer(question: str, sources: list[QASource]) -> str:
    lines = ["以下是与您问题最相关的知识库内容摘要：\n"]
    for i, src in enumerate(sources, 1):
        lines.append(f"**{i}. {src.title}**（相关度：{src.relevance:.1%}）")
        lines.append(f"> {src.excerpt}\n")
    lines.append("---")
    lines.append(
        "💡 *提示：配置 LLM API Key 后可获得智能回答。*"
    )
    return "\n".join(lines)
