import json
import asyncio
import logging
import os
import re
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Path as PathParam, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import desc
from app.dependencies import get_db
from app.database import SessionLocal
from app.models import Article, Category, Comment, EntityInfo, utcnow
from app.schemas import ArticleCreate, ArticleUpdate, ArticleResponse, ArticleListItem, CommentSummary
from app.auth import get_client_cert, CertInfo
from app.llm_extract import extract_tags_and_entities
from app.routes.upload import (
    generate_title,
    parse_text_from_bytes, parse_docx, parse_xlsx, parse_pptx, parse_pdf,
    parse_image, parse_video, parse_media,
    TEXT_EXTENSIONS, WORD_EXTENSIONS, EXCEL_EXTENSIONS, PPT_EXTENSIONS,
    PDF_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
)
from app.routes.qa import _extract_video_thumbnail
import uuid

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/articles", tags=["articles"])

MAX_PAGE_SIZE = 200
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))


def _validate_article_id(article_id: str) -> None:
    """Validate article ID — accepts UUIDs and legacy short IDs (e.g. 'a1')."""
    if not article_id or len(article_id) > 36:
        raise HTTPException(status_code=400, detail="Invalid article ID format")
    # Only strict-validate if it looks like a UUID (36 chars with dashes)
    if len(article_id) == 36 and '-' in article_id:
        try:
            uuid.UUID(article_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid article ID format")


def _annotate_entity_creator(entities: dict | None, creator: str) -> dict | None:
    """Add created_by and created_at to each entity item in the LLM output."""
    if not isinstance(entities, dict):
        return entities
    now = utcnow().isoformat()
    for e in entities.get("entities", []):
        if not e.get("created_by"):
            e["created_by"] = creator
            e["created_at"] = now
    return entities


def _extract_and_merge(article: Article, user_tags: list[str], db: Session) -> None:
    """Call LLM to extract tags + entities from article content, then merge with
    user-provided tags and update the article in the database."""
    llm_tags, entities = extract_tags_and_entities(article.content)

    if llm_tags or entities:
        merged_tags = list(dict.fromkeys([*user_tags, *llm_tags]))
        article.tags = json.dumps(merged_tags, ensure_ascii=False)
        if isinstance(entities, dict) and entities:
            entities = _annotate_entity_creator(entities, article.created_by or "")
            article.entities = json.dumps(entities, ensure_ascii=False)
        db.commit()
        logger.info(
            "LLM extraction success for article %s: %d tags, %d entities",
            article.id, len(llm_tags), len(entities.get("entities", [])) if isinstance(entities, dict) else 0,
        )


@router.get("", response_model=list[ArticleListItem])
def list_articles(
    category_id: str | None = Query(default=None, alias="category_id"),
    search: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=MAX_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
):
    q = db.query(Article).options(joinedload(Article.category)).order_by(desc(Article.updated_at))

    if category_id:
        q = q.filter(Article.category_id == category_id)

    if search:
        like = f"%{search}%"
        q = q.filter(
            Article.title.ilike(like) | Article.content.ilike(like)
        )

    if tag:
        # tags stored as JSON array string: ["tag1","tag2"]
        # use LIKE with quoted tag value inside the JSON string
        q = q.filter(Article.tags.like(f'%"{tag}"%'))

    articles = q.offset(skip).limit(limit).all()

    # Batch-fetch comment counts and latest comments
    article_ids = [a.id for a in articles]
    if article_ids:
        from sqlalchemy import func
        # Comment counts
        count_rows = (
            db.query(Comment.article_id, func.count(Comment.id))
            .filter(Comment.article_id.in_(article_ids))
            .group_by(Comment.article_id)
            .all()
        )
        counts = {row[0]: row[1] for row in count_rows}

        # Up to 3 latest comments per article
        article_comments: dict[str, list[Comment]] = {aid: [] for aid in article_ids}
        all_comments = (
            db.query(Comment)
            .filter(Comment.article_id.in_(article_ids))
            .order_by(desc(Comment.created_at))
            .all()
        )
        for c in all_comments:
            if len(article_comments.get(c.article_id, [])) < 3:
                article_comments.setdefault(c.article_id, []).append(c)
    else:
        counts = {}
        article_comments = {}

    results = []
    for a in articles:
        item = ArticleListItem.model_validate(a)
        item.comment_count = counts.get(a.id, 0)
        for c in article_comments.get(a.id, []):
            # Strip HTML tags and markers from comment content for clean card display
            clean = re.sub(r'<[^>]*>', '', c.content or '')
            clean = re.sub(r'<!--.*?-->', '', clean)
            clean = re.sub(r'\s+', ' ', clean).strip()
            snippet = clean[:60] + "…" if len(clean) > 60 else clean
            item.latest_comments.append(CommentSummary(
                id=c.id,
                content=snippet,
                created_by=c.created_by,
                created_at=c.created_at,
            ))
        results.append(item)

    return results


@router.get("/{article_id}", response_model=ArticleResponse)
def get_article(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    return article


async def _bg_extract(article_id: str, user_tags: list[str], need_title: bool) -> None:
    """Background task: extract tags, entities, and optionally generate title via LLM."""
    db2 = SessionLocal()
    try:
        art = db2.query(Article).filter(Article.id == article_id).first()
        if not art:
            return

        # Run tag/entity extraction and title generation concurrently
        extract_task = asyncio.to_thread(extract_tags_and_entities, art.content)
        title_task = generate_title(art.content) if need_title else None

        if title_task:
            (llm_tags, entities), generated = await asyncio.gather(
                extract_task, title_task,
            )
        else:
            llm_tags, entities = await extract_task

        # Apply tag + entity extraction results
        if llm_tags or entities:
            merged_tags = list(dict.fromkeys([*user_tags, *llm_tags]))
            art.tags = json.dumps(merged_tags, ensure_ascii=False)
            if isinstance(entities, dict) and entities:
                entities = _annotate_entity_creator(entities, art.created_by or "")
                art.entities = json.dumps(entities, ensure_ascii=False)
            db2.commit()
            logger.info(
                "[BG_EXTRACT] article %s: %d tags, %d entities",
                article_id, len(llm_tags),
                len(entities.get("entities", [])) if isinstance(entities, dict) else 0,
            )

        # Apply auto-generated title, or fall back to default
        if need_title:
            if generated:
                art.title = generated
                logger.info(f"[BG_EXTRACT] Auto-generated title: {generated}")
            else:
                art.title = "无标题"
                logger.info("[BG_EXTRACT] Title generation empty, using default")
            db2.commit()

        art.processing = None
        db2.commit()
        logger.info(f"[BG_EXTRACT] article {article_id} processing complete")
    except Exception as e:
        logger.warning(f"[BG_EXTRACT] Failed: {e}")
        try:
            art = db2.query(Article).filter(Article.id == article_id).first()
            if art:
                art.processing = None
                db2.commit()
        except Exception:
            pass
    finally:
        db2.close()


def _replace_media_placeholder(full_text: str, storage_name: str, replacement: str) -> str:
    """Replace the media tag placeholder line(s) in full_text with the parse result."""
    # Find the line containing the storage_name (appears in <img src="..." /> etc.)
    lines = full_text.split('\n')
    new_lines = []
    for line in lines:
        if storage_name in line and ('<img' in line or '<video' in line or '<audio' in line):
            # Replace this line with the full description (which includes the media tag)
            new_lines.append(replacement)
            replacement = ''  # only replace first occurrence
        else:
            new_lines.append(line)
    # If no placeholder found, prepend — this would create a duplicate!
    if replacement:
        print(f"[BG_ATTACH] WARNING: placeholder not found for storage_name={storage_name!r} in content. Prepending.")
        new_lines.insert(0, replacement)
    return '\n'.join(new_lines)


async def _bg_attachment_enhance(
    article_id: str, uploaded_files: list[dict], need_title: bool,
) -> None:
    """Background: describe media files via vision/ASR, then extract tags+entities+title."""
    from app.database import SessionLocal as _SessionLocal
    import asyncio as _asyncio

    db2 = _SessionLocal()
    try:
        art = db2.query(Article).filter(Article.id == article_id).first()
        if not art:
            return

        full_text = art.content or ""
        has_media = False

        logger.info(
            "[BG_ATTACH] Starting for article %s with %d files: %s",
            article_id, len(uploaded_files),
            [uf["filename"] for uf in uploaded_files],
        )
        # Step A: Parse documents and describe media files
        for uf in uploaded_files:
            ext = Path(uf["filename"]).suffix.lower()
            storage_name = Path(uf["storage_path"]).name

            # ── Document parsing (async) ──
            if ext in (TEXT_EXTENSIONS | WORD_EXTENSIONS | EXCEL_EXTENSIONS | PPT_EXTENSIONS | PDF_EXTENSIONS):
                try:
                    if ext in TEXT_EXTENSIONS:
                        with open(uf["storage_path"], "rb") as f:
                            parsed = parse_text_from_bytes(f.read())
                    elif ext in WORD_EXTENSIONS:
                        parsed = await _asyncio.to_thread(parse_docx, uf["storage_path"])
                    elif ext in EXCEL_EXTENSIONS and ext != '.csv':
                        parsed = await _asyncio.to_thread(parse_xlsx, uf["storage_path"])
                    elif ext in PPT_EXTENSIONS:
                        parsed = await _asyncio.to_thread(parse_pptx, uf["storage_path"])
                    elif ext in PDF_EXTENSIONS:
                        parsed = await _asyncio.to_thread(parse_pdf, uf["storage_path"])
                    else:
                        parsed = ""
                    if parsed:
                        # Replace placeholder div with parsed text
                        placeholder = f'<div data-attachment="{uf["filename"]}"'
                        idx = full_text.find(placeholder)
                        if idx >= 0:
                            end_idx = full_text.find('</div>', idx)
                            if end_idx >= 0:
                                full_text = full_text[:idx] + parsed + full_text[end_idx + 6:]
                except Exception as e:
                    logger.warning(f"[BG_ATTACH] Document parsing failed for {uf['filename']}: {e}")
                continue

            # ── Media files (image/video/audio) ──
            if ext not in IMAGE_EXTENSIONS | AUDIO_EXTENSIONS | VIDEO_EXTENSIONS:
                continue
            has_media = True
            try:
                if ext in IMAGE_EXTENSIONS:
                    desc = await parse_image(uf["storage_path"], uf["filename"])
                    full_text = _replace_media_placeholder(full_text, storage_name, desc)
                elif ext in VIDEO_EXTENSIONS:
                    # Preserve poster and alt from THIS file's placeholder
                    poster_url = ""
                    alt_name = uf["filename"]
                    for line in full_text.split('\n'):
                        if storage_name in line and '<video' in line:
                            pm = re.search(r'poster="([^"]*)"', line, re.IGNORECASE)
                            if pm:
                                poster_url = pm.group(1)
                            am = re.search(r'alt="([^"]*)"', line, re.IGNORECASE)
                            if am:
                                alt_name = am.group(1)
                            break
                    desc = await parse_video(uf["storage_path"], uf["filename"])
                    if poster_url:
                        desc = desc.replace(
                            '<video controls src=',
                            f'<video controls poster="{poster_url}" src=',
                        )
                    if alt_name:
                        desc = desc.replace(
                            '<video controls ',
                            f'<video controls alt="{alt_name}" ',
                        )
                    full_text = _replace_media_placeholder(full_text, storage_name, desc)
                elif ext in AUDIO_EXTENSIONS:
                    with open(uf["storage_path"], "rb") as f:
                        audio_bytes = f.read()
                    desc = await parse_media(audio_bytes, uf["filename"], uf["content_type"])
                    full_text = full_text + "\n\n" + desc if full_text else desc
            except Exception as e:
                logger.warning(f"[BG_ATTACH] Media description failed for {uf['filename']}: {e}")

        # Step B: Generate title + extract tags/entities in parallel
        title_task = generate_title(full_text) if need_title else None
        extract_task = _asyncio.to_thread(extract_tags_and_entities, full_text)

        if title_task:
            (bg_tags, bg_entities), generated_title = await _asyncio.gather(
                extract_task, title_task,
            )
        else:
            bg_tags, bg_entities = await extract_task

        # Re-fetch article (may have been modified)
        art = db2.query(Article).filter(Article.id == article_id).first()
        if not art:
            return

        # Apply title
        if need_title:
            if generated_title and len(generated_title) >= 4:
                art.title = generated_title
            elif art.title == "无标题" and uploaded_files:
                art.title = uploaded_files[0]["filename"]  # fallback to first filename

        # Apply tags + entities
        if bg_tags or bg_entities:
            if bg_tags:
                existing_tags = json.loads(art.tags) if art.tags else []
                merged = list(dict.fromkeys([*existing_tags, *bg_tags]))
                art.tags = json.dumps(merged, ensure_ascii=False)
            if isinstance(bg_entities, dict) and bg_entities:
                bg_entities = _annotate_entity_creator(bg_entities, art.created_by or "")
                art.entities = json.dumps(bg_entities, ensure_ascii=False)

        # Apply enriched content (media descriptions + document parsing)
        if full_text != (art.content or ""):
            art.content = full_text

        art.processing = None
        db2.commit()
        logger.info(f"[BG_ATTACH] article {article_id} processing complete")
    except Exception as e:
        logger.warning(f"[BG_ATTACH] Failed: {e}")
        try:
            art = db2.query(Article).filter(Article.id == article_id).first()
            if art:
                art.processing = None
                db2.commit()
        except Exception:
            pass
    finally:
        db2.close()


@router.post("", response_model=ArticleResponse, status_code=201)
async def create_article(
    title: str = Form(default="", max_length=200),
    content: str = Form(default=""),
    category_id: str = Form(default=""),
    tags: str = Form(default="[]"),
    files: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    user_cn = cert.display_name or ""
    # Parse tags from JSON string (Form data)
    try:
        user_tags: list[str] = json.loads(tags) if isinstance(tags, str) else (tags or [])
    except (json.JSONDecodeError, TypeError):
        user_tags = []
    user_tags = list(dict.fromkeys(user_tags))  # dedup, preserve order
    user_title = title.strip()

    # Handle file uploads
    attachment_path = None
    attachment_name = None
    attachment_type = None
    initial_content = content
    storage_paths: list[str] = []  # track paths for background enhancement
    uploaded_files: list[dict] = []  # track file info for background enhancement

    for upload_file in files:
        if not upload_file.filename:
            continue
        ext = Path(upload_file.filename).suffix.lower()
        content_bytes = await upload_file.read()
        safe_fname = re.sub(r'[^\w.\-]', '_', upload_file.filename)
        safe_name = f"{uuid.uuid4().hex}_{safe_fname}"
        storage_path = UPLOAD_DIR / safe_name
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with open(storage_path, "wb") as f:
            f.write(content_bytes)

        storage_paths.append(str(storage_path))
        uploaded_files.append({
            "filename": upload_file.filename,
            "content_type": upload_file.content_type or "",
            "storage_path": str(storage_path),
        })

        if not attachment_path:  # first file → attachment fields
            attachment_path = str(safe_name)
            attachment_name = upload_file.filename
            attachment_type = upload_file.content_type or ""

        # Generate initial content for this file (media tags or placeholder for documents)
        try:
            media_src = f"/api/media/{safe_name}"
            if ext in IMAGE_EXTENSIONS:
                img_tag = f'<img src="{media_src}" alt="{upload_file.filename}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
                initial_content = f"{initial_content}\n\n{img_tag}" if initial_content else img_tag
            elif ext in AUDIO_EXTENSIONS:
                audio_tag = f'<audio controls src="{media_src}" alt="{upload_file.filename}" style="width:100%"></audio>'
                initial_content = f"{initial_content}\n\n{audio_tag}" if initial_content else audio_tag
            elif ext in VIDEO_EXTENSIONS:
                poster = ""
                try:
                    thumb_name = safe_name + ".thumb.jpg"
                    if _extract_video_thumbnail(str(storage_path), str(UPLOAD_DIR / thumb_name)):
                        poster = f' poster="/api/media/{thumb_name}"'
                except Exception:
                    pass
                video_tag = f'<video controls src="{media_src}"{poster} alt="{upload_file.filename}" style="width:100%"></video>'
                initial_content = f"{initial_content}\n\n{video_tag}" if initial_content else video_tag
            else:
                # Document type — placeholder, parsed async in background
                doc_placeholder = f'<div data-attachment="{upload_file.filename}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {upload_file.filename}（解析中…）</div>'
                # Persistent marker so the frontend can always discover document attachments
                doc_marker = f'<!-- doc-attachment: {upload_file.filename} | {safe_name} -->'
                initial_content = f"{initial_content}\n\n{doc_placeholder}\n{doc_marker}" if initial_content else f"{doc_placeholder}\n{doc_marker}"
        except Exception as e:
            logger.warning(f"File parsing failed for {upload_file.filename}: {e}")

    # Track upload order for frontend sorting
    if uploaded_files:
        order_list = ", ".join(uf["filename"] for uf in uploaded_files)
        initial_content += f"\n\n<!-- attachments-order: {order_list} -->"

    article = Article(
        title=user_title or "无标题",
        content=initial_content,
        category_id=category_id or None,
        tags=json.dumps(user_tags, ensure_ascii=False),
        entities=None,
        processing="processing" if len(uploaded_files) > 0 or initial_content.strip() else None,
        attachment_path=attachment_path,
        attachment_name=attachment_name,
        attachment_type=attachment_type,
        created_by=user_cn or None,
    )
    db.add(article)
    db.commit()
    db.refresh(article)

    # Launch background enrichment
    if len(uploaded_files) > 0:
        asyncio.create_task(_bg_attachment_enhance(
            article.id, uploaded_files, need_title=not user_title,
        ))
    elif initial_content.strip():
        # No files, just text content — lightweight background extraction
        asyncio.create_task(_bg_extract(article.id, user_tags, need_title=not user_title))

    return article


@router.put("/{article_id}", response_model=ArticleResponse)
async def update_article(
    article_id: str = PathParam(..., max_length=36),
    title: str = Form(default=""),
    content: str = Form(default=""),
    category_id: str = Form(default=""),
    tags: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    keep_attachments: str = Form(default=""),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    _validate_article_id(article_id)
    user_cn = cert.display_name or ""
    # Parse keep list — only these existing attachments should be preserved.
    # keep_attachments="" means "not provided" (keep all for backward compat).
    # keep_attachments="[...]" means the frontend explicitly sent the list.
    keep_list: list[str] | None = None  # None = not provided, keep all
    if keep_attachments:
        try:
            keep_list = json.loads(keep_attachments)
        except (json.JSONDecodeError, TypeError):
            pass
    # Use a mutable list (NOT a set) so same-named attachments consume distinct slots.
    keep_remaining: list[str] | None = (list(keep_list) if keep_list is not None else None)

    def _consume_keep(name: str) -> bool:
        """Return True if `name` should be kept, consuming one occurrence from the list."""
        if keep_remaining is None:
            return True  # keep all (no filter provided)
        try:
            keep_remaining.remove(name)
            return True
        except ValueError:
            return False

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    # Only the creator can edit
    if article.created_by and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有文章创建人可以编辑该文章")

    # Parse tags
    try:
        user_tags: list[str] = json.loads(tags) if tags else []
    except (json.JSONDecodeError, TypeError):
        user_tags = []
    user_tags = list(dict.fromkeys(user_tags))

    # Compare against stored content with media tags stripped — the editor
    # displays clean content, so an unchanged article would otherwise appear changed.
    stored_clean = re.sub(
        r'<(?:img|video|audio)\b[^>]*/?>\s*|<\/(?:video|audio)>\s*', '',
        article.content or "", flags=re.IGNORECASE,
    )
    stored_clean = re.sub(r'<!-- doc-attachment: .+? -->\s*', '', stored_clean, flags=re.IGNORECASE)
    stored_clean = re.sub(r'<div data-attachment="[^"]*"[^>]*>[\s\S]*?</div>\s*', '', stored_clean, flags=re.IGNORECASE)
    stored_clean = re.sub(r'<!-- attachments-order: .+? -->\s*', '', stored_clean, flags=re.IGNORECASE)
    content_changed = content.strip() != stored_clean.strip()

    # Check if anything actually needs updating
    has_files = any(f and f.filename for f in files)
    has_content_change = content_changed
    has_title_change = bool(title.strip() and title.strip() != (article.title or ""))
    has_category_change = bool(category_id and category_id != (article.category_id or ""))
    tags_changed = bool(tags and json.dumps(user_tags, ensure_ascii=False) != (article.tags or "[]"))
    has_attachment_change = False
    if keep_list is not None:
        existing_ids: list[str] = []
        for m in re.finditer(r'<(img|video|audio)\b[^>]*>', article.content or "", re.IGNORECASE):
            tag = m.group(0)
            a = (re.search(r'alt="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            s = (re.search(r'src="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            existing_ids.append(a or (s.split('/')[-1].split('?')[0] if s else ''))
        # Include doc-attachment marker names
        for dm in re.finditer(r'<!-- doc-attachment: (.+?) \|', article.content or "", re.IGNORECASE):
            existing_ids.append(dm.group(1).strip())
        # Include legacy document attachment name
        if article.attachment_name:
            existing_ids.append(article.attachment_name)
        has_attachment_change = (sorted(existing_ids) != sorted(keep_list))

    if not has_files and not has_content_change and not has_title_change \
            and not has_category_change and not tags_changed and not has_attachment_change:
        return article

    # Something changed — apply basic field updates
    article.title = title.strip() or article.title
    article.category_id = category_id or None
    if tags:
        article.tags = json.dumps(user_tags, ensure_ascii=False)

    # Preserve old media tags from the original article — but only for
    # attachments the user chose to keep (via `keep_attachments`).
    # This runs even when content didn't change, to handle attachment removal.
    if keep_remaining is not None:
        # Capture doc-attachment markers & order from original content BEFORE we overwrite it
        kept_doc_markers: list[str] = []
        for m in re.finditer(
            r'<!-- doc-attachment: (.+?) \| (.+?) -->',
            article.content or "", re.IGNORECASE,
        ):
            filename = m.group(1).strip()
            if _consume_keep(filename):
                kept_doc_markers.append(m.group(0))

        # Capture original order list (filtered later, after we know what was kept)
        order_match = re.search(r'<!-- attachments-order: (.+?) -->', article.content or "")
        all_order: list[str] = []
        if order_match:
            all_order = [n.strip() for n in order_match.group(1).split(',')]

        # Strip all media tags (including closing) to get text body
        # If content was explicitly changed (even to empty), use the new content
        text_body = content if content_changed else re.sub(
            r'<(?:img|video|audio)\b[^>]*/?>\s*|<\/(?:video|audio)>\s*', '',
            article.content or "", flags=re.IGNORECASE,
        ).strip()
        # Strip doc-attachment markers and placeholder divs from text_body
        text_body = re.sub(
            r'<!-- doc-attachment: .+? -->\s*', '',
            text_body, flags=re.IGNORECASE,
        )
        text_body = re.sub(
            r'<div data-attachment="[^"]*"[^>]*>[\s\S]*?</div>\s*', '',
            text_body, flags=re.IGNORECASE,
        )
        # Strip attachments-order markers
        text_body = re.sub(
            r'<!-- attachments-order: .+? -->\s*', '',
            text_body, flags=re.IGNORECASE,
        ).strip()

        # Extract complete media blocks (opening tag + optional closing tag)
        kept_tags: list[str] = []
        for m in re.finditer(
            r'<(img|video|audio)\b[^>]*>',
            article.content or "", re.IGNORECASE,
        ):
            tag = m.group(0)
            tag_name = m.group(1).lower()
            # Get identifier: alt (img) or filename from src (video/audio)
            alt = (re.search(r'alt="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            src = (re.search(r'src="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            identifier = alt or (src.split('/')[-1].split('?')[0] if src else '')
            if not _consume_keep(identifier):
                continue  # user removed this attachment
            full_tag = tag
            if tag_name in ('video', 'audio'):
                # Find the matching closing tag after this position
                rest = article.content[m.end():]
                close_match = re.search(r'</' + tag_name + r'>', rest, re.IGNORECASE)
                if close_match:
                    full_tag = tag + rest[:close_match.end()]
            kept_tags.append(full_tag.strip())

        # Also handle document attachment removal (no media tag in content)
        if article.attachment_name and not _consume_keep(article.attachment_name):
            article.attachment_name = None
            article.attachment_path = None
            article.attachment_type = None

        # Filter order list: keep entries matching actually-kept items.
        # Use consumption so duplicate names match distinct slots.
        kept_item_names: list[str] = []
        for tag in kept_tags:
            alt = (re.search(r'alt="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            s = (re.search(r'src="([^"]*)"', tag, re.IGNORECASE) or [None, ''])[1]
            kept_item_names.append(alt or (s.split('/')[-1].split('?')[0] if s else ''))
        for marker in kept_doc_markers:
            nm = re.search(r'<!-- doc-attachment: (.+?) \|', marker)
            if nm:
                kept_item_names.append(nm.group(1).strip())
        if article.attachment_name:
            kept_item_names.append(article.attachment_name)

        order_remaining = list(kept_item_names)
        kept_order: list[str] = []
        for n in all_order:
            try:
                order_remaining.remove(n)
                kept_order.append(n)
            except ValueError:
                pass

        # Build final content
        parts = [text_body]
        if kept_tags:
            parts.append('\n\n'.join(kept_tags))
        if kept_doc_markers:
            parts.append('\n'.join(kept_doc_markers))
        if kept_order:
            parts.append(f'<!-- attachments-order: {", ".join(kept_order)} -->')
        article.content = '\n\n'.join(parts)
    elif content_changed and content:
        # No keep_attachments filter — preserve ALL old tags (backward compat)
        old_tags = re.findall(
            r'<(?:img|video|audio)\s[^>]*/?>',
            article.content or "", re.IGNORECASE,
        )
        old_doc_markers = re.findall(
            r'<!-- doc-attachment: .+? -->',
            article.content or "", re.IGNORECASE,
        )
        old_order = re.findall(
            r'<!-- attachments-order: .+? -->',
            article.content or "", re.IGNORECASE,
        )
        parts = [content.rstrip()]
        if old_tags:
            parts.append('\n\n'.join(old_tags))
        if old_doc_markers:
            parts.append('\n'.join(old_doc_markers))
        if old_order:
            parts.append(old_order[0])
        article.content = '\n\n'.join(parts)
    elif content_changed and not content:
        # Content cleared by user — remove everything including media tags
        article.content = ""
    elif content:
        article.content = content
    # else: no content sent → keep existing article.content

    # Handle file uploads for edit
    uploaded_files: list[dict] = []
    if files:
        for upload_file in files:
            if not upload_file.filename:
                continue
            ext = Path(upload_file.filename).suffix.lower()
            content_bytes = await upload_file.read()
            safe_fname = re.sub(r'[^\w.\-]', '_', upload_file.filename)
            safe_name = f"{uuid.uuid4().hex}_{safe_fname}"
            storage_path = UPLOAD_DIR / safe_name
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            with open(storage_path, "wb") as f:
                f.write(content_bytes)

            uploaded_files.append({
                "filename": upload_file.filename,
                "content_type": upload_file.content_type or "",
                "storage_path": str(storage_path),
            })

            # Update attachment fields on first file if not already set
            if not article.attachment_path:
                article.attachment_path = str(safe_name)
                article.attachment_name = upload_file.filename
                article.attachment_type = upload_file.content_type or ""

            # Generate initial content for this file
            try:
                media_src = f"/api/media/{safe_name}"
                current = article.content or ""
                if ext in IMAGE_EXTENSIONS:
                    img_tag = f'<img src="{media_src}" alt="{upload_file.filename}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
                    article.content = f"{current}\n\n{img_tag}" if current else img_tag
                elif ext in AUDIO_EXTENSIONS:
                    audio_tag = f'<audio controls src="{media_src}" alt="{upload_file.filename}" style="width:100%"></audio>'
                    article.content = f"{current}\n\n{audio_tag}" if current else audio_tag
                elif ext in VIDEO_EXTENSIONS:
                    poster = ""
                    try:
                        thumb_name = safe_name + ".thumb.jpg"
                        if _extract_video_thumbnail(str(storage_path), str(UPLOAD_DIR / thumb_name)):
                            poster = f' poster="/api/media/{thumb_name}"'
                    except Exception:
                        pass
                    video_tag = f'<video controls src="{media_src}"{poster} alt="{upload_file.filename}" style="width:100%"></video>'
                    article.content = f"{current}\n\n{video_tag}" if current else video_tag
                else:
                    # Document — placeholder, parsed async in background
                    doc_placeholder = f'<div data-attachment="{upload_file.filename}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {upload_file.filename}（解析中…）</div>'
                    # Persistent marker so the frontend can always discover document attachments
                    doc_marker = f'<!-- doc-attachment: {upload_file.filename} | {safe_name} -->'
                    article.content = f"{current}\n\n{doc_placeholder}\n{doc_marker}" if current else f"{doc_placeholder}\n{doc_marker}"
            except Exception as e:
                logger.warning(f"File parsing failed for {upload_file.filename}: {e}")

    # Track upload order — merge with any existing order from previous uploads
    if uploaded_files:
        existing = re.findall(r'<!-- attachments-order: (.+?) -->', article.content or "")
        all_order = existing[0].split(", ") if existing else []
        # If no existing order comment, prepend names from kept existing attachments
        # (so legacy articles don't have their original file pushed to the end).
        if not existing:
            for tag in re.finditer(r'<(img|video|audio)\b[^>]*>', article.content or "", re.IGNORECASE):
                t = tag.group(0)
                a = (re.search(r'alt="([^"]*)"', t, re.IGNORECASE) or [None, ''])[1]
                s = (re.search(r'src="([^"]*)"', t, re.IGNORECASE) or [None, ''])[1]
                name = a or (s.split('/')[-1].split('?')[0] if s else '')
                if name and name not in all_order:
                    all_order.append(name)
            for dm in re.finditer(r'<!-- doc-attachment: (.+?) \|', article.content or "", re.IGNORECASE):
                name = dm.group(1).strip()
                if name and name not in all_order:
                    all_order.append(name)
            if article.attachment_name and article.attachment_name not in all_order:
                # Only add if there's still an attachment (wasn't removed in keep_set processing)
                all_order.append(article.attachment_name)
        all_order.extend(uf["filename"] for uf in uploaded_files)
        # Remove old order comment(s) and append consolidated one
        article.content = re.sub(
            r'\n*<!-- attachments-order: .+? -->\n*', '\n',
            article.content or "", flags=re.IGNORECASE,
        ).strip()
        article.content += f"\n\n<!-- attachments-order: {', '.join(all_order)} -->"

    if len(uploaded_files) > 0:
        article.processing = "processing"
    elif article.processing != "processing":
        article.processing = None  # don't clear processing set by text extraction
    db.commit()
    db.refresh(article)

    # Launch background enrichment for new files
    if len(uploaded_files) > 0:
        asyncio.create_task(_bg_attachment_enhance(
            article.id, uploaded_files, need_title=False,
        ))
    elif content and content_changed and article.content.strip():
        article.processing = "processing"
        db.commit()
        asyncio.create_task(_bg_extract(article.id, user_tags, need_title=False))

    return article


@router.get("/{article_id}/download")
def download_attachment(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
):
    """Download the original attachment file for an article."""
    _validate_article_id(article_id)

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    if not article.attachment_path:
        raise HTTPException(status_code=404, detail="No attachment for this article")

    # Resolve file path — attachment_path stores the safe filename
    file_path = UPLOAD_DIR / article.attachment_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Attachment file not found on disk")

    # Use the original filename for the download, fall back to stored name
    download_name = article.attachment_name or file_path.name

    return FileResponse(
        path=str(file_path),
        filename=download_name,
        media_type="application/octet-stream",
    )


@router.post("/{article_id}/reprocess", response_model=ArticleResponse)
async def reprocess_article(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """Manually re-parse all attachments and re-extract tags/entities (creator only)."""
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    user_cn = cert.display_name or ""
    if article.created_by and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有文章创建人可以重新解析")

    if article.processing == "processing":
        raise HTTPException(status_code=409, detail="文章正在解析中，请稍候")

    # Rebuild uploaded_files list from attachment markers in content
    uploaded_files: list[dict] = []
    for m in re.finditer(r'<!-- doc-attachment: (.+?) \| (.+?) -->', article.content or "", re.IGNORECASE):
        safe_name = m.group(2).strip()
        storage_path = UPLOAD_DIR / safe_name
        if storage_path.exists():
            uploaded_files.append({
                "filename": m.group(1).strip(),
                "content_type": "",
                "storage_path": str(storage_path),
            })

    # Also collect media files from <img>/<video>/<audio> tags
    for m in re.finditer(r'<(?:img|video|audio)\b[^>]*src="([^"]+)"', article.content or "", re.IGNORECASE):
        src = m.group(1)
        fname = src.rsplit("/", 1)[-1].split("?")[0]
        storage_path = UPLOAD_DIR / fname
        if storage_path.exists() and fname not in {uf["filename"] for uf in uploaded_files}:
            uploaded_files.append({
                "filename": fname,
                "content_type": "",
                "storage_path": str(storage_path),
            })

    article.processing = "processing"
    db.commit()

    asyncio.create_task(_bg_attachment_enhance(
        article.id, uploaded_files, need_title=False,
    ))
    return article


@router.post("/{article_id}/reprocess/{safe_name}", response_model=ArticleResponse)
async def reprocess_single_attachment(
    article_id: str = PathParam(..., max_length=36),
    safe_name: str = PathParam(...),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """Manually re-parse a single attachment (creator only)."""
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    user_cn = cert.display_name or ""
    if article.created_by and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有文章创建人可以重新解析")

    if article.processing == "processing":
        raise HTTPException(status_code=409, detail="文章正在解析中，请稍候")

    # Validate safe_name to prevent path traversal
    if "/" in safe_name or "\\" in safe_name or ".." in safe_name:
        raise HTTPException(status_code=400, detail="Invalid file name")

    storage_path = UPLOAD_DIR / safe_name
    if not storage_path.exists():
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Determine original filename from content markers
    original_name = safe_name
    for m in re.finditer(r'<!-- doc-attachment: (.+?) \| (.+?) -->', article.content or "", re.IGNORECASE):
        if m.group(2).strip() == safe_name:
            original_name = m.group(1).strip()
            break

    article.processing = f"processing:{safe_name}"
    db.commit()

    asyncio.create_task(_bg_attachment_enhance(
        article.id,
        [{"filename": original_name, "content_type": "", "storage_path": str(storage_path)}],
        need_title=False,
    ))
    return article


@router.delete("/{article_id}", status_code=204)
def delete_article(
    article_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    _validate_article_id(article_id)
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    user_cn = cert.display_name or ""
    if article.created_by and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有文章创建人可以删除该文章")

    # Collect entity names from this article before deleting
    entity_names: set[str] = set()
    if article.entities:
        try:
            ent_data = json.loads(article.entities)
            for e in ent_data.get("entities", []):
                name = e.get("name", "")
                if name:
                    entity_names.add(name)
        except (json.JSONDecodeError, TypeError):
            pass

    db.delete(article)
    db.commit()

    # Clean up entity_infos that no longer appear in any article
    if entity_names:
        still_used: set[str] = set()
        all_articles = db.query(Article.entities).filter(Article.entities.isnot(None)).all()
        for (ent_str,) in all_articles:
            try:
                ent_data = json.loads(ent_str) if isinstance(ent_str, str) else ent_str
                for e in ent_data.get("entities", []):
                    name = e.get("name", "")
                    if name:
                        still_used.add(name)
            except (json.JSONDecodeError, TypeError):
                pass
        orphaned = entity_names - still_used
        if orphaned:
            db.query(EntityInfo).filter(EntityInfo.entity_name.in_(orphaned)).delete(synchronize_session=False)
            db.commit()
            logger.info(f"Cleaned up entity_infos for orphaned entities: {orphaned}")

    # Invalidate knowledge graph cache
    from app.routes.graph import invalidate_graph_cache
    invalidate_graph_cache()

    return None
