import asyncio
import json
import logging
import math
import os
import re
import uuid
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk, EntityInfo

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/qa", tags=["qa"])

# ─── Config ────────────────────────────────────────

# ── LLM (text) ──
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
# ── Vision ──
VISION_API_KEY = os.getenv("VISION_API_KEY", LLM_API_KEY)
VISION_API_BASE = os.getenv("VISION_API_BASE", LLM_API_BASE)
VISION_MODEL = os.getenv("VISION_MODEL", "glm-4v-flash")
# ── ASR ──
ASR_API_KEY = os.getenv("ASR_API_KEY", LLM_API_KEY)
ASR_API_BASE = os.getenv("ASR_API_BASE", LLM_API_BASE)
ASR_MODEL = os.getenv("ASR_MODEL", "GLM-ASR-2512")
# ── Embedding ──
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", LLM_API_KEY)
EMBEDDING_API_BASE = os.getenv("EMBEDDING_API_BASE", LLM_API_BASE)
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "embedding-3")
# ── Q&A ──
QA_TEMPERATURE = float(os.getenv("QA_TEMPERATURE", "0.4"))

# ─── Schemas ───────────────────────────────────────

class QAMessage(BaseModel):
    role: str
    content: str

class FileContext(BaseModel):
    filename: str
    content: str           # text content, or base64 data for images
    content_type: str = "text/plain"  # MIME type
    is_image: bool = False # True → pass as vision content to LLM

class QARequest(BaseModel):
    question: str
    history: list[QAMessage] = Field(default_factory=list, max_length=50)
    file_contexts: list[FileContext] = Field(default_factory=list, max_length=5)
    kb_enabled: bool = True  # False → skip knowledge base, use LLM directly

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


# ─── File parsing for Q&A context ──────────────────

# Reuse upload.py parsing functions
from app.routes.upload import (
    parse_text_from_bytes, parse_docx, parse_xlsx, parse_pptx, parse_pdf,
    TEXT_EXTENSIONS, WORD_EXTENSIONS, EXCEL_EXTENSIONS, PPT_EXTENSIONS,
    PDF_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
)

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))

# MIME map for image types
IMAGE_MIME_MAP = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
}

# Re-parse helper for QA: extracts text or encodes images for LLM context
# ─── Audio / Video Q&A helpers ──────────────────────

def _find_ffmpeg_qa() -> str | None:
    """Find ffmpeg executable."""
    import platform
    import shutil
    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg:
        return ffmpeg
    if platform.system() == 'Windows':
        try:
            from pathlib import Path
            ffmpeg_base = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
            for p in ffmpeg_base.glob('Gyan.FFmpeg_*'):
                candidates = sorted(p.glob('ffmpeg-*-full_build/bin/ffmpeg.exe'), reverse=True)
                if candidates:
                    return str(candidates[0])
        except Exception:
            pass
    return None


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
        ffmpeg_path = _find_ffmpeg_qa()
        if not ffmpeg_path:
            return "[音频识别失败：需要安装 ffmpeg 来转换非 WAV 格式的音频。]"
        try:
            result = subprocess.run(
                [ffmpeg_path, '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'],
                input=content_bytes, capture_output=True, timeout=60,
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
        async with httpx.AsyncClient(timeout=120.0) as client:
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


async def parse_video_for_qa(content_bytes: bytes, filename: str) -> str:
    """Extract frames from video and describe for Q&A context."""
    import base64
    import cv2
    import tempfile
    import httpx

    if not VISION_API_KEY:
        return "[视频识别失败：未配置视觉模型 API。]"

    # Write video bytes to temp file (OpenCV needs a file path)
    tmp = tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False)
    try:
        tmp.write(content_bytes)
        tmp.close()

        cap = cv2.VideoCapture(tmp.name)
        if not cap.isOpened():
            return "[视频识别失败：无法打开视频文件。]"

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        duration = total_frames / fps if fps > 0 else 0

        # Extract up to 4 frames
        positions = [0, 0.3, 0.6, 0.85]
        frames_b64: list[str] = []
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

        if not frames_b64:
            return "[视频识别失败：无法从视频中提取画面。]"

        # ── Call vision model ──
        name_no_ext = Path(filename).stem
        user_content: list[dict] = [
            {
                "type": "text",
                "text": (
                    f"视频「{name_no_ext}」，{len(frames_b64)} 个关键帧，时长约 {duration:.0f} 秒。"
                    "请用中文简要描述视频内容（100-200 字）。"
                ),
            }
        ]
        for b64 in frames_b64:
            user_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            })

        async with httpx.AsyncClient(timeout=120.0) as client:
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
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


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


@router.post("/parse-file")
async def parse_file_for_question(file: UploadFile = File(...)):
    """Parse an uploaded file and return its text for use as Q&A context.
    Does NOT create an article — purely for on-the-fly Q&A."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    content_bytes = await file.read()

    if len(content_bytes) > 50 * 1024 * 1024:  # 50MB for Q&A
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

    # Save temporarily for docx/xlsx/pptx/pdf parsers that need a file path
    safe_fname = re.sub(r'[^\w.\-]', '_', file.filename)
    tmp_name = f"_qa_{uuid.uuid4().hex}_{safe_fname}"
    tmp_path = UPLOAD_DIR / tmp_name
    # Only write to disk if we need a file path (non-text parsers)
    needs_disk = ext not in TEXT_EXTENSIONS
    if needs_disk:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with open(tmp_path, "wb") as f:
            f.write(content_bytes)

    try:
        result = await parse_file_for_qa(content_bytes, str(tmp_path) if needs_disk else file.filename, file.content_type or "")
    except Exception:
        result = {"content": f"[文件解析失败: {file.filename}]", "content_type": "text/plain", "is_image": False, "filename": file.filename}
    finally:
        if needs_disk and tmp_path.exists():
            tmp_path.unlink()

    return result


# ─── Routes ────────────────────────────────────────

@router.post("/ask", response_model=QAResponse)
async def ask_question(body: QARequest, db: Session = Depends(get_db)):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # 1. Semantic search (skip if knowledge base disabled)
    MIN_RELEVANCE = 0.4

    if body.kb_enabled:
        top_chunks = await semantic_search(db, question)
        sources = [
            QASource(
                article_id=a.id,
                title=a.title,
                excerpt=get_excerpt(chunk_text),
                relevance=round(score, 3),
            )
            for score, a, chunk_text in top_chunks
            if score >= MIN_RELEVANCE
        ]
        entity_info_text = _collect_entity_info(question, top_chunks, db)
        relevant_chunks = [(s, a, t) for s, a, t in top_chunks if s >= MIN_RELEVANCE]
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
    top_chunks: list[tuple[float, Article, str]],
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
            fname = fc.get("filename", "文件")
            if fc.get("is_image"):
                image_contexts.append(fc)
            else:
                fcontent = fc.get("content", "")
                context_parts.append(f"### [上传文件: {fname}]\n{fcontent[:3000]}\n")

    for score, article, chunk_text in top_chunks:
        context_parts.append(f"### [{article.title}]\n{chunk_text[:1500]}\n")

    context = "\n---\n".join(context_parts)
    if entity_info:
        context += entity_info

    has_kb = bool(context_parts or entity_info)
    has_images = bool(image_contexts)

    if has_kb or has_images:
        prompt_parts = ["你是一个知识库问答助手。"]
        if has_kb:
            prompt_parts.append("请根据以下知识库文章的内容回答用户的问题。")
            prompt_parts.append("如果知识库中有'实体附加信息'部分，请优先参考。")
        if has_images:
            prompt_parts.append("用户上传了图片，请基于图片内容回答问题。")
        prompt_parts.append("如果信息不足以完整回答，可以结合你的通用知识补充。")
        prompt_parts.append("回答要简洁、准确，使用中文。")
        if has_kb:
            prompt_parts.append(f"\n知识库相关内容：\n\n{context}")
        system_prompt = "\n".join(prompt_parts)
    else:
        system_prompt = (
            "你是一个知识库问答助手。当前知识库中没有与问题直接相关的内容。"
            "请利用你的通用知识回答用户的问题。\n"
            "回答要简洁、准确，使用中文。"
        )

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

    async with httpx.AsyncClient(timeout=120.0) as client:
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


def build_fallback_answer(question: str, sources: list[QASource], entity_info: str = "", llm_failed: bool = False, file_contexts: list[dict] | None = None) -> str:
    lines: list[str] = []

    if file_contexts:
        lines.append("以下是与上传文件相关的内容：\n")
        for fc in file_contexts:
            fname = fc.get("filename", "文件")
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
