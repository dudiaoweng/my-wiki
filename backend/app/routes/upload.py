import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article
from app.schemas import ArticleResponse

router = APIRouter(prefix="/api/upload", tags=["upload"])

# ─── Config ────────────────────────────────────────

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

# Ensure upload directory exists
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Supported formats
TEXT_EXTENSIONS = {'.txt', '.md', '.markdown', '.json', '.xml', '.csv', '.yaml', '.yml', '.py', '.js', '.ts', '.html', '.css'}
WORD_EXTENSIONS = {'.docx'}
EXCEL_EXTENSIONS = {'.xlsx', '.xls'}
PPT_EXTENSIONS = {'.pptx', '.ppt'}
PDF_EXTENSIONS = {'.pdf'}
AUDIO_EXTENSIONS = {'.mp3', '.wav', '.m4a', '.flac', '.ogg', '.wma'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.wmv'}
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif'}


# ─── File parsers ──────────────────────────────────

async def parse_text(file: UploadFile) -> str:
    """Parse plain text files."""
    content = await file.read()
    return content.decode("utf-8", errors="replace")


def parse_text_from_bytes(content_bytes: bytes) -> str:
    """Parse plain text from already-read bytes."""
    return content_bytes.decode("utf-8", errors="replace")


def parse_docx(file_path: str) -> str:
    """Parse Word documents."""
    from docx import Document
    doc = Document(file_path)
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def parse_xlsx(file_path: str) -> str:
    """Parse Excel files — iterate all sheets, join cell values."""
    from openpyxl import load_workbook
    wb = load_workbook(file_path, data_only=True)
    parts: list[str] = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        parts.append(f"## Sheet: {sheet_name}")
        rows: list[str] = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) if c is not None else "" for c in row]
            text = " | ".join(cells).strip()
            if text:
                rows.append(text)
        parts.append("\n".join(rows))
    return "\n\n".join(parts)


def parse_pptx(file_path: str) -> str:
    """Parse PowerPoint files."""
    from pptx import Presentation
    prs = Presentation(file_path)
    parts: list[str] = []
    for i, slide in enumerate(prs.slides):
        slide_texts: list[str] = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if text:
                        slide_texts.append(text)
        if slide_texts:
            parts.append(f"## Slide {i + 1}\n" + "\n".join(slide_texts))
    return "\n\n".join(parts)


def parse_pdf(file_path: str) -> str:
    """Parse PDF files."""
    from PyPDF2 import PdfReader
    reader = PdfReader(file_path)
    parts: list[str] = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text and text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts)


async def parse_image(file_path: str, original_name: str) -> str:
    """Describe image content via vision LLM."""
    import base64
    import httpx

    if not LLM_API_KEY:
        return f"# 图片：{original_name}\n\n> 未配置 LLM API，无法自动描述图片内容。请手动添加。"

    # Read and encode image
    with open(file_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

    # Determine MIME type
    ext = Path(original_name).suffix.lower()
    mime_map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
    }
    mime = mime_map.get(ext, 'image/png')

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{LLM_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "请用中文详细描述这张图片的内容（不超过300字）。如果是文档截图、表格、图表，请尽可能提取其中的文字信息。",
                                },
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{mime};base64,{image_data}",
                                        "detail": "high",
                                    },
                                },
                            ],
                        }
                    ],
                    "max_tokens": 800,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                desc = data["choices"][0]["message"]["content"].strip()
                return f"# 图片描述：{original_name}\n\n{desc}"
    except Exception:
        pass

    return f"# 图片：{original_name}\n\n> 图片描述生成失败。请手动添加文章内容。"


async def parse_media(content_bytes: bytes, filename: str, content_type: str) -> str:
    """Handle audio/video — try LLM transcription, fallback to metadata."""
    # Try using the LLM API for transcription
    if LLM_API_KEY:
        try:
            result = await transcribe_media_from_bytes(content_bytes, filename, content_type)
            if result and result.strip():
                return result
        except Exception:
            pass

    # Fallback: return metadata as content
    return (
        f"# 音视频文件\n\n"
        f"- 文件名：{filename}\n"
        f"- 类型：{content_type}\n"
        f"- 大小：{len(content_bytes)} bytes\n\n"
        f"> 注意：无法自动转写此文件的内容。请手动添加文章内容或配置支持音视频转写的 API。"
    )


async def transcribe_media_from_bytes(content: bytes, filename: str, content_type: str) -> str:
    """Attempt to transcribe audio/video via LLM API using file bytes."""
    import httpx

    # Try the audio/speech endpoint if available
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # OpenAI-compatible transcription endpoint
            resp = await client.post(
                f"{LLM_API_BASE.rstrip('/').replace('/chat/completions', '')}/audio/transcriptions",
                headers={"Authorization": f"Bearer {LLM_API_KEY}"},
                files={"file": (filename or "audio", content, content_type or "application/octet-stream")},
                data={"model": "whisper-1"},
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("text", "")
    except Exception:
        pass

    # Try sending as a chat message with file reference
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{LLM_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": "请用中文简要描述这个文件的内容（不超过200字）。如果无法识别，请回复'无法识别'。"},
                        {"role": "user", "content": f"文件名: {filename}, 类型: {content_type}, 大小: {len(content)} bytes"}
                    ],
                    "max_tokens": 500,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                if text and text.strip() and "无法识别" not in text:
                    return f"# 文件内容描述\n\n{text}"
    except Exception:
        pass

    return ""


# ─── LLM helpers ───────────────────────────────────

async def generate_title(text: str) -> str:
    """Generate a concise title from document text."""
    if not LLM_API_KEY:
        return _fallback_title(text)

    import httpx
    prompt = f"根据以下文档内容，生成一句简洁的摘要作为标题（不超过30个字，直接返回标题文本，不要加引号）：\n\n{text[:2000]}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{LLM_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 100,
                    "temperature": 0.3,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            title = data["choices"][0]["message"]["content"].strip()
            # Clean up quotes
            title = re.sub(r'^["\'《]|["\'》]$', '', title)
            return title[:100] if title else _fallback_title(text)
    except Exception:
        return _fallback_title(text)


def _fallback_title(text: str) -> str:
    """Generate a simple title from the first line or first N chars."""
    first_line = text.strip().split("\n")[0]
    # Strip markdown headings
    first_line = re.sub(r'^#{1,6}\s+', '', first_line).strip()
    if 5 <= len(first_line) <= 50:
        return first_line
    clean = re.sub(r'\s+', ' ', text.strip())[:40]
    return clean + ("…" if len(text) > 40 else "")


async def extract_entities_and_relations(text: str) -> tuple[list[str], dict | None]:
    """Extract tags and structured entities+relations from document text via LLM.
    Returns (tags, entities_dict).
    Uses the shared extraction function via asyncio.to_thread to avoid blocking."""
    import asyncio
    from app.llm_extract import extract_tags_and_entities
    return await asyncio.to_thread(extract_tags_and_entities, text)


# ─── Route ─────────────────────────────────────────

@router.post("", response_model=ArticleResponse, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    category_id: str | None = Form(default=None),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Determine file extension
    ext = Path(file.filename).suffix.lower()

    # 1. Save file to disk (sanitize filename to prevent path traversal)
    file_id = str(uuid.uuid4())
    safe_filename = re.sub(r'[^\w.\-]', '_', Path(file.filename).name)
    safe_name = f"{file_id}_{safe_filename}"
    file_path = UPLOAD_DIR / safe_name

    content_bytes = await file.read()

    # Prevent resource exhaustion: limit to 500MB
    if len(content_bytes) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 500MB)")

    with open(file_path, "wb") as f:
        f.write(content_bytes)

    # 2. Extract text based on file type
    try:
        if ext in TEXT_EXTENSIONS:
            # Use content_bytes directly — file.read() has already been consumed
            text = parse_text_from_bytes(content_bytes)
        elif ext in WORD_EXTENSIONS:
            text = await asyncio.to_thread(parse_docx, str(file_path))
        elif ext in EXCEL_EXTENSIONS and ext != '.csv':
            text = await asyncio.to_thread(parse_xlsx, str(file_path))
        elif ext in PPT_EXTENSIONS:
            text = await asyncio.to_thread(parse_pptx, str(file_path))
        elif ext in PDF_EXTENSIONS:
            text = await asyncio.to_thread(parse_pdf, str(file_path))
        elif ext in IMAGE_EXTENSIONS:
            text = await parse_image(str(file_path), file.filename)
        elif ext in AUDIO_EXTENSIONS or ext in VIDEO_EXTENSIONS:
            # Use content_bytes — file.read() has already been consumed
            text = await parse_media(content_bytes, file.filename, file.content_type or "")
        else:
            # Unsupported format — store as attachment only
            text = f"# {file.filename}\n\n不支持的文件格式。文件已作为附件保存。"
    except Exception as e:
        text = f"# {file.filename}\n\n文件解析失败，文件已作为附件保存。"

    # 3. Generate title via LLM
    title = await generate_title(text)

    # 4. Extract tags + entities + relations via LLM
    tags, entities = await extract_entities_and_relations(text)

    # 5. Create article
    article = Article(
        title=title or file.filename,
        content=text,
        category_id=category_id or None,
        tags=json.dumps(tags, ensure_ascii=False),
        entities=json.dumps(entities, ensure_ascii=False) if entities else None,
        attachment_path=str(safe_name),
        attachment_name=file.filename,
        attachment_type=file.content_type or "",
    )
    db.add(article)
    db.commit()
    db.refresh(article)

    # 6. Compute embeddings for semantic search (non-blocking)
    try:
        from app.routes.qa import chunk_article, get_embedding
        from app.models import ArticleChunk
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
                pass  # Skip failed chunks — will be computed lazily on Q&A
        db.commit()
    except Exception:
        pass  # Embedding computation is best-effort

    return article
