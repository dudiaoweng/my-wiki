import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { useCategories } from '../hooks/useCategories';
import { api } from '../api/client';
import type { Article } from '../types/article';
import styles from './EditorModal.module.css';

function getFileIcon(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'pdf': return '📕';
    case 'doc': case 'docx': return '📝';
    case 'xls': case 'xlsx': case 'csv': return '📊';
    case 'ppt': case 'pptx': return '📽';
    case 'txt': case 'md': case 'log': return '📄';
    case 'json': case 'xml': case 'yaml': case 'yml': case 'toml': return '📋';
    case 'py': case 'js': case 'ts': case 'jsx': case 'tsx': return '💻';
    case 'html': case 'htm': case 'css': case 'scss': return '🌐';
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return '📦';
    default: return '📎';
  }
}

export function EditorModal() {
  const { editorState, closeEditor, notifyArticleSaved } = useApp();
  const { categories } = useCategories();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isEdit = !!editorState?.articleId;

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<{name: string; type: string; thumbUrl?: string}[]>([]);
  const [saving, setSaving] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const originalContentRef = useRef('');
  const objectUrlsRef = useRef<string[]>([]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // Load article data when editing
  useEffect(() => {
    if (!editorState) return;
    // Clear attachments immediately — don't wait for API call
    setAttachments([]);
    setExistingAttachments([]);
    if (editorState.articleId) {
      api.getArticle(editorState.articleId).then((a) => {
        setTitle(a.title);
        setCategoryId(a.category_id ?? '');
        setTagsStr(a.tags.join(', '));
        // Parse existing media attachments from content.
        // Use a Set of unique keys (src/safeName) to dedup same files, while
        // allowing different files with the same original name to all appear.
        const existAtt: {name: string; type: string; thumbUrl?: string}[] = [];
        const seenKeys = new Set<string>();

        const tagRe = /<(img|video|audio)\s[^>]*\/?>/gi;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(a.content)) !== null) {
          const tag = m[0];
          const tagName = m[1].toLowerCase();
          const alt = (tag.match(/alt="([^"]*)"/i) ?? [])[1] || '';
          const src = (tag.match(/src="([^"]*)"/i) ?? [])[1] || '';
          const poster = (tag.match(/poster="([^"]*)"/i) ?? [])[1] || '';
          const srcName = src ? decodeURIComponent(src.split('/').pop()?.split('?')[0] ?? '') : '';
          const name = alt || srcName;
          const type = tagName === 'img' ? 'image' : tagName === 'video' ? 'video' : 'audio';
          const thumbUrl = type === 'image' ? src : type === 'video' ? (poster || src) : undefined;
          const key = src ? decodeURIComponent(src.split('/').pop()?.split('?')[0] ?? '') : ''; // safe_name from URL
          if (key && seenKeys.has(key)) continue;
          if (key) seenKeys.add(key);
          existAtt.push({name, type, thumbUrl});
        }
        // Also add document attachments from persistent markers in content
        const docMarkerRe = /<!-- doc-attachment: (.+?) \| (.+?) -->/gi;
        let dm: RegExpExecArray | null;
        while ((dm = docMarkerRe.exec(a.content)) !== null) {
          const docName = dm[1].trim();
          const safeName = dm[2].trim();
          const key = safeName; // safe_name is unique per uploaded file
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          existAtt.push({name: docName, type: 'document', thumbUrl: undefined});
        }
        // Also add document attachment from article data (legacy, no marker)
        if (a.attachment_name) {
          // key from attachment_path (safe name stored on disk)
          const key = a.attachment_name; // unique per article (only one legacy attachment)
          if (key && !seenKeys.has(key)) {
            // Also check against media items by matching attachment_name with safe_name pattern
            const alreadyViaMedia = existAtt.some((it) => {
              if (it.name === a.attachment_name) return true;
              const srcFile = (it.thumbUrl || '').split('/').pop()?.split('?')[0] ?? '';
              const safeMatch = srcFile.match(/^[a-f0-9]+_(.+)$/i);
              return safeMatch && safeMatch[1] === a.attachment_name;
            });
            if (!alreadyViaMedia) {
              seenKeys.add(key);
              existAtt.push({name: a.attachment_name!, type: 'document', thumbUrl: undefined});
            }
          }
        }

        // Sort existing attachments by upload order.
        // Walk the order list and assign each matching item its ORIGINAL position.
        const orderMatch2 = a.content.match(/<!-- attachments-order: (.+?) -->/);
        if (orderMatch2) {
          const orderList = orderMatch2[1].split(', ').map((s: string) => s.trim());
          const assigned = new Map<typeof existAtt[0], number>();
          for (let orderIdx = 0; orderIdx < orderList.length; orderIdx++) {
            const o = orderList[orderIdx];
            const match = existAtt.find((att) => !assigned.has(att) && o === att.name);
            if (match) {
              assigned.set(match, orderIdx);
            }
          }
          const idxMap = new Map(existAtt.map((att, i) => [att, i]));
          existAtt.sort((x, y) => {
            const xiNorm = assigned.has(x) ? assigned.get(x)! : 999 + (idxMap.get(x) ?? 0);
            const yiNorm = assigned.has(y) ? assigned.get(y)! : 999 + (idxMap.get(y) ?? 0);
            return xiNorm - yiNorm;
          });
        }

        setExistingAttachments(existAtt);
        // Strip media blocks — attachments shown as chips above
        const cleanContent = a.content
          .replace(/<(img|video|audio)\b[^>]*\/?>\s*/gi, '')     // opening tags
          .replace(/<\/(video|audio)>\s*/gi, '')                   // closing tags
          .replace(/<div data-attachment="[^"]*"[^>]*>[\s\S]*?<\/div>\s*/gi, '') // document placeholders
          .replace(/<!-- doc-attachment: .+? -->\s*/gi, '')        // persistent doc markers
          .replace(/<!-- attachments-order: .+? -->\s*/gi, '')     // order markers
          .replace(/#\s*(图片描述|视频|音频)[：:][^\n]*\n/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        setContent(cleanContent);
        originalContentRef.current = cleanContent;
      }).catch(() => showToast('Failed to load article', 'error'));
    } else {
      setTitle('');
      setCategoryId(searchParams.get('category') ?? '');
      setTagsStr('');
      setContent('');
      originalContentRef.current = '';
    }
    setTimeout(() => titleRef.current?.focus(), 100);
  }, [editorState, showToast]);

  if (!editorState) return null;

  const handleSave = async () => {
    setSaving(true);

    const tags = tagsStr
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (isEdit && editorState.articleId) {
        // Only include content if it actually changed (to avoid unnecessary LLM extraction)
        const updateData: { title: string; content?: string; category_id: string | null; tags: string[] } = {
          title: title.trim(),
          category_id: categoryId || null,
          tags,
        };
        if (content !== originalContentRef.current) {
          updateData.content = content;
        }
        await api.updateArticle(
          editorState.articleId, updateData,
          attachments.length > 0 ? attachments : undefined,
          existingAttachments.map((ea) => ea.name),
        );
        showToast('文章已更新', 'success');
      } else {
        const article = await api.createArticle({
          title: title.trim(),
          content,
          category_id: categoryId || null,
          tags,
        }, attachments.length > 0 ? attachments : undefined);
        showToast('文章已创建', 'success');
        // Same behavior as file upload: show inline detail with EntityPanel
        closeEditor();
        notifyArticleSaved();
        navigate(`/articles?view=${article.id}`);
        return;
      }
      closeEditor();
      notifyArticleSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '保存失败';
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeEditor();
  };

  return (
    <div className={`${styles.overlay} ${editorState ? styles.open : ''}`} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>{isEdit ? '编辑文章' : '新建文章'}</h3>
          <button className={styles.closeBtn} onClick={closeEditor}>✕</button>
        </div>

        <div className={styles.body}>
          <div className={styles.group}>
            <label className={styles.label}>标题（选填，留空则自动生成）</label>
            <input
              ref={titleRef}
              type="text"
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="文章标题…（留空则自动生成）"
            />
          </div>

          <div className={styles.group}>
            <label className={styles.label}>分类</label>
            <select
              className={styles.select}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">无分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>
              标签 <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--c-text-muted)' }}>（逗号分隔）</span>
            </label>
            <input
              type="text"
              className={styles.input}
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="例如: JavaScript, 教程, 前端"
            />
          </div>

          <div className={styles.group}>
            <label className={styles.label}>附件（选填）</label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className={styles.fileInput}
                onChange={(e) => {
                  const newFiles = Array.from(e.target.files ?? []);
                  if (newFiles.length > 0) {
                    setAttachments((prev) => [...prev, ...newFiles]);
                  }
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                accept=".txt,.md,.json,.xml,.csv,.yaml,.yml,.py,.js,.ts,.html,.css,.docx,.xlsx,.xls,.pptx,.ppt,.pdf,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.mp3,.wav,.m4a,.flac,.ogg,.mp4,.avi,.mov,.mkv,.webm"
              />
              <div className={styles.fileChips}>
                {/* Existing attachments */}
                {existingAttachments.map((ea, i) => {
                  const isImage = ea.type === 'image';
                  const isVideo = ea.type === 'video';
                  const isAudio = ea.type === 'audio';
                  return (
                    <div key={`existing-${ea.name}-${i}`} className={`${styles.fileChip} ${styles.fileChipExisting}`}>
                      <div className={styles.fileChipThumb}>
                        {ea.thumbUrl ? (
                          <img src={ea.thumbUrl} alt={ea.name} className={styles.fileChipImg} />
                        ) : (
                          <span className={styles.fileChipIcon}>
                            {isVideo ? '🎬' : isAudio ? '🎵' : getFileIcon(ea.name)}
                          </span>
                        )}
                        {isVideo && <span className={styles.fileChipPlay}>▶</span>}
                      </div>
                      <span className={styles.fileChipName}>{ea.name}</span>
                      <button
                        className={styles.fileChipRemove}
                        onClick={() => {
                          setExistingAttachments((prev) => prev.filter((_, j) => j !== i));
                        }}
                        title="移除已有附件"
                      >✕</button>
                    </div>
                  );
                })}
                {/* Newly added attachments */}
                {attachments.map((file, i) => {
                  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
                  const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp','ico','tiff','tif'].includes(ext);
                  const isVideo = ['mp4','avi','mov','mkv','webm','wmv'].includes(ext);
                  const isAudio = ['mp3','wav','m4a','flac','ogg','wma'].includes(ext);
                  const rawUrl = isImage ? URL.createObjectURL(file) : '';
                  if (rawUrl && !objectUrlsRef.current.includes(rawUrl)) {
                    objectUrlsRef.current.push(rawUrl);
                  }
                  const thumbUrl = rawUrl || undefined;
                  return (
                    <div key={`${file.name}-${i}`} className={styles.fileChip}>
                      <div className={styles.fileChipThumb}>
                        {thumbUrl ? (
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
                        onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                        title="移除"
                      >✕</button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className={styles.fileAddBtn}
                  onClick={() => fileInputRef.current?.click()}
                  title="添加附件"
                >
                  + 添加
                </button>
              </div>
              <span className={styles.hint}>
                支持文档、图片、音频、视频，保存后自动识别内容
              </span>
            </div>

          <div className={styles.group}>
            <label className={styles.label}>内容</label>
            <textarea
              className={styles.textarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={'使用 Markdown 编写内容…\n\n# 标题\n**粗体** *斜体* `代码`\n- 列表项'}
            />
            <span className={styles.hint}>
              支持 Markdown 语法：<code># 标题</code> <code>**粗体**</code> <code>`代码`</code> <code>- 列表</code> <code>&gt; 引用</code>
            </span>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.btn} onClick={closeEditor}>取消</button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中…' : (isEdit ? '更新' : '保存')}
          </button>
        </div>
      </div>
    </div>
  );
}
