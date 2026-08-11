import json
import asyncio
import logging
import os
import re
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Path as PathParam, UploadFile, File, Form
from sqlalchemy.orm import Session
from sqlalchemy import desc
from app.dependencies import get_db
from app.database import SessionLocal
from app.models import Article, Comment, utcnow
from app.schemas import CommentCreate, CommentUpdate, CommentResponse
from app.auth import get_client_cert, CertInfo
from app.llm_extract import extract_tags_and_entities
from app.routes.graph import invalidate_graph_cache
from app.routes.upload import (
    parse_text_from_bytes, parse_docx, parse_xlsx, parse_pptx, parse_pdf,
    parse_image, parse_video, parse_media,
    TEXT_EXTENSIONS, WORD_EXTENSIONS, EXCEL_EXTENSIONS, PPT_EXTENSIONS,
    PDF_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
)
from app.routes.qa import _extract_video_thumbnail

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/articles/{article_id}/comments",
    tags=["comments"],
)

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads"))


# ─── Helpers ────────────────────────────────────────

def _merge_entities_into_article(article: Article, comment_entities: dict) -> bool:
    """Merge comment-extracted entities into article.entities JSON (dedup by name)."""
    try:
        art_entities = json.loads(article.entities) if article.entities else None
    except (json.JSONDecodeError, TypeError):
        art_entities = None

    if not comment_entities:
        return False

    art_ents = art_entities.get("entities", []) if isinstance(art_entities, dict) else []
    art_rels = art_entities.get("relations", []) if isinstance(art_entities, dict) else []
    comm_ents = comment_entities.get("entities", [])
    comm_rels = comment_entities.get("relations", [])

    seen_names = {(e.get("name"), e.get("type")) for e in art_ents}
    seen_rels = {(r.get("source"), r.get("target"), r.get("label")) for r in art_rels}

    changed = False
    for e in comm_ents:
        key = (e.get("name"), e.get("type"))
        if key not in seen_names:
            seen_names.add(key)
            art_ents.append(e)
            changed = True
    for r in comm_rels:
        key = (r.get("source"), r.get("target"), r.get("label"))
        if key not in seen_rels:
            seen_rels.add(key)
            art_rels.append(r)
            changed = True

    if changed:
        merged = {"entities": art_ents, "relations": art_rels}
        article.entities = json.dumps(merged, ensure_ascii=False)
    return changed


def _subtract_comment_from_article(article: Article, comment: Comment) -> bool:
    """Remove a single comment's entities from the article (tags are kept per-comment)."""
    changed = False

    # Subtract entities
    try:
        comm_entities = json.loads(comment.entities) if comment.entities else None
    except (json.JSONDecodeError, TypeError):
        comm_entities = None
    try:
        art_entities = json.loads(article.entities) if article.entities else None
    except (json.JSONDecodeError, TypeError):
        art_entities = None

    if isinstance(comm_entities, dict) and isinstance(art_entities, dict):
        comm_ent_names = {(e.get("name"), e.get("type")) for e in comm_entities.get("entities", [])}
        comm_rel_keys = {(r.get("source"), r.get("target"), r.get("label")) for r in comm_entities.get("relations", [])}
        art_ents = art_entities.get("entities", [])
        art_rels = art_entities.get("relations", [])

        new_ents = [e for e in art_ents if (e.get("name"), e.get("type")) not in comm_ent_names]
        new_rels = [r for r in art_rels if (r.get("source"), r.get("target"), r.get("label")) not in comm_rel_keys]

        if len(new_ents) != len(art_ents) or len(new_rels) != len(art_rels):
            article.entities = json.dumps({"entities": new_ents, "relations": new_rels}, ensure_ascii=False)
            changed = True

    return changed


def _rebuild_article_entities_from_comments(article: Article, db: Session) -> bool:
    """Rebuild article entities from article's own content-entities + all comment entities."""
    try:
        art_entities = json.loads(article.entities) if article.entities else None
    except (json.JSONDecodeError, TypeError):
        art_entities = None

    # Rebuild from article's own base entities + all comments
    comments = db.query(Comment).filter(Comment.article_id == article.id).all()
    merged = {"entities": [], "relations": []}
    seen_names = set()
    seen_rels = set()

    def add_from(src):
        if not isinstance(src, dict):
            return
        for e in src.get("entities", []):
            key = (e.get("name"), e.get("type"))
            if key not in seen_names:
                seen_names.add(key)
                merged["entities"].append(e)
        for r in src.get("relations", []):
            key = (r.get("source"), r.get("target"), r.get("label"))
            if key not in seen_rels:
                seen_rels.add(key)
                merged["relations"].append(r)

    # Apply article's own base entities first (from content, not from comments)
    if art_entities:
        add_from(art_entities)

    for c in comments:
        try:
            comm_entities = json.loads(c.entities) if c.entities else None
        except (json.JSONDecodeError, TypeError):
            comm_entities = None
        if comm_entities:
            add_from(comm_entities)

    article.entities = json.dumps(merged, ensure_ascii=False)
    return True


# ─── Embedding helper ────────────────────────────────

async def _embed_comment_content(comment, db) -> None:
    """Create/update ArticleChunk rows for a comment so it appears in Q&A search."""
    try:
        from app.models import ArticleChunk
        from app.routes.qa import chunk_article, get_embedding
        import json as _json

        # Delete old chunks for this comment
        db.query(ArticleChunk).filter(
            ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
        ).delete()

        clean = re.sub(r'<[^>]*>', '', comment.content or '')
        clean = re.sub(r'<!--.*?-->', '', clean)
        clean = re.sub(r'\s+', ' ', clean).strip()
        if not clean:
            return

        chunks = chunk_article(clean)
        for i, chunk_text in enumerate(chunks):
            idx = f"comment.{comment.id[:8]}.{i}"
            try:
                vec = await get_embedding(chunk_text)
                db.add(ArticleChunk(
                    article_id=comment.article_id,
                    chunk_index=idx,
                    chunk_text=f"[评论] {chunk_text}",
                    embedding=_json.dumps(vec),
                ))
            except Exception:
                pass
        db.commit()
    except Exception:
        logger.warning("[EMBED_COMMENT] Failed to embed comment %s", comment.id, exc_info=True)


# ─── Background task ────────────────────────────────

async def _bg_comment_process(
    comment_id: str, article_id: str,
    file_infos: list[dict], need_extract: bool,
) -> None:
    """Background: parse uploaded files → append text to comment, then extract tags+entities."""
    db2 = SessionLocal()
    try:
        comment = db2.query(Comment).filter(Comment.id == comment_id).first()
        if not comment:
            return
        article = db2.query(Article).filter(Article.id == article_id).first()
        if not article:
            return

        full_text = comment.content or ""
        has_changes = False

        # Step A: Parse uploaded files
        for uf in file_infos:
            ext = Path(uf["filename"]).suffix.lower()
            storage_name = Path(uf["storage_path"]).name
            try:
                if ext in TEXT_EXTENSIONS:
                    with open(uf["storage_path"], "rb") as f:
                        parsed = parse_text_from_bytes(f.read())
                elif ext in WORD_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_docx, uf["storage_path"])
                elif ext in EXCEL_EXTENSIONS and ext != '.csv':
                    parsed = await asyncio.to_thread(parse_xlsx, uf["storage_path"])
                elif ext in PPT_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_pptx, uf["storage_path"])
                elif ext in PDF_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_pdf, uf["storage_path"])
                elif ext in IMAGE_EXTENSIONS:
                    parsed = await parse_image(uf["storage_path"], uf["filename"])
                elif ext in VIDEO_EXTENSIONS:
                    parsed = await parse_video(uf["storage_path"], uf["filename"])
                elif ext in AUDIO_EXTENSIONS:
                    with open(uf["storage_path"], "rb") as f:
                        audio_bytes = f.read()
                    parsed = await parse_media(audio_bytes, uf["filename"], uf["content_type"])
                else:
                    parsed = ""

                if parsed:
                    # Replace placeholder div
                    placeholder = f'<div data-attachment="{uf["filename"]}"'
                    idx = full_text.find(placeholder)
                    if idx >= 0:
                        end_idx = full_text.find('</div>', idx)
                        if end_idx >= 0:
                            full_text = full_text[:idx] + parsed + full_text[end_idx + 6:]
                            has_changes = True
                    else:
                        # For media types, append
                        full_text = full_text + "\n\n" + parsed if full_text else parsed
                        has_changes = True
            except Exception as e:
                logger.warning(f"[BG_COMMENT] File parsing failed for {uf['filename']}: {e}")

        # Step B: Extract tags + entities if there's content
        if need_extract and full_text.strip():
            try:
                llm_tags, entities = await asyncio.to_thread(
                    extract_tags_and_entities, full_text.strip(),
                )
            except Exception as e:
                logger.warning(f"[BG_COMMENT] LLM extraction failed: {e}")
                llm_tags, entities = [], None

            # Re-fetch
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if not comment:
                return
            article = db2.query(Article).filter(Article.id == article_id).first()
            if not article:
                return

            if has_changes:
                comment.content = full_text

            if llm_tags:
                comment.tags = json.dumps(llm_tags, ensure_ascii=False)
            if isinstance(entities, dict) and entities:
                # Annotate entity items with comment creator
                now_str = utcnow().isoformat()
                for e in entities.get("entities", []):
                    if not e.get("created_by"):
                        e["created_by"] = comment.created_by or ""
                        e["created_at"] = now_str
                comment.entities = json.dumps(entities, ensure_ascii=False)
                _merge_entities_into_article(article, entities)

            comment.processing = None
            db2.commit()
            invalidate_graph_cache()
            # Embed comment content for Q&A
            await _embed_comment_content(comment, db2)
            logger.info(
                "[BG_COMMENT] comment %s processed: %d tags, %d entities",
                comment_id, len(llm_tags or []),
                len((entities or {}).get("entities", [])) if isinstance(entities, dict) else 0,
            )
        else:
            # No LLM extraction needed, just update content
            if has_changes:
                comment = db2.query(Comment).filter(Comment.id == comment_id).first()
                if comment:
                    comment.content = full_text
                    comment.processing = None
                    db2.commit()
                    await _embed_comment_content(comment, db2)
    except Exception as e:
        logger.warning(f"[BG_COMMENT] Failed: {e}")
        try:
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if comment:
                comment.processing = None
                db2.commit()
        except Exception:
            pass
    finally:
        db2.close()


# ─── Routes ──────────────────────────────────────────


@router.get("", response_model=list[CommentResponse])
def list_comments(
    article_id: str = PathParam(..., max_length=36),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """List comments for an article (newest first)."""
    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    comments = (
        db.query(Comment)
        .filter(Comment.article_id == article_id)
        .order_by(desc(Comment.created_at), desc(Comment.id))
        .offset(skip)
        .limit(limit)
        .all()
    )
    return comments


@router.post("", response_model=CommentResponse, status_code=201)
async def create_comment(
    article_id: str = PathParam(..., max_length=36),
    content: str = Form(default="", max_length=2000),
    tags: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """Create a comment on an article. Supports file uploads and manual tags."""
    user_cn = cert.display_name or ""

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    if not content.strip() and not files:
        raise HTTPException(status_code=400, detail="评论内容不能为空")

    if len(content) > 500:
        raise HTTPException(status_code=400, detail="评论内容不能超过2000字")

    # Parse manual tags
    try:
        user_tags: list[str] = json.loads(tags) if isinstance(tags, str) and tags else []
    except (json.JSONDecodeError, TypeError):
        user_tags = []
    user_tags = list(dict.fromkeys([t.strip() for t in user_tags if t.strip()]))

    # Handle file uploads
    attachment_path = None
    attachment_name = None
    attachment_type = None
    initial_content = content
    uploaded_files: list[dict] = []
    all_attachments: list[dict] = []  # store all file info as JSON

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
        all_attachments.append({
            "path": str(safe_name),
            "name": upload_file.filename,
            "type": upload_file.content_type or "",
        })

        if not attachment_path:
            attachment_path = str(safe_name)
            attachment_name = upload_file.filename
            attachment_type = upload_file.content_type or ""

        # Generate initial content placeholder
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
                # Document type — placeholder + persistent marker, parsed async
                doc_placeholder = f'<div data-attachment="{upload_file.filename}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {upload_file.filename}（解析中…）</div>'
                doc_marker = f'<!-- doc-attachment: {upload_file.filename} | {safe_name} -->'
                initial_content = f"{initial_content}\n\n{doc_placeholder}\n{doc_marker}" if initial_content else f"{doc_placeholder}\n{doc_marker}"
        except Exception as e:
            logger.warning(f"File placeholder creation failed for {upload_file.filename}: {e}")

    # Track upload order (same as articles)
    if uploaded_files:
        order_list = ", ".join(uf["filename"] for uf in uploaded_files)
        initial_content += f"\n\n<!-- attachments-order: {order_list} -->"

    has_files = len(uploaded_files) > 0
    has_content = bool(initial_content.strip())

    comment = Comment(
        article_id=article_id,
        content=initial_content,
        tags=json.dumps(user_tags, ensure_ascii=False),
        entities=None,
        processing="processing" if (has_files or has_content) else None,
        attachments=json.dumps(all_attachments, ensure_ascii=False) if all_attachments else None,
        attachment_path=attachment_path,
        attachment_name=attachment_name,
        attachment_type=attachment_type,
        created_by=user_cn,
        updated_by=user_cn,
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)

    # Launch background processing
    if has_files or has_content:
        asyncio.create_task(_bg_comment_process(
            comment.id, article_id, uploaded_files,
            need_extract=has_content,
        ))

    return comment


@router.put("/{comment_id}", response_model=CommentResponse)
async def update_comment(
    article_id: str = PathParam(..., max_length=36),
    comment_id: str = PathParam(..., max_length=36),
    content: str = Form(default="", max_length=2000),
    tags: str = Form(default=""),
    files: list[UploadFile] = File(default=[]),
    keep_attachments: str = Form(default=""),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """Update a comment (author only). Supports editing tags and adding files."""
    user_cn = cert.display_name or ""

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    comment = (
        db.query(Comment)
        .filter(Comment.id == comment_id, Comment.article_id == article_id)
        .first()
    )
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    if comment.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有评论作者可以修改该评论")

    content_changed = False
    new_content = content.strip()
    if new_content and new_content != comment.content:
        comment.content = new_content
        content_changed = True

    # Handle tags update
    if tags:
        try:
            new_tags: list[str] = json.loads(tags) if isinstance(tags, str) else (tags or [])
        except (json.JSONDecodeError, TypeError):
            new_tags = []
        new_tags = [t.strip() for t in new_tags if t.strip()]
        comment.tags = json.dumps(new_tags, ensure_ascii=False)

    # Merge existing attachments + new files
    existing: list[dict] = []
    try:
        existing = json.loads(comment.attachments) if comment.attachments else []
    except (json.JSONDecodeError, TypeError):
        pass
    if not isinstance(existing, list):
        existing = []

    # Filter existing attachments to keep
    if keep_attachments:
        try:
            keep_names: list[str] = json.loads(keep_attachments) if isinstance(keep_attachments, str) else []
        except (json.JSONDecodeError, TypeError):
            keep_names = []
        existing = [a for a in existing if a.get("name") in keep_names]

    # Handle new files
    uploaded_files: list[dict] = []
    new_attachments: list[dict] = []
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
        new_attachments.append({
            "path": str(safe_name),
            "name": upload_file.filename,
            "type": upload_file.content_type or "",
        })

        if not comment.attachment_path:
            comment.attachment_path = str(safe_name)
            comment.attachment_name = upload_file.filename
            comment.attachment_type = upload_file.content_type or ""

        try:
            media_src = f"/api/media/{safe_name}"
            if ext in IMAGE_EXTENSIONS:
                img_tag = f'<img src="{media_src}" alt="{upload_file.filename}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
                comment.content = f"{comment.content}\n\n{img_tag}" if comment.content else img_tag
            elif ext in AUDIO_EXTENSIONS:
                audio_tag = f'<audio controls src="{media_src}" alt="{upload_file.filename}" style="width:100%"></audio>'
                comment.content = f"{comment.content}\n\n{audio_tag}" if comment.content else audio_tag
            elif ext in VIDEO_EXTENSIONS:
                poster = ""
                try:
                    thumb_name = safe_name + ".thumb.jpg"
                    if _extract_video_thumbnail(str(storage_path), str(UPLOAD_DIR / thumb_name)):
                        poster = f' poster="/api/media/{thumb_name}"'
                except Exception:
                    pass
                video_tag = f'<video controls src="{media_src}"{poster} alt="{upload_file.filename}" style="width:100%"></video>'
                comment.content = f"{comment.content}\n\n{video_tag}" if comment.content else video_tag
            else:
                doc_placeholder = f'<div data-attachment="{upload_file.filename}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {upload_file.filename}（解析中…）</div>'
                doc_marker = f'<!-- doc-attachment: {upload_file.filename} | {safe_name} -->'
                comment.content = f"{comment.content}\n\n{doc_placeholder}\n{doc_marker}" if comment.content else f"{doc_placeholder}\n{doc_marker}"
        except Exception as e:
            logger.warning(f"File placeholder creation failed for {upload_file.filename}: {e}")

    # Track upload order if new files were added
    if uploaded_files:
        order_list = ", ".join(uf["filename"] for uf in uploaded_files)
        comment.content += f"\n\n<!-- attachments-order: {order_list} -->"

    # Merge attachments (always update — even when all are removed)
    if keep_attachments or new_attachments:
        merged = existing + new_attachments
        comment.attachments = json.dumps(merged, ensure_ascii=False)
        # Clear legacy fields if no attachments remain
        if not merged:
            comment.attachment_path = None
            comment.attachment_name = None
            comment.attachment_type = None

    tags_changed = bool(tags)
    attachments_changed = bool(keep_attachments) or bool(new_attachments)
    if not content_changed and not uploaded_files and not tags_changed and not attachments_changed:
        return comment

    comment.updated_by = user_cn
    comment.processing = "processing" if (content_changed or uploaded_files) else comment.processing
    db.commit()
    db.refresh(comment)

    # Background processing
    if content_changed or uploaded_files:
        # Subtract old entities, re-extract later in background
        asyncio.create_task(_bg_comment_process(
            comment.id, article_id, uploaded_files,
            need_extract=content_changed or bool(uploaded_files),
        ))

    return comment


@router.delete("/{comment_id}", status_code=204)
def delete_comment(
    article_id: str = PathParam(..., max_length=36),
    comment_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """Delete a comment (comment author or article author only)."""
    user_cn = cert.display_name or ""

    article = db.query(Article).filter(Article.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    comment = (
        db.query(Comment)
        .filter(Comment.id == comment_id, Comment.article_id == article_id)
        .first()
    )
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    # Author check: comment author OR article author
    if comment.created_by != user_cn and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有评论作者或文章作者可以删除该评论")

    # Subtract comment's contributions from article entities
    _subtract_comment_from_article(article, comment)
    # Clean up comment chunks from embedding index
    from app.models import ArticleChunk
    db.query(ArticleChunk).filter(
        ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
    ).delete()
    db.delete(comment)
    db.commit()

    invalidate_graph_cache()
    return None
