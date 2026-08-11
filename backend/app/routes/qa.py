import asyncio
import json
import logging
import math
import os
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article, ArticleChunk, Comment, EntityInfo
from app.config import (
    LLM_API_KEY, LLM_API_BASE, LLM_MODEL,
    VISION_API_KEY, VISION_API_BASE, VISION_MODEL,
    ASR_API_KEY, ASR_API_BASE, ASR_MODEL,
    EMBEDDING_API_KEY, EMBEDDING_API_BASE, EMBEDDING_MODEL,
    QA_TEMPERATURE,
    UPLOAD_DIR as UPLOAD_DIR_STR,
)
from app.utils import find_ffmpeg
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
            # For force mode: delete old chunks first
            if force:
                db.query(ArticleChunk).filter(ArticleChunk.article_id == article.id).delete()

            # Chunk and embed article content
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
                    db.add(ArticleChunk(
                        article_id=article.id,
                        chunk_index=str(i),
                        chunk_text=chunk_text,
                        embedding=None,
                    ))

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
                    try:
                        vec = await get_embedding(chunk_text)
                        db.add(ArticleChunk(
                            article_id=article.id,
                            chunk_index=idx,
                            chunk_text=f"[评论] {chunk_text}",
                            embedding=json.dumps(vec),
                        ))
                    except Exception:
                        db.add(ArticleChunk(
                            article_id=article.id,
                            chunk_index=idx,
                            chunk_text=f"[评论] {chunk_text}",
                            embedding=None,
                        ))

            db.commit()

        # Update cache
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
    content_bytes = await file.read()

    if len(content_bytes) > 50 * 1024 * 1024:  # 50MB for Q&A
        raise HTTPException(status_code=413, detail="File too large (max 50MB)")

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
