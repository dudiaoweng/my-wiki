import asyncio
import json
import logging
import os
import re
import html
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from app.dependencies import get_db
from app.models import Article
from app.schemas import ArticleResponse
from app.auth import get_client_cert, CertInfo
from app.config import (
    LLM_API_KEY, LLM_API_BASE, LLM_MODEL,
    VISION_API_KEY, VISION_API_BASE, VISION_MODEL,
    ASR_API_KEY, ASR_API_BASE, ASR_MODEL,
    LLM_TIMEOUT, VISION_TIMEOUT, ASR_TIMEOUT, FFMPEG_TIMEOUT,
    UPLOAD_DIR as UPLOAD_DIR_STR,
    AUTO_PARSE,
)
from app.utils import find_ffmpeg, read_upload_limited, MAX_UPLOAD_BYTES
from app.llm_extract import extract_chunks_iter, merge_tags, merge_entities
from app.prompts import IMAGE_DESCRIPTION, VIDEO_DESCRIPTION, GENERATE_TITLE

router = APIRouter(prefix="/api/upload", tags=["upload"])

logger = logging.getLogger(__name__)

# ─── Config ────────────────────────────────────────

UPLOAD_DIR = Path(UPLOAD_DIR_STR)

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

def _decode_text(content_bytes: bytes) -> str:
    """带编码检测的文本解码（Windows 记事本默认保存 GBK，硬编码 UTF-8 会乱码）。

    优先级：BOM（utf-8-sig / utf-16）→ 严格 UTF-8 → 严格 GB18030（GBK/GB2312
    超集）→ UTF-8 容错替换兜底。纯 ASCII 在所有编码下字节一致，无影响。
    """
    if content_bytes.startswith(b"\xef\xbb\xbf"):
        return content_bytes.decode("utf-8-sig")
    if content_bytes.startswith(b"\xff\xfe") or content_bytes.startswith(b"\xfe\xff"):
        return content_bytes.decode("utf-16")
    for enc in ("utf-8", "gb18030"):
        try:
            return content_bytes.decode(enc)
        except UnicodeDecodeError:
            continue
    return content_bytes.decode("utf-8", errors="replace")


async def parse_text(file: UploadFile) -> str:
    """Parse plain text files."""
    content = await file.read()
    return _decode_text(content)


def parse_text_from_bytes(content_bytes: bytes) -> str:
    """Parse plain text from already-read bytes."""
    return _decode_text(content_bytes)


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
    """Describe image content via vision LLM.
    Returns markdown with an embedded image + description."""
    import base64
    import httpx

    storage_name = Path(file_path).name
    img_tag = f'<img src="/api/media/{storage_name}" alt="{html.escape(original_name, quote=True)}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
    original_esc = html.escape(original_name)

    if not VISION_API_KEY:
        return f"{img_tag}\n\n# 图片：{original_esc}\n\n> 未配置视觉模型 API，无法自动描述图片内容。请手动添加。"

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
        async with httpx.AsyncClient(timeout=VISION_TIMEOUT) as client:
            resp = await client.post(
                f"{VISION_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {VISION_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": VISION_MODEL,   # vision model for image understanding
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": IMAGE_DESCRIPTION,
                                },
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{mime};base64,{image_data}",
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
                return f"{img_tag}\n\n# 图片描述：{original_esc}\n\n{desc}"
            else:
                logger.warning("Image description API returned %d: %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.warning("Image description failed: %s", e)

    return f"{img_tag}\n\n# 图片：{original_esc}\n\n> 图片描述生成失败。请手动添加文章内容。"


async def parse_media(content_bytes: bytes, filename: str, content_type: str, storage_name: str = "") -> str:
    """Handle audio — try ASR transcription, surface errors in content.

    返回完整媒体描述（含 <audio> 标签）。调用方用 _replace_media_placeholder
    替换原占位标签行，避免多次 reprocess 时旧结果在正文中越堆越多。
    """
    name_no_ext = Path(filename).stem.replace('_', ' ').replace('-', ' ')
    name_esc = html.escape(name_no_ext)
    filename_esc = html.escape(filename)
    audio_tag = (
        f'<audio controls src="/api/media/{storage_name}" style="width:100%"></audio>'
        if storage_name else ""
    )

    logger.info(f"[AUDIO] parse_media called: filename={filename}, size={len(content_bytes)}, ASR_API_KEY={'set' if ASR_API_KEY else 'NOT SET'}")
    if ASR_API_KEY:
        try:
            logger.info("[AUDIO] Calling transcribe_media_from_bytes...")
            result = await transcribe_media_from_bytes(content_bytes, filename, content_type)
            if result and result.strip():
                # Check if it's an error message
                if result.startswith("ERROR:"):
                    err_msg = result[len("ERROR:"):].strip()
                    return (
                        f"{audio_tag}\n\n# 音频：{name_esc}\n\n"
                        f"> ⚠️ 语音识别失败：{err_msg}\n\n"
                        f"> 文件名：{filename_esc}\n"
                        f"> 类型：{content_type}"
                    )
                return f"{audio_tag}\n\n{result}" if audio_tag else result
        except Exception:
            pass

    # Fallback
    return (
        f"{audio_tag}\n\n# 音频：{name_esc}\n\n"
        f"该音频文件记录了{name_esc}相关的内容。\n\n"
        f"> 文件名：{filename_esc}\n"
        f"> 类型：{content_type}\n"
        f"> 注意：无法自动转写此音频的内容。请手动添加描述。"
    )


async def parse_video(file_path: str, original_name: str) -> str:
    """Extract key frames from video and describe via vision LLM.
    Returns markdown with an embedded video player (with poster thumbnail) + description."""
    import base64
    import cv2
    import httpx

    storage_name = Path(file_path).name
    poster_name = f"{Path(file_path).stem}_poster.jpg"
    poster_path = str(Path(file_path).parent / poster_name)
    poster_src = f"/api/media/{poster_name}"
    video_tag = f'<video controls src="/api/media/{storage_name}" poster="{poster_src}" style="width:100%;max-width:100%"></video>'
    name_no_ext = Path(original_name).stem.replace('_', ' ').replace('-', ' ')
    name_esc = html.escape(name_no_ext)

    if not VISION_API_KEY:
        return f"{video_tag}\n\n# 视频：{name_esc}\n\n> 未配置视觉模型 API，无法自动描述视频内容。"

    # ── Extract key frames ──
    cap = cv2.VideoCapture(file_path)
    if not cap.isOpened():
        return f"{video_tag}\n\n# 视频：{name_esc}\n\n> 无法打开视频文件。"

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    duration = total_frames / fps if fps > 0 else 0

    # Extract first frame as poster/thumbnail
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    ret, first_frame = cap.read()
    if ret and first_frame is not None:
        cv2.imwrite(poster_path, first_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Extract up to 5 frames at 0%, 25%, 50%, 75%, 90% of the video
    positions = [0, 0.25, 0.5, 0.75, 0.9]
    frames_b64: list[str] = []

    for pos in positions:
        frame_idx = int(total_frames * pos)
        if frame_idx >= total_frames:
            frame_idx = total_frames - 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if ret and frame is not None:
            # Resize large frames to max 1024px on longest side (API size limits)
            h, w = frame.shape[:2]
            max_side = max(h, w)
            if max_side > 1024:
                scale = 1024 / max_side
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
            # Encode as JPEG
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            frames_b64.append(base64.b64encode(buf).decode("utf-8"))

    cap.release()

    if not frames_b64:
        return f"{video_tag}\n\n# 视频：{name_esc}\n\n> 无法从视频中提取画面。"

    # ── Send frames to vision model ──
    n_frames = len(frames_b64)
    user_content: list[dict] = [
        {
            "type": "text",
            "text": VIDEO_DESCRIPTION.format(
                name=name_no_ext, duration=duration, frame_count=n_frames,
            ),
        }
    ]
    for i, b64 in enumerate(frames_b64):
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
                    "messages": [
                        {
                            "role": "user",
                            "content": user_content,
                        }
                    ],
                    "max_tokens": 800,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                desc = data["choices"][0]["message"]["content"].strip()
                logger.info(f"[VIDEO] Vision model response ({len(desc)} chars): {desc[:150]}")
                return f"{video_tag}\n\n# 视频内容描述：{name_esc}\n\n{desc}"
            else:
                logger.info(f"[VIDEO] Vision API returned {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        logger.info(f"[VIDEO] Vision API error: {e}")

    # Fallback: if vision model fails
    return (
        f"{video_tag}\n\n"
        f"# 视频：{name_esc}\n\n"
        f"该视频文件记录了{name_esc}相关的内容（时长约 {duration:.0f} 秒）。\n\n"
        f"> 视频内容自动识别失败。请手动添加描述。"
    )


def _convert_to_mono_wav(audio_bytes: bytes, orig_ext: str) -> bytes | None:
    """Convert audio to 16kHz mono WAV bytes. Returns None if conversion fails."""
    import io
    import subprocess
    import wave
    import audioop

    ext = orig_ext.lower()

    # ── WAV: use built-in wave module (no ffmpeg needed) ──
    if ext == '.wav':
        try:
            with wave.open(io.BytesIO(audio_bytes), 'rb') as wf:
                nchannels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                framerate = wf.getframerate()
                frames = wf.readframes(wf.getnframes())

            # Convert to mono if needed
            if nchannels > 1:
                frames = audioop.tomono(frames, sampwidth, 1.0, 1.0)
                logger.info(f"[AUDIO] Converted {nchannels}ch → mono, {sampwidth*8}bit")

            # Resample to 16kHz if needed
            if framerate != 16000:
                frames = audioop.ratecv(frames, sampwidth, 1, framerate, 16000, None)[0]
                logger.info(f"[AUDIO] Resampled {framerate}Hz → 16000Hz")

            # Write back as mono WAV
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(sampwidth)
                wf.setframerate(16000)
                wf.writeframes(frames)
            return buf.getvalue()
        except Exception as e:
            logger.info(f"[AUDIO] WAV conversion failed: {e}")
            return None

    # ── Other formats: use ffmpeg subprocess ──
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        logger.info("[AUDIO] ffmpeg not found — cannot convert non-WAV audio")
        return None

    try:
        logger.info(f"[AUDIO] Converting {ext} to mono 16kHz WAV via ffmpeg: {ffmpeg_path}")
        result = subprocess.run(
            [
                ffmpeg_path,
                '-i', 'pipe:0',       # read from stdin
                '-ac', '1',            # mono
                '-ar', '16000',        # 16kHz
                '-f', 'wav',           # WAV output
                'pipe:1',              # write to stdout
            ],
            input=audio_bytes,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode('utf-8', errors='replace')[:300]
            logger.info(f"[AUDIO] ffmpeg error: {stderr}")
            return None

        logger.info(f"[AUDIO] ffmpeg conversion OK, output size={len(result.stdout)}")
        return result.stdout
    except FileNotFoundError:
        logger.info("[AUDIO] ffmpeg executable not found at path")
        return None
    except Exception as e:
        logger.info(f"[AUDIO] ffmpeg conversion failed: {e}")
        return None


async def transcribe_media_from_bytes(content: bytes, filename: str, content_type: str) -> str:
    """Transcribe audio via ASR model (OpenAI-compatible /audio/transcriptions).

    Supports Zhipu GLM-ASR-2512 and local llama-server Qwen3-ASR.

    Returns the transcribed text on success, or an error message string
    prefixed with "ERROR:" on failure (so the caller can surface it).
    """
    import httpx

    ext = Path(filename).suffix.lower()
    logger.info(f"[AUDIO] transcribe_media_from_bytes: filename={filename}, ext={ext}, size={len(content)}")

    # ── Convert to mono 16kHz WAV (required by GLM-ASR-2512) ──
    logger.info("[AUDIO] Calling _convert_to_mono_wav...")
    mono_bytes = _convert_to_mono_wav(content, ext)
    if mono_bytes is None:
        return "ERROR: 音频格式转换失败（需要单声道音频）。请尝试转换音频文件后重新上传。"

    # ── Zhipu ASR endpoint ──
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
                text = data.get("text", "")
                # llama.cpp 的 Qwen3-ASR 输出带 "language <语种><asr_text>" 前缀，循环剥掉避免污染正文
                text = re.sub(r'^(?:(?:language\s+\w+|<\w+>)\s*)+', '', text or '')
                if text and text.strip():
                    logger.info(f"[ASR] {ASR_MODEL} success: {text[:150]}")
                    return f"# 音频转录\n\n{text}"
                return f"ERROR: {ASR_MODEL} 返回了空文本。"
            else:
                err_detail = resp.text[:300]
                logger.info(f"[ASR] {ASR_MODEL} returned {resp.status_code}: {err_detail}")
                return f"ERROR: {ASR_MODEL} 识别失败（HTTP {resp.status_code}）：{err_detail}"
    except Exception as e:
        logger.info(f"[ASR] {ASR_MODEL} error: {e}")
        return f"ERROR: {ASR_MODEL} 调用异常：{e}"


# ─── LLM helpers ───────────────────────────────────

def _clean_text_for_title(text: str) -> str:
    """Strip HTML tags, markdown images, and metadata headers — keep the real content."""
    import re as _re
    cleaned = _re.sub(r'<[^>]+>', '', text)                # HTML tags
    cleaned = _re.sub(r'!\[[^\]]*\]\([^)]+\)', '', cleaned) # markdown images
    # Remove metadata headers produced by our parsers
    cleaned = _re.sub(r'^#+\s*图片描述[：:].*\n?', '', cleaned, flags=_re.MULTILINE)
    cleaned = _re.sub(r'^#+\s*图片[：:].*\n?', '', cleaned, flags=_re.MULTILINE)
    cleaned = _re.sub(r'^#+\s*文件内容描述\s*\n?', '', cleaned, flags=_re.MULTILINE)
    cleaned = _re.sub(r'^#+\s*音视频文件\s*\n?', '', cleaned, flags=_re.MULTILINE)
    # Remove metadata lines
    cleaned = _re.sub(r'^-\s*(?:文件名|类型|大小)[：:].*\n?', '', cleaned, flags=_re.MULTILINE)
    cleaned = _re.sub(r'^>.*\n?', '', cleaned, flags=_re.MULTILINE)
    cleaned = _re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()


async def generate_title(text: str) -> str:
    """Generate a concise summary title from document content via LLM.

    Returns a title that *synthesizes* the document's core topic (not a sentence
    copied from the text).  Returns empty string on failure so the caller can
    decide the fallback strategy.
    """
    if not LLM_API_KEY:
        logger.info("[TITLE] LLM not configured — skipping title generation")
        return ""

    import httpx

    # Use cleaned text — strip media tags and metadata headers
    cleaned = _clean_text_for_title(text)
    logger.info(f"[TITLE] Cleaned text: {len(cleaned)} chars, first 100: {cleaned[:100]}")

    if len(cleaned) < 10:
        logger.info(f"[TITLE] Text too short ({len(cleaned)} chars) — skipping")
        return ""

    # Send more context for better understanding (up to 8000 chars)
    context = cleaned[:8000]

    prompt = GENERATE_TITLE.format(context=context)

    try:
        logger.info(f"[TITLE] Calling LLM model={LLM_MODEL} with {len(context)} chars of context...")
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(
                f"{LLM_API_BASE.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": 4000,  # GLM-5.2 reasoning model needs headroom for thinking
                    "temperature": 0.7,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            logger.info("[TITLE] API response keys: {list(data.keys())}, choices={len(data.get('choices', []))}")
            if data.get("choices"):
                c0 = data["choices"][0]
                logger.info("[TITLE] Choice[0]: finish_reason={c0.get('finish_reason')}, message={c0.get('message')}")
            raw = (data.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()
            logger.info(f"[TITLE] LLM raw response ({len(raw)} chars): {raw[:200]}")

            # Clean up formatting
            title = raw
            title = re.sub(r'^["\'"\'「『【《〈』」』】》〉]', '', title)
            title = re.sub(r'["\'"\'「『【《〈』」』】》〉]$', '', title)
            title = re.sub(r'^(?:标题|题目)[：:]\s*', '', title)
            title = re.sub(r'^#+\s*', '', title)
            title = re.sub(r'\n.*', '', title)             # first line only
            title = title.strip()

            # Validate: must be a meaningful phrase (not just a heading number or filler)
            if not title or len(title) < 4:
                logger.info(f"[TITLE] Title too short ({len(title) if title else 0} chars), discarding")
                return ""

            # Reject responses that are obviously not titles
            no_title_patterns = [
                r'^[第序]\s*\d+\s*[章节篇]',       # "第一章", "第3节"
                r'^[\(（]\s*[\)）]\s*$',            # just "()"
                r'^[一二三四五六七八九十]、',         # "一、概述"
                r'^\(?\d+\)[\.、]',                  # "1.", "1、"
                r'^(?:好的|以下|这里|下面是|例如)',    # meta-language
            ]
            for pat in no_title_patterns:
                if re.match(pat, title):
                    logger.info(f"[TITLE] Rejected meta/noise title: {title}")
                    return ""

            if len(title) > 100:
                title = title[:100]

            logger.info(f"[TITLE] ✅ Final title: {title}")
            return title

    except Exception as e:
        logger.info(f"[TITLE] ❌ Exception: {e}")
        return ""



# ─── Route ─────────────────────────────────────────

@router.post("", response_model=ArticleResponse, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    category_id: str | None = Form(default=None),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    user_cn = cert.display_name or ""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    # Determine file extension
    ext = Path(file.filename).suffix.lower()

    # 1. Save file to disk (sanitize filename to prevent path traversal)
    file_id = str(uuid.uuid4())
    safe_filename = re.sub(r'[^\w.\-]', '_', Path(file.filename).name)
    safe_name = f"{file_id}_{safe_filename}"
    escaped_name = html.escape(file.filename, quote=True)
    file_path = UPLOAD_DIR / safe_name

    content_bytes = await read_upload_limited(file, MAX_UPLOAD_BYTES)

    with open(file_path, "wb") as f:
        f.write(content_bytes)

    # 2. Build initial content — 媒体立即显示标签；文档先占位，文本提取在后台异步完成
    #   （文档解析为纯本地操作，不阻塞 HTTP 响应；AUTO_PARSE 只控制 LLM 类解析）
    is_media = ext in IMAGE_EXTENSIONS or ext in AUDIO_EXTENSIONS or ext in VIDEO_EXTENSIONS
    is_doc = ext in (TEXT_EXTENSIONS | WORD_EXTENSIONS | EXCEL_EXTENSIONS | PPT_EXTENSIONS | PDF_EXTENSIONS)
    media_src = f"/api/media/{safe_name}"
    raw_text = ""  # initial content — media tag or document placeholder

    if is_media:
        if ext in IMAGE_EXTENSIONS:
            raw_text = f'<img src="{media_src}" alt="{escaped_name}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
        elif ext in AUDIO_EXTENSIONS:
            raw_text = f'<audio controls src="{media_src}" style="width:100%"></audio>'
        else:
            raw_text = f'<video controls src="{media_src}" style="width:100%"></video>'
    elif is_doc:
        raw_text = (
            f'<div data-attachment="{escaped_name}" data-path="{safe_name}" '
            f'style="padding:10px 14px;background:var(--c-surface);border-radius:8px;'
            f'border:1px solid var(--c-border);margin:8px 0">📎 {escaped_name}（读取中…）</div>'
        )
    else:
        raw_text = f"# {escaped_name}\n\n不支持的文件格式。文件已作为附件保存。"

    # 3. Add persistent doc-attachment marker for non-media files (so the frontend
    #    can uniquely identify each file, even when multiple share the same name).
    if is_doc:
        raw_text += f"\n\n<!-- doc-attachment: {escaped_name} | {safe_name} -->"

    # 4. Track upload order so later-added attachments preserve correct ordering
    raw_text += f"\n\n<!-- attachments-order: {escaped_name} -->"

    # 5. Use filename (without extension) as initial title; background task will generate a better one
    title = Path(file.filename).stem or file.filename

    # 5. Create article immediately — media visible；文档占位（后台提取文本）
    #   processing 两阶段标志：
    #   - 文档 → "processing:{safe_name}"（读取中）→ 提取完成先落库，AUTO_PARSE
    #     开启时转 "recognizing:{safe_name}"（解析中）→ 解析完成清空
    #   - 媒体/未知类型 + AUTO_PARSE → 直接 "recognizing:{safe_name}"（无本地提取阶段）
    article = Article(
        title=title,
        content=raw_text,
        category_id=category_id or None,
        tags=json.dumps([], ensure_ascii=False),
        entities=None,
        processing=(
            f"processing:{safe_name}" if is_doc
            else (f"recognizing:{safe_name}" if AUTO_PARSE else None)
        ),
        attachment_path=str(safe_name),
        attachment_name=file.filename,
        attachment_type=file.content_type or "",
        created_by=user_cn or None,
        updated_by=user_cn or None,
    )
    db.add(article)
    db.commit()
    db.refresh(article)

    # 5. Background: LLM enhance title + content + tags + entities
    article_id = article.id

    async def _bg_enhance():
        from app.database import SessionLocal
        db2 = SessionLocal()
        try:
            errs: list[str] = []
            full_text = raw_text

            # Step A: 提取文档文本（纯本地解析，始终执行）——替换占位符
            if is_doc:
                try:
                    if ext in TEXT_EXTENSIONS:
                        with open(file_path, "rb") as f:
                            parsed = parse_text_from_bytes(f.read())
                    elif ext in WORD_EXTENSIONS:
                        parsed = await asyncio.to_thread(parse_docx, str(file_path))
                    elif ext in EXCEL_EXTENSIONS and ext != '.csv':
                        parsed = await asyncio.to_thread(parse_xlsx, str(file_path))
                    elif ext in PPT_EXTENSIONS:
                        parsed = await asyncio.to_thread(parse_pptx, str(file_path))
                    elif ext in PDF_EXTENSIONS:
                        parsed = await asyncio.to_thread(parse_pdf, str(file_path))
                    else:
                        parsed = ""

                    if parsed:
                        placeholder = f'<div data-attachment="{escaped_name}"'
                        idx = full_text.find(placeholder)
                        if idx >= 0:
                            end_idx = full_text.find('</div>', idx)
                            if end_idx >= 0:
                                full_text = full_text[:idx] + parsed + full_text[end_idx + 6:]
                    else:
                        errs.append("文档读取未提取到内容")
                except Exception as e:
                    logger.warning(f"[UPLOAD] Document parsing failed for {file.filename}: {e}")
                    errs.append(f"文档读取失败：{e}")

            # ── 第一步返回：文档文本提取完成，立即落库 ──
            # 前端每 5s 轮询会先看到文本；识别结果在第二阶段完成后再落库
            if is_doc:
                art = db2.query(Article).filter(Article.id == article_id).first()
                if not art:
                    return
                # 文档读取失败时把占位符提示改为"读取失败"，避免卡在"读取中…"
                if any(e.startswith("文档读取") for e in errs):
                    full_text = full_text.replace("（读取中…）", "（读取失败）")
                art.content = full_text
                art.processing = f"recognizing:{safe_name}" if AUTO_PARSE else None
                db2.commit()

            # Step B: 媒体 LLM 描述（AUTO_PARSE 控制）
            if AUTO_PARSE and is_media:
                if ext in IMAGE_EXTENSIONS:
                    full_text = await parse_image(str(file_path), file.filename)
                elif ext in VIDEO_EXTENSIONS:
                    full_text = await parse_video(str(file_path), file.filename)
                else:
                    # Re-read from disk to avoid capturing content_bytes in closure
                    with open(file_path, "rb") as f:
                        audio_bytes = f.read()
                    desc = await parse_media(audio_bytes, file.filename, file.content_type or "", safe_name)
                    # desc 自带 <audio> 标签：替换占位标签行而非追加，避免重复堆积
                    audio_tag = f'<audio controls src="/api/media/{safe_name}" style="width:100%"></audio>'
                    full_text = raw_text.replace(audio_tag, desc)

            # ── 向量分块先行：提取与 Q&A 检索共用同一套切分 ──
            from app.routes.qa import rebuild_article_chunks, embed_chunk_rows, get_article_chunks
            if full_text.strip():
                chunk_rows = await rebuild_article_chunks(db2, article_id, full_text)
                await embed_chunk_rows(db2, chunk_rows)

            # Step C: 标签/实体提取（LLM，AUTO_PARSE 控制）——基于向量分块逐段提取、逐段落库
            bg_tags, bg_entities = [], None
            if AUTO_PARSE:
                try:
                    chunk_rows = get_article_chunks(db2, article_id)
                    texts = [r.chunk_text for r in chunk_rows]
                    seg_idx = 0
                    async for seg_tags, seg_entities in extract_chunks_iter(texts):
                        if seg_tags:
                            bg_tags = merge_tags(bg_tags, seg_tags)
                        if seg_entities:
                            bg_entities = merge_entities(bg_entities, seg_entities)
                            # 块级实体标注：该段提取结果写入对应分块
                            if seg_idx < len(chunk_rows):
                                chunk_rows[seg_idx].entities = json.dumps(seg_entities, ensure_ascii=False)
                        # 逐段落库（本任务串行使用 db2，无并发访问）
                        art = db2.query(Article).filter(Article.id == article_id).first()
                        if not art:
                            return
                        if bg_tags:
                            art.tags = json.dumps(bg_tags, ensure_ascii=False)
                        if bg_entities:
                            art.entities = json.dumps(bg_entities, ensure_ascii=False)
                        db2.commit()
                        seg_idx += 1
                except Exception as e:
                    logger.warning(f"[UPLOAD] LLM extraction failed: {e}")

            art = db2.query(Article).filter(Article.id == article_id).first()
            if not art:
                return

            # ── 第二步返回：识别结果（媒体描述 / 标签 / 实体）──
            if is_media:
                markers = []
                for m in re.finditer(r'<!-- (?:attachments-order|doc-attachment): .+? -->', raw_text):
                    markers.append(m.group())
                art.content = (full_text + '\n\n' + '\n'.join(markers)) if markers else full_text

            # Update tags + entities（仅 AUTO_PARSE 开启时执行过提取）
            if AUTO_PARSE:
                if bg_tags:
                    art.tags = json.dumps(bg_tags, ensure_ascii=False)
                else:
                    errs.append("标签提取未返回结果")

                if bg_entities:
                    art.entities = json.dumps(bg_entities, ensure_ascii=False)
                else:
                    errs.append("实体和关系提取未返回结果")

            # Append error notes to content so the user can see what happened
            if errs:
                err_lines = "\n".join(f"- {e}" for e in errs)
                art.content = (art.content or raw_text) + f"\n\n> ⚠️ 以下步骤未成功完成：\n> \n> {err_lines}\n>\n> 模型: {LLM_MODEL} / {VISION_MODEL}"

            art.processing = None  # mark as done

            # 分块与嵌入已在提取前完成（向量分块先行），此处仅提交识别结果
            db2.commit()
            logger.info(f"[UPLOAD] Enhanced: title={art.title!r} tags={bg_tags} errors={errs}")
        except Exception as e:
            logger.info(f"[UPLOAD] BG enhance failed: {e}")
            try:
                art = db2.query(Article).filter(Article.id == article_id).first()
                if art:
                    art.title = file.filename
                    art.content = raw_text + f"\n\n> ⚠️ 内容识别失败：{e}"
                    art.processing = None  # mark as done (failed, but no longer processing)
                    db2.commit()
            except Exception:
                pass
        finally:
            db2.close()

    # 后台任务：文档文本提取始终执行；媒体描述与标签/实体提取（LLM）由 AUTO_PARSE 控制
    if AUTO_PARSE or is_doc:
        asyncio.create_task(_bg_enhance())

    # Embeddings are computed after background recognition completes (see _bg_enhance)

    return article
