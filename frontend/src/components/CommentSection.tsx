import { useState, useEffect, useRef, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { api } from '../api/client';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { createEntityHighlightPlugin } from '../utils/rehypeEntityHighlight';
import { AttachmentGallery, type MediaItem } from './AttachmentGallery';

import type { Comment } from '../types/comment';
import styles from './CommentSection.module.css';

interface Props {
  articleId: string;
  /** Currently selected entity name (for highlighting), or null */
  selectedEntity?: string | null;
  /** Starting index for entity occurrence numbering in comments */
  entityOccurrenceOffset?: number;
  /** Called with concatenated comment text contents for occurrence counting */
  onCommentTextsChange?: (texts: string[]) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (hrs < 24) return `${hrs} 小时前`;
  if (days < 7) return `${days} 天前`;

  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) + ' '
    + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatUser(cn: string | null): string {
  if (!cn) return '匿名';
  const match = cn.match(/^(.+?)\s+\d{18}$/);
  return match ? match[1] : cn;
}

/** Return emoji icon for file extension */
function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
  if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].includes(ext)) return '🎵';
  if (['docx', 'doc'].includes(ext)) return '📝';
  if (['xlsx', 'xls'].includes(ext)) return '📊';
  if (['pptx', 'ppt'].includes(ext)) return '📽️';
  if (['pdf'].includes(ext)) return '📄';
  if (['txt', 'md', 'json', 'xml', 'csv'].includes(ext)) return '📃';
  return '📎';
}

/** Check if current user is the comment author (by ID number). */
function isAuthor(commentCreatedBy: string | null, userIdNumber: string): boolean {
  if (!commentCreatedBy || !userIdNumber) return false;
  const idMatch = commentCreatedBy.match(/\d{18}/);
  return idMatch ? idMatch[0] === userIdNumber : false;
}

/** Strip media HTML tags and markers from content (mirrors useAttachments cleanup). */
/** Simple text-only strip for edit content preview. */

const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif']);
const VID_EXTS = new Set(['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv']);
const AUD_EXTS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'wma']);

/** File chip grid — same visual style as EditorModal's attachment list.
 *  Owns its file input internally for reliable click handling. */
function FileChipGrid({
  files, onFilesAdded, onRemove, objectUrlsRef,
  existingAttachments, onRemoveExisting,
}: {
  files: File[];
  onFilesAdded: (newFiles: File[]) => void;
  onRemove: (i: number) => void;
  objectUrlsRef: React.MutableRefObject<string[]>;
  existingAttachments?: { path: string; name: string; type: string }[];
  onRemoveExisting?: (i: number) => void;
}) {
  const internalFileRef = useRef<HTMLInputElement>(null);

  // Cache object URLs per file so re-renders don't create (and leak) new URLs.
  const fileUrlMap = useMemo(() => {
    const map = new Map<File, string>();
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (IMG_EXTS.has(ext)) {
        const url = URL.createObjectURL(file);
        map.set(file, url);
        objectUrlsRef.current.push(url);
      }
    }
    return map;
  }, [files, objectUrlsRef]);

  const hasExisting = existingAttachments && existingAttachments.length > 0;

  return (
    <div className={styles.fileChips}>
      <input
        ref={internalFileRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFilesAdded(Array.from(e.target.files));
          }
          if (internalFileRef.current) internalFileRef.current.value = '';
        }}
        accept=".txt,.md,.json,.xml,.csv,.docx,.xlsx,.xls,.pptx,.ppt,.pdf,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.mp3,.wav,.m4a,.flac,.ogg,.mp4,.avi,.mov,.mkv,.webm"
      />
      {/* Existing attachments */}
      {hasExisting && existingAttachments!.map((ea, i) => {
        const ext = (ea.name.split('.').pop() ?? '').toLowerCase();
        const isImg = IMG_EXTS.has(ext);
        const isVid = VID_EXTS.has(ext);
        const isAud = AUD_EXTS.has(ext);
        const thumbSrc = isVid ? `/api/media/${ea.path}.thumb.jpg` : (isImg ? `/api/media/${ea.path}` : null);
        return (
          <div key={`existing-${ea.name}-${i}`} className={`${styles.fileChip} ${styles.fileChipExisting}`}>
            <div className={styles.fileChipThumb}>
              {thumbSrc ? (
                <img src={thumbSrc} alt={ea.name} className={styles.fileChipImg} />
              ) : (
                <span className={styles.fileChipIcon}>
                  {isAud ? '🎵' : getFileIcon(ea.name)}
                </span>
              )}
              {isVid && <span className={styles.fileChipPlay}>▶</span>}
            </div>
            <span className={styles.fileChipName}>{ea.name}</span>
            <button
              className={styles.fileChipRemove}
              onClick={() => onRemoveExisting?.(i)}
              title="移除已有附件"
            >✕</button>
          </div>
        );
      })}
      {/* New files */}
      {files.map((file, i) => {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        const isImage = IMG_EXTS.has(ext);
        const isVideo = VID_EXTS.has(ext);
        const isAudio = AUD_EXTS.has(ext);
        const thumbUrl = fileUrlMap.get(file);

        return (
          <div key={`${file.name}-${i}`} className={styles.fileChip}>
            <div className={styles.fileChipThumb}>
              {isImage && thumbUrl ? (
                <img src={thumbUrl} alt={file.name} className={styles.fileChipImg} />
              ) : (
                <span className={styles.fileChipIcon}>
                  {isVideo ? '🎬' : isAudio ? '🎵' : getFileIcon(file.name)}
                </span>
              )}
              {isVideo && <span className={styles.fileChipPlay}>▶</span>}
            </div>
            <span className={styles.fileChipName}>{file.name}</span>
            <button
              className={styles.fileChipRemove}
              onClick={() => onRemove(i)}
              title="移除"
            >✕</button>
          </div>
        );
      })}
      <button
        type="button"
        className={styles.fileAddBtn}
        onClick={() => internalFileRef.current?.click()}
        title="添加附件"
      >
        + 添加
      </button>
    </div>
  );
}

/** Build MediaItems from comment.attachments JSON (source of truth). */
function buildCommentMediaItems(comment: Comment): MediaItem[] {
  const IMG = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico','tiff','tif']);
  const VID = new Set(['mp4','avi','mov','mkv','webm','wmv']);
  const AUD = new Set(['mp3','wav','m4a','flac','ogg','wma']);

  function toItem(a: { path: string; name: string; type?: string }): MediaItem {
    const ext = (a.name.split('.').pop() ?? '').toLowerCase();
    let t: MediaItem['type'] = 'document';
    if (IMG.has(ext)) t = 'image';
    else if (VID.has(ext)) t = 'video';
    else if (AUD.has(ext)) t = 'audio';
    const item: MediaItem = { type: t, src: `/api/media/${a.path}`, name: a.name };
    if (t === 'video') item.poster = `/api/media/${a.path}.thumb.jpg`;
    return item;
  }

  if (comment.attachments && comment.attachments.length > 0) {
    return comment.attachments.map(toItem);
  }
  if (comment.attachment_name && comment.attachment_path) {
    return [toItem({ path: comment.attachment_path, name: comment.attachment_name })];
  }
  return [];
}

/** Strip media tags from content for clean Markdown rendering. */
function stripContentForDisplay(content: string): string {
  return content
    .replace(/<(img|video|audio)\b[^>]*\/?>/gi, '')
    .replace(/<\/(video|audio)>/gi, '')
    .replace(/<!--.*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render a single comment — attachments + content. */
function CommentBody({
  comment,
  rehypePlugins,
}: {
  comment: Comment;
  rehypePlugins: any[];
}) {
  const mediaItems = buildCommentMediaItems(comment);
  const displayContent = mediaItems.length > 0
    ? stripContentForDisplay(comment.content || '')
    : (comment.content || '');

  return (
    <>
      <div className={`${styles.content} markdown-content`}>
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
          {displayContent}
        </Markdown>
      </div>
      {mediaItems.length > 0 && <AttachmentGallery items={mediaItems} />}
    </>
  );
}

export function CommentSection({
  articleId,
  selectedEntity,
  entityOccurrenceOffset = 0,
  onCommentTextsChange,
}: Props) {
  const { userIdNumber, requestConfirm, notifyArticleSaved } = useApp();
  const { showToast } = useToast();

  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New comment form
  const [newContent, setNewContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const [editExistingAttachments, setEditExistingAttachments] = useState<{path: string; name: string; type: string}[]>([]);
  const [saving, setSaving] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const editObjectUrlsRef = useRef<string[]>([]);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;

  // Revoke any object URLs still held when the component unmounts
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      editObjectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const [showForm, setShowForm] = useState(false);

  // ── Entity highlight plugin for comments (with offset from article occurrences) ──
  const commentHighlightPlugin = useMemo(
    () => createEntityHighlightPlugin(selectedEntity ?? null, entityOccurrenceOffset),
    [selectedEntity, entityOccurrenceOffset],
  );

  const commentRehypePlugins = useMemo(
    () => [rehypeRaw, rehypeSanitize, commentHighlightPlugin] as any,
    [commentHighlightPlugin],
  );

  // ── Report comment texts to parent for entity occurrence counting ──
  useEffect(() => {
    if (onCommentTextsChange) {
      const texts = comments.map((c) => c.content || '');
      onCommentTextsChange(texts);
    }
  }, [comments, onCommentTextsChange]);

  // ── Fetch comments on mount and when articleId changes ──
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await api.getComments(articleId);
        if (!cancelled) {
          setComments(data);
          setLoading(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载评论失败';
          setError(msg);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // ── Poll every 5s when any comment is processing ──
  useEffect(() => {
    const hasProcessing = comments.some((c) => c.processing === 'processing');

    if (hasProcessing && !pollingRef.current) {
      pollingRef.current = setInterval(async () => {
        try {
          const data = await api.getComments(articleId);
          setComments(data);
          // If all processing done, stop polling and notify
          if (!data.some((c) => c.processing === 'processing') && data.length > 0) {
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            notifyArticleSaved();
          }
        } catch {
          // keep polling on network error
        }
      }, 5000);
    }

    if (!hasProcessing && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [comments, articleId, notifyArticleSaved]);

  // ── Handlers ──

  const reloadComments = async () => {
    try {
      const data = await api.getComments(articleId);
      setComments(data);
    } catch {
      // silent fail for manual reloads
    }
  };

  const handleSubmit = async () => {
    if (!newContent.trim() && files.length === 0) return;
    if (newContent.length > 2000) {
      showToast('评论内容不能超过2000字', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.createComment(articleId, newContent.trim(), files.length > 0 ? files : undefined);
      setNewContent('');
      setFiles([]);
      // Clean up object URLs
      objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      objectUrlsRef.current = [];
      showToast('评论已发布', 'success');
      setShowForm(false);
      await reloadComments();
      notifyArticleSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '发布评论失败';
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (comment: Comment) => {
    setEditingId(comment.id);
    setEditContent(comment.content?.replace(/<(img|video|audio)\b[^>]*\/?>/gi, '').replace(/<\/(video|audio)>/gi, '').replace(/<!-- doc-attachment: .+? -->/g, '').replace(/<!-- attachments-order: .+? -->/g, '').replace(/\n{3,}/g, '\n\n').trim() || '');
    setEditFiles([]);
    if (comment.attachments && comment.attachments.length > 0) {
      setEditExistingAttachments(comment.attachments);
    } else if (comment.attachment_name && comment.attachment_path) {
      setEditExistingAttachments([{
        path: comment.attachment_path,
        name: comment.attachment_name,
        type: comment.attachment_type || '',
      }]);
    } else {
      setEditExistingAttachments([]);
    }
    editObjectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    editObjectUrlsRef.current = [];
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditFiles([]);
    setEditExistingAttachments([]);
    editObjectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    editObjectUrlsRef.current = [];
  };

  const handleSaveEdit = async (commentId: string) => {
    if (editContent.length > 2000) {
      showToast('评论内容不能超过2000字', 'error');
      return;
    }
    setSaving(true);
    try {
      const keepNames = editExistingAttachments.map((a) => a.name);
      await api.updateComment(
        articleId, commentId, editContent.trim(),
        editFiles.length > 0 ? editFiles : undefined,
        keepNames,
      );
      setEditingId(null);
      setEditContent('');
      setEditFiles([]);
      setEditExistingAttachments([]);
      editObjectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      editObjectUrlsRef.current = [];
      showToast('评论已更新', 'success');
      await reloadComments();
      notifyArticleSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '更新评论失败';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (comment: Comment) => {
    requestConfirm('删除评论', '确定要删除这条评论吗？此操作不可撤销。', async () => {
      try {
        await api.deleteComment(articleId, comment.id);
        showToast('评论已删除', 'success');
        await reloadComments();
        notifyArticleSaved();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '删除评论失败';
        showToast(msg, 'error');
      }
    });
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removeEditFile = (index: number) => {
    setEditFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>
        💬 评论{comments.length > 0 && <span className={styles.count}>{comments.length}</span>}
        <button
          className={styles.toggleFormBtn}
          onClick={() => setShowForm((v) => !v)}
          title={showForm ? '收起' : '写评论'}
        >
          {showForm ? '收起 ✕' : '写评论 ✎'}
        </button>
      </h3>

      {/* ── New comment form ── */}
      {showForm && (
        <div className={styles.form}>
          {/* ── 内容 ── */}
          <div className={styles.editGroup}>
            <label className={styles.editLabel}>
              内容 <span className={styles.editLabelHint}>{newContent.length}/2000</span>
            </label>
            <textarea
              className={styles.textarea}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="写下你的评论…（支持 Markdown）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>

          {/* ── 附件（选填）── */}
          <div className={styles.editGroup}>
            <label className={styles.editLabel}>附件（选填）</label>
            <FileChipGrid
              files={files}
              onFilesAdded={(newFiles) => setFiles((prev) => [...prev, ...newFiles])}
              onRemove={removeFile}
              objectUrlsRef={objectUrlsRef}
            />
          </div>

          <div className={styles.editActions}>
            <button
              className={styles.submitBtn}
              onClick={handleSubmit}
              disabled={submitting || (!newContent.trim() && files.length === 0)}
            >
              {submitting ? '发布中…' : '发布评论'}
            </button>
          </div>
        </div>
      )}

      {/* ── Comment list ── */}
      {loading ? (
        <div className={styles.status}>加载中…</div>
      ) : error ? (
        <div className={styles.status} style={{ color: 'var(--c-danger)' }}>{error}</div>
      ) : comments.length === 0 ? (
        <div className={styles.status}>暂无评论，写下第一条评论吧</div>
      ) : (
        <div className={styles.list}>
          {comments.map((comment) => {
            const editing = editingId === comment.id;
            const canModify = isAuthor(comment.created_by, userIdNumber);

            return (
              <div key={comment.id} className={styles.item}>
                <div className={styles.itemHeader}>
                  <span className={styles.author} title={comment.created_by ?? undefined}>
                    👤 {formatUser(comment.created_by)}
                  </span>
                  <span className={styles.time}>{formatDate(comment.created_at)}</span>
                  {comment.processing === 'processing' && (
                    <span className={styles.processingBadge}>⏳ 解析中…</span>
                  )}
                  {canModify && comment.processing !== 'processing' && (
                    <div className={styles.itemActions}>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleEdit(comment)}
                        title="编辑"
                      >
                        ✏️
                      </button>
                      <button
                        className={styles.actionBtn}
                        onClick={() => handleDelete(comment)}
                        title="删除"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </div>

                {editing ? (
                  <div className={styles.editForm}>
                    {/* ── 内容 ── */}
                    <div className={styles.editGroup}>
                      <label className={styles.editLabel}>
                        内容 <span className={styles.editLabelHint}>{editContent.length}/500</span>
                      </label>
                      <textarea
                        className={styles.textarea}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        maxLength={2000}
                        rows={3}
                        placeholder="编辑评论…（支持 Markdown）"
                      />
                    </div>

                    {/* ── 附件（选填）── */}
                    <div className={styles.editGroup}>
                      <label className={styles.editLabel}>附件（选填）</label>
                      <FileChipGrid
                        files={editFiles}
                        onFilesAdded={(newFiles) => setEditFiles((prev) => [...prev, ...newFiles])}
                        onRemove={removeEditFile}
                        objectUrlsRef={editObjectUrlsRef}
                        existingAttachments={editExistingAttachments}
                        onRemoveExisting={(i) => setEditExistingAttachments((prev) => prev.filter((_, j) => j !== i))}
                      />
                    </div>

                    <div className={styles.editActions}>
                      <button
                        className={styles.cancelBtn}
                        onClick={handleCancelEdit}
                        disabled={saving}
                      >
                        取消
                      </button>
                      <button
                        className={styles.saveBtn}
                        onClick={() => handleSaveEdit(comment.id)}
                        disabled={saving || !editContent.trim()}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <CommentBody comment={comment} rehypePlugins={commentRehypePlugins} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
