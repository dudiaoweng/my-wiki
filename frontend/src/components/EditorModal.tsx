import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { useCategories } from '../hooks/useCategories';
import { api } from '../api/client';
import type { Article } from '../types/article';
import styles from './EditorModal.module.css';

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
  const [saving, setSaving] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const originalContentRef = useRef('');

  // Load article data when editing
  useEffect(() => {
    if (!editorState) return;
    if (editorState.articleId) {
      api.getArticle(editorState.articleId).then((a) => {
        setTitle(a.title);
        setCategoryId(a.category_id ?? '');
        setTagsStr(a.tags.join(', '));
        setContent(a.content);
        originalContentRef.current = a.content;
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
    if (!title.trim()) {
      showToast('请输入文章标题', 'warning');
      titleRef.current?.focus();
      return;
    }
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
        await api.updateArticle(editorState.articleId, updateData);
        showToast('文章已更新', 'success');
      } else {
        const article = await api.createArticle({
          title: title.trim(),
          content,
          category_id: categoryId || null,
          tags,
        });
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
            <label className={styles.label}>标题</label>
            <input
              ref={titleRef}
              type="text"
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="文章标题…"
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
