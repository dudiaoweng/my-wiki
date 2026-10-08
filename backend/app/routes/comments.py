import json
import asyncio
import logging
import os
import re
import html
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Path as PathParam, UploadFile, File, Form
from sqlalchemy.orm import Session
from sqlalchemy import desc
from app.dependencies import get_db
from app.database import SessionLocal
from app.models import Article, ArticleChunk, Comment
from app.schemas import CommentCreate, CommentUpdate, CommentResponse
from app.auth import get_client_cert, CertInfo
from app.llm_extract import extract_chunks_iter, merge_tags
from app.config import AUTO_PARSE
from app.routes.upload import (
    parse_text_from_bytes, parse_docx, parse_xlsx, parse_pptx, parse_pdf,
    parse_image, parse_video, parse_media, to_markdown,
    TEXT_EXTENSIONS, WORD_EXTENSIONS, EXCEL_EXTENSIONS, PPT_EXTENSIONS,
    PDF_EXTENSIONS, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS,
)
from app.routes.qa import _extract_video_thumbnail, get_comment_chunks
from app.utils import read_upload_limited, MAX_UPLOAD_BYTES, delete_uploaded_files
from app import vector_store
from app import neo4j_store
from app.neo4j_store import Neo4jStoreError
from app.config import UPLOAD_DIR as UPLOAD_DIR_STR

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/articles/{article_id}/comments",
    tags=["comments"],
)

UPLOAD_DIR = Path(UPLOAD_DIR_STR)

# 文档类扩展名 — 纯本地解析（不调用 LLM）。
# 评论新增附件的解析（含文档文本提取）统一受 AUTO_PARSE 开关控制：
# 开关关闭时保留"待解析"占位，等手动 reprocess
DOCUMENT_EXTENSIONS = TEXT_EXTENSIONS | WORD_EXTENSIONS | EXCEL_EXTENSIONS | PPT_EXTENSIONS | PDF_EXTENSIONS


# ─── Helpers ────────────────────────────────────────
# v2.3 实体/关系迁移 Neo4j 后：
# - 评论贡献以 MENTIONS/RELATES 边的 source='comment:<id>' 标识，
#   合并 = add_article_mentions（MERGE 幂等），减法 = 按 source 精确删边
# - 原 JSON 合并/减法 helper 已删除（3 元组减法会误删正文关系，删边更精确）

# ─── Embedding helper ────────────────────────────────

async def _embed_comment_content(comment, db) -> None:
    """重建评论向量分块并逐条嵌入（嵌入失败保留 None，分块行仍存在，
    提取与 Q&A 检索才能读到同一套切分）。"""
    try:
        from app.routes.qa import chunk_article, embed_chunk_rows

        # Delete old chunks for this comment（先收集 id，commit 后清理 Qdrant 点）
        old_ids = [
            r[0] for r in db.query(ArticleChunk.id).filter(
                ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
            ).all()
        ]
        db.query(ArticleChunk).filter(
            ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
        ).delete()

        clean = re.sub(r'<[^>]*>', '', comment.content or '')
        clean = re.sub(r'<!--.*?-->', '', clean)
        clean = re.sub(r'\s+', ' ', clean).strip()
        if not clean:
            db.commit()
            return

        rows: list[ArticleChunk] = []
        for i, chunk_text in enumerate(chunk_article(clean)):
            rows.append(ArticleChunk(
                article_id=comment.article_id,
                chunk_index=f"comment.{comment.id[:8]}.{i}",
                chunk_text=f"[评论] {chunk_text}",
            ))
        db.add_all(rows)
        db.commit()
        if old_ids:
            await vector_store.delete_points(old_ids)
        await embed_chunk_rows(db, rows)  # 新块经此自动 upsert 到 Qdrant
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
            escaped_name = html.escape(uf["filename"], quote=True)
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
                elif ext in IMAGE_EXTENSIONS and AUTO_PARSE:
                    parsed = await parse_image(uf["storage_path"], uf["filename"])
                elif ext in VIDEO_EXTENSIONS and AUTO_PARSE:
                    parsed = await parse_video(uf["storage_path"], uf["filename"])
                elif ext in AUDIO_EXTENSIONS and AUTO_PARSE:
                    with open(uf["storage_path"], "rb") as f:
                        audio_bytes = f.read()
                    parsed = await parse_media(audio_bytes, uf["filename"], uf["content_type"])
                else:
                    parsed = ""
                # 公文结构 → markdown（规则转换，正文一字不改；幂等）
                parsed = to_markdown(parsed, ext)

                if parsed:
                    # Replace placeholder div
                    placeholder = f'<div data-attachment="{escaped_name}"'
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

        # ── 第一步返回：文档/媒体文本提取完成，先落库 ──
        # 前端每 5s 轮询立即看到文本；识别阶段（标签/实体提取）继续在后台运行
        if has_changes and AUTO_PARSE and need_extract and full_text.strip():
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if comment:
                comment.content = full_text
                comment.processing = "recognizing"
                db2.commit()

        # Step B: Extract tags + entities（LLM 解析，AUTO_PARSE 控制）
        # 基于向量分块逐段提取（提取与 Q&A 检索共用同一套切分），每段完成后立即落库
        if need_extract and AUTO_PARSE and full_text.strip():
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if not comment:
                return
            article = db2.query(Article).filter(Article.id == article_id).first()
            if not article:
                return

            # 编辑评论场景：先按 source 精确删除旧贡献再重新提取合并，
            # 避免旧实体/关系残留（新建评论无旧边，删除为 no-op）
            try:
                await neo4j_store.delete_mentions(article_id, source=f"comment:{comment_id}")
                await neo4j_store.delete_relations(article_id, source=f"comment:{comment_id}")
            except Neo4jStoreError as e:
                logger.error("[BG_COMMENT] Neo4j subtract failed: %s", e)

            # 评论分块不存在时先建（文本提取已完成、内容已定稿）
            if not get_comment_chunks(db2, comment_id):
                await _embed_comment_content(comment, db2)

            try:
                cur_tags = json.loads(comment.tags) if comment.tags else []
                if not isinstance(cur_tags, list):
                    cur_tags = []
                chunk_rows = get_comment_chunks(db2, comment_id)
                texts = [r.chunk_text.removeprefix("[评论] ") for r in chunk_rows]
                async for seg_tags, seg_entities in extract_chunks_iter(texts):
                    if seg_tags:
                        cur_tags = merge_tags(cur_tags, seg_tags)
                        comment.tags = json.dumps(cur_tags, ensure_ascii=False)
                    if isinstance(seg_entities, dict) and seg_entities:
                        # Neo4j：评论贡献以 source='comment:<id>' 边合并进文章
                        # （MERGE 幂等 = 原逐段合并语义；创建人由存储层标注）
                        try:
                            await neo4j_store.add_article_mentions(
                                article_id,
                                seg_entities.get("entities", []),
                                seg_entities.get("relations", []),
                                source=f"comment:{comment_id}",
                                creator=comment.created_by or "",
                            )
                        except Neo4jStoreError as e:
                            logger.error("[BG_COMMENT] Neo4j entity write failed: %s", e)
                    # 逐段落库
                    db2.commit()
            except Exception as e:
                logger.warning(f"[BG_COMMENT] LLM extraction failed: {e}")

            # Re-fetch（正文可能已被第一阶段的提交更新）
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if not comment:
                return
            article = db2.query(Article).filter(Article.id == article_id).first()
            if not article:
                return

            if has_changes:
                comment.content = full_text

            comment.processing = None
            db2.commit()
            # 评论分块已在提取前建立（向量分块先行），无需重复嵌入
            logger.info("[BG_COMMENT] comment %s processing complete", comment_id)
        else:
            # 无需提取（仅附件文本落库，如只加附件无正文）——仅写入文档提取的文本。
            # 无论是否有变化都要清 processing，避免占位符卡在"读取中…"
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if comment:
                if has_changes:
                    comment.content = full_text
                comment.processing = None
                db2.commit()
                if has_changes:
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


def _replace_media_tag_with_desc(full_text: str, storage_name: str, desc: str) -> str:
    """将正文中含 storage_name 的媒体标签行替换为新的解析结果（desc 自带媒体标签）。

    重新解析会反复执行：替换式写入避免旧描述/重复标签在正文中越堆越多。
    """
    lines = full_text.split('\n')
    new_lines: list[str] = []
    replaced = False
    for line in lines:
        if storage_name in line and ('<img' in line or '<video' in line or '<audio' in line):
            if not replaced:
                new_lines.append(desc)
                replaced = True
            # 其余同名媒体标签行删除（旧解析可能重复追加过）
        else:
            new_lines.append(line)
    if not replaced:
        new_lines.append(desc)
    return '\n'.join(new_lines)


async def _bg_comment_reextract(
    comment_id: str, article_id: str,
) -> None:
    """Background: 评论内容重新解析——重建分块/嵌入并重新提取标签/实体（不触碰附件）。"""
    db2 = SessionLocal()
    try:
        comment = db2.query(Comment).filter(Comment.id == comment_id).first()
        if not comment:
            return
        article = db2.query(Article).filter(Article.id == article_id).first()
        if not article:
            return

        # Step A: 重建评论分块 + 嵌入（提取与 Q&A 检索共用同一套切分）
        await _embed_comment_content(comment, db2)

        # Step B: 重新提取标签/实体——旧贡献先按 source 精确删边，避免重复累计
        # （原 3 元组减法可能误删正文关系，删边更精确）
        try:
            await neo4j_store.delete_mentions(article_id, source=f"comment:{comment_id}")
            await neo4j_store.delete_relations(article_id, source=f"comment:{comment_id}")
        except Neo4jStoreError as e:
            logger.error("[BG_COMMENT_REEXTRACT] Neo4j subtract failed: %s", e)
        db2.commit()

        try:
            cur_tags = json.loads(comment.tags) if comment.tags else []
            if not isinstance(cur_tags, list):
                cur_tags = []
            chunk_rows = get_comment_chunks(db2, comment_id)
            texts = [r.chunk_text.removeprefix("[评论] ") for r in chunk_rows]
            async for seg_tags, seg_entities in extract_chunks_iter(texts):
                if seg_tags:
                    cur_tags = merge_tags(cur_tags, seg_tags)
                    comment.tags = json.dumps(cur_tags, ensure_ascii=False)
                if isinstance(seg_entities, dict) and seg_entities:
                    # Neo4j：评论贡献以 source='comment:<id>' 边合并进文章
                    try:
                        await neo4j_store.add_article_mentions(
                            article_id,
                            seg_entities.get("entities", []),
                            seg_entities.get("relations", []),
                            source=f"comment:{comment_id}",
                            creator=comment.created_by or "",
                        )
                    except Neo4jStoreError as e:
                        logger.error("[BG_COMMENT_REEXTRACT] Neo4j entity write failed: %s", e)
                # 逐段落库
                db2.commit()
        except Exception as e:
            logger.warning(f"[BG_COMMENT_REEXTRACT] LLM extraction failed: {e}")

        comment = db2.query(Comment).filter(Comment.id == comment_id).first()
        if not comment:
            return
        comment.processing = None
        db2.commit()
        logger.info("[BG_COMMENT_REEXTRACT] comment %s reextract complete", comment_id)
    except Exception as e:
        logger.warning(f"[BG_COMMENT_REEXTRACT] Failed: {e}")
        try:
            comment = db2.query(Comment).filter(Comment.id == comment_id).first()
            if comment:
                comment.processing = None
                db2.commit()
        except Exception:
            pass
    finally:
        db2.close()


async def _bg_comment_attachment_reprocess(
    comment_id: str, article_id: str, file_info: dict,
) -> None:
    """Background: 单个附件重新解析——只重解析该附件并替换写入正文，
    随后重建评论分块/嵌入（正文已变化）；不重新提取标签/实体。"""
    db2 = SessionLocal()
    try:
        comment = db2.query(Comment).filter(Comment.id == comment_id).first()
        if not comment:
            return
        article = db2.query(Article).filter(Article.id == article_id).first()
        if not article:
            return

        full_text = comment.content or ""
        ext = Path(file_info["filename"]).suffix.lower()
        escaped_name = html.escape(file_info["filename"], quote=True)
        storage_name = Path(file_info["storage_path"]).name

        # ── 解析该附件（替换式写入，不重复追加）──
        if ext in DOCUMENT_EXTENSIONS:
            # 文档文本提取为纯本地解析。占位符仍在（此前从未成功提取）时替换；
            # 否则正文已含提取文本，不重复追加。
            try:
                if ext in TEXT_EXTENSIONS:
                    with open(file_info["storage_path"], "rb") as f:
                        parsed = parse_text_from_bytes(f.read())
                elif ext in WORD_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_docx, file_info["storage_path"])
                elif ext in EXCEL_EXTENSIONS and ext != '.csv':
                    parsed = await asyncio.to_thread(parse_xlsx, file_info["storage_path"])
                elif ext in PPT_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_pptx, file_info["storage_path"])
                elif ext in PDF_EXTENSIONS:
                    parsed = await asyncio.to_thread(parse_pdf, file_info["storage_path"])
                else:
                    parsed = ""
                if parsed:
                    placeholder = f'<div data-attachment="{escaped_name}"'
                    idx = full_text.find(placeholder)
                    if idx >= 0:
                        end_idx = full_text.find('</div>', idx)
                        if end_idx >= 0:
                            full_text = full_text[:idx] + parsed + full_text[end_idx + 6:]
            except Exception as e:
                logger.warning(f"[BG_COMMENT_ATTACH] Document parsing failed for {file_info['filename']}: {e}")
        elif ext in IMAGE_EXTENSIONS:
            try:
                desc = await parse_image(file_info["storage_path"], file_info["filename"])
                full_text = _replace_media_tag_with_desc(full_text, storage_name, desc)
            except Exception as e:
                logger.warning(f"[BG_COMMENT_ATTACH] Image description failed for {file_info['filename']}: {e}")
        elif ext in VIDEO_EXTENSIONS:
            try:
                desc = await parse_video(file_info["storage_path"], file_info["filename"])
                full_text = _replace_media_tag_with_desc(full_text, storage_name, desc)
            except Exception as e:
                logger.warning(f"[BG_COMMENT_ATTACH] Video description failed for {file_info['filename']}: {e}")
        elif ext in AUDIO_EXTENSIONS:
            try:
                with open(file_info["storage_path"], "rb") as f:
                    audio_bytes = f.read()
                desc = await parse_media(audio_bytes, file_info["filename"], file_info["content_type"])
                full_text = _replace_media_tag_with_desc(full_text, storage_name, desc)
            except Exception as e:
                logger.warning(f"[BG_COMMENT_ATTACH] Audio transcription failed for {file_info['filename']}: {e}")
        # 其他类型跳过（无对应解析器）

        comment.content = full_text
        comment.processing = None
        db2.commit()

        # 正文已变化 → 重建评论分块 + 嵌入，保持 Q&A 检索索引新鲜
        await _embed_comment_content(comment, db2)
        logger.info("[BG_COMMENT_ATTACH] comment %s attachment reprocess complete: %s", comment_id, file_info["filename"])
    except Exception as e:
        logger.warning(f"[BG_COMMENT_ATTACH] Failed: {e}")
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


def _attach_entities(comment: Comment) -> None:
    """组装评论实体贡献挂 ORM 临时属性（Neo4j 按 source='comment:<id>' 边查询，
    dict 直通响应模型 validator）；不可用时降级 None（前端容忍）。"""
    try:
        ent_map = neo4j_store.get_comment_entities_sync([comment.id])
    except Neo4jStoreError as e:
        logger.warning("Comment entities assembly failed (Neo4j unavailable): %s", e)
        ent_map = {}
    comment.entities = ent_map.get(comment.id)


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
    for c in comments:
        _attach_entities(c)
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
        content_bytes = await read_upload_limited(upload_file, MAX_UPLOAD_BYTES)
        safe_fname = re.sub(r'[^\w.\-]', '_', upload_file.filename)
        safe_name = f"{uuid.uuid4().hex}_{safe_fname}"
        escaped_name = html.escape(upload_file.filename, quote=True)
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
                img_tag = f'<img src="{media_src}" alt="{escaped_name}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
                initial_content = f"{initial_content}\n\n{img_tag}" if initial_content else img_tag
            elif ext in AUDIO_EXTENSIONS:
                audio_tag = f'<audio controls src="{media_src}" alt="{escaped_name}" style="width:100%"></audio>'
                initial_content = f"{initial_content}\n\n{audio_tag}" if initial_content else audio_tag
            elif ext in VIDEO_EXTENSIONS:
                poster = ""
                try:
                    thumb_name = safe_name + ".thumb.jpg"
                    if _extract_video_thumbnail(str(storage_path), str(UPLOAD_DIR / thumb_name)):
                        poster = f' poster="/api/media/{thumb_name}"'
                except Exception:
                    pass
                video_tag = f'<video controls src="{media_src}"{poster} alt="{escaped_name}" style="width:100%"></video>'
                initial_content = f"{initial_content}\n\n{video_tag}" if initial_content else video_tag
            else:
                # 文档类型 — 占位符。文档文本提取为纯本地解析，始终后台执行；
                # 新增附件统一受 AUTO_PARSE 控制：关闭时保留"待解析"占位等手动解析
                parse_hint = "（读取中…）" if AUTO_PARSE else "（待解析）"
                doc_placeholder = f'<div data-attachment="{escaped_name}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {escaped_name}{parse_hint}</div>'
                doc_marker = f'<!-- doc-attachment: {escaped_name} | {safe_name} -->'
                initial_content = f"{initial_content}\n\n{doc_placeholder}\n{doc_marker}" if initial_content else f"{doc_placeholder}\n{doc_marker}"
        except Exception as e:
            logger.warning(f"File placeholder creation failed for {upload_file.filename}: {e}")

    # Track upload order (same as articles)
    if uploaded_files:
        order_list = ", ".join(html.escape(uf["filename"], quote=True) for uf in uploaded_files)
        initial_content += f"\n\n<!-- attachments-order: {order_list} -->"

    has_files = len(uploaded_files) > 0
    has_content = bool(initial_content.strip())

    comment = Comment(
        article_id=article_id,
        content=initial_content,
        tags=json.dumps(user_tags, ensure_ascii=False),
        processing="processing" if AUTO_PARSE and (has_files or has_content) else None,
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

    # Launch background processing — 新增附件与内容解析统一受 AUTO_PARSE 控制；
    # 开关关闭时保留"待解析"占位，等手动 reprocess
    if AUTO_PARSE and (has_files or has_content):
        asyncio.create_task(_bg_comment_process(
            comment.id, article_id, uploaded_files,
            need_extract=has_content,
        ))

    _attach_entities(comment)
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
        content_bytes = await read_upload_limited(upload_file, MAX_UPLOAD_BYTES)
        safe_fname = re.sub(r'[^\w.\-]', '_', upload_file.filename)
        safe_name = f"{uuid.uuid4().hex}_{safe_fname}"
        escaped_name = html.escape(upload_file.filename, quote=True)
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
                img_tag = f'<img src="{media_src}" alt="{escaped_name}" style="max-width:100%;height:auto;display:block;border-radius:4px">'
                comment.content = f"{comment.content}\n\n{img_tag}" if comment.content else img_tag
            elif ext in AUDIO_EXTENSIONS:
                audio_tag = f'<audio controls src="{media_src}" alt="{escaped_name}" style="width:100%"></audio>'
                comment.content = f"{comment.content}\n\n{audio_tag}" if comment.content else audio_tag
            elif ext in VIDEO_EXTENSIONS:
                poster = ""
                try:
                    thumb_name = safe_name + ".thumb.jpg"
                    if _extract_video_thumbnail(str(storage_path), str(UPLOAD_DIR / thumb_name)):
                        poster = f' poster="/api/media/{thumb_name}"'
                except Exception:
                    pass
                video_tag = f'<video controls src="{media_src}"{poster} alt="{escaped_name}" style="width:100%"></video>'
                comment.content = f"{comment.content}\n\n{video_tag}" if comment.content else video_tag
            else:
                # 文档类型 — 占位符。文档文本提取为纯本地解析，始终后台执行；
                # 新增附件统一受 AUTO_PARSE 控制：关闭时保留"待解析"占位等手动解析
                parse_hint = "（读取中…）" if AUTO_PARSE else "（待解析）"
                doc_placeholder = f'<div data-attachment="{escaped_name}" data-path="{safe_name}" style="padding:10px 14px;background:var(--c-surface);border-radius:8px;border:1px solid var(--c-border);margin:8px 0">📎 {escaped_name}{parse_hint}</div>'
                doc_marker = f'<!-- doc-attachment: {escaped_name} | {safe_name} -->'
                comment.content = f"{comment.content}\n\n{doc_placeholder}\n{doc_marker}" if comment.content else f"{doc_placeholder}\n{doc_marker}"
        except Exception as e:
            logger.warning(f"File placeholder creation failed for {upload_file.filename}: {e}")

    # Track upload order if new files were added
    if uploaded_files:
        order_list = ", ".join(html.escape(uf["filename"], quote=True) for uf in uploaded_files)
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
        _attach_entities(comment)
        return comment

    comment.updated_by = user_cn
    comment.processing = "processing" if AUTO_PARSE and (content_changed or uploaded_files) else comment.processing
    db.commit()
    db.refresh(comment)

    # Background processing — 新增附件与内容解析统一受 AUTO_PARSE 控制
    if AUTO_PARSE and (content_changed or uploaded_files):
        # Subtract old entities, re-extract later in background
        asyncio.create_task(_bg_comment_process(
            comment.id, article_id, uploaded_files,
            need_extract=content_changed or bool(uploaded_files),
        ))

    _attach_entities(comment)
    return comment


@router.post("/{comment_id}/reprocess", response_model=CommentResponse)
async def reprocess_comment(
    article_id: str = PathParam(..., max_length=36),
    comment_id: str = PathParam(..., max_length=36),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """对评论内容重新解析：重建分块/嵌入并重新提取标签/实体（不触碰附件）。

    评论作者或文章作者可用。
    """
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

    if comment.created_by != user_cn and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有评论作者或文章作者可以重新解析该评论")

    if comment.processing:
        raise HTTPException(status_code=409, detail="评论正在处理中，请稍候")

    if not (comment.content or "").strip():
        raise HTTPException(status_code=400, detail="评论没有文本内容，无法解析")

    comment.processing = "recognizing"
    db.commit()

    asyncio.create_task(_bg_comment_reextract(comment.id, article_id))
    _attach_entities(comment)
    return comment


@router.post("/{comment_id}/reprocess/{safe_name}", response_model=CommentResponse)
async def reprocess_comment_attachment(
    article_id: str = PathParam(..., max_length=36),
    comment_id: str = PathParam(..., max_length=36),
    safe_name: str = PathParam(...),
    db: Session = Depends(get_db),
    cert: CertInfo = Depends(get_client_cert),
):
    """重新解析评论的单个附件（只针对该附件，不重新提取标签/实体）。

    评论作者或文章作者可用。
    """
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

    if comment.created_by != user_cn and article.created_by != user_cn:
        raise HTTPException(status_code=403, detail="只有评论作者或文章作者可以重新解析该评论")

    if comment.processing:
        raise HTTPException(status_code=409, detail="评论正在处理中，请稍候")

    # Validate safe_name to prevent path traversal
    if "/" in safe_name or "\\" in safe_name or ".." in safe_name:
        raise HTTPException(status_code=400, detail="Invalid file name")

    # 附件归属校验：safe_name 必须在该评论的附件列表中（含 legacy 单附件字段），
    # 避免把不属于该评论的文件解析进正文
    try:
        attachments = json.loads(comment.attachments) if comment.attachments else []
    except (json.JSONDecodeError, TypeError):
        attachments = []
    known_paths = {
        str(a.get("path", ""))
        for a in (attachments if isinstance(attachments, list) else [])
        if isinstance(a, dict)
    }
    if comment.attachment_path:
        known_paths.add(comment.attachment_path)
    if safe_name not in known_paths:
        raise HTTPException(status_code=404, detail="Attachment not found in this comment")

    storage_path = UPLOAD_DIR / safe_name
    if not storage_path.exists():
        raise HTTPException(status_code=404, detail="Attachment not found")

    # 从 attachments JSON 找回原始文件名与类型
    original_name = safe_name
    content_type = ""
    for a in attachments if isinstance(attachments, list) else []:
        if a.get("path") == safe_name:
            original_name = a.get("name") or safe_name
            content_type = a.get("type", "")
            break

    comment.processing = f"processing:{safe_name}"
    db.commit()

    asyncio.create_task(_bg_comment_attachment_reprocess(
        comment.id, article_id,
        {"filename": original_name, "content_type": content_type, "storage_path": str(storage_path)},
    ))
    _attach_entities(comment)
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

    # 减去该评论的实体贡献：按 source 精确删边（best-effort；Neo4j 宕机时
    # 评论级悬空边由下次启动的悬空 GC 兜底治愈）
    try:
        neo4j_store.delete_mentions_sync(article_id, source=f"comment:{comment_id}")
        neo4j_store.delete_relations_sync(article_id, source=f"comment:{comment_id}")
    except Neo4jStoreError as e:
        logger.warning("Neo4j comment subtract failed: %s", e)
    # Clean up comment chunks from embedding index（Qdrant 点同步清理）
    from app.models import ArticleChunk
    old_chunk_ids = [
        r[0] for r in db.query(ArticleChunk.id).filter(
            ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
        ).all()
    ]
    db.query(ArticleChunk).filter(
        ArticleChunk.chunk_index.like(f"comment.{comment.id[:8]}.%")
    ).delete()
    # Collect attachment files for cleanup
    attachment_files: set[str] = set()
    if comment.attachment_path:
        attachment_files.add(comment.attachment_path)
    if comment.attachments:
        try:
            for a in json.loads(comment.attachments):
                p = a.get("path", "")
                if p:
                    attachment_files.add(p)
        except (json.JSONDecodeError, TypeError):
            pass
    for m in re.finditer(r'<(?:img|video|audio)\b[^>]*src="([^"]+)"', comment.content or "", re.IGNORECASE):
        attachment_files.add(m.group(1).rsplit("/", 1)[-1].split("?")[0])

    db.delete(comment)
    db.commit()
    vector_store.schedule_delete_points(old_chunk_ids)
    delete_uploaded_files(attachment_files)

    return None
