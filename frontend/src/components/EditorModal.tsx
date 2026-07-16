import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { useCategories } from '../hooks/useCategories';
import { api } from '../api/client';
import type { Article } from '../types/article';
import styles from './EditorModal.module.css';

const CATEGORY_COLORS = [
  '#1E5C8A', '#7D5E3C', '#3D7B4F', '#A0524B',
  '#5B5A8C', '#C07B3A', '#4A7A8C', '#8C5260',
];

export function EditorModal() {
  const { editorState, closeEditor, notifyArticleSaved } = useApp();
  const { categories, createCategory } = useCategories();
  const { showToast } = useToast();

  const isEdit = !!editorState?.articleId;

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [content, setContent] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState(CATEGORY_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);

  // Load article data when editing
  useEffect(() => {
    if (!editorState) return;
    if (editorState.articleId) {
      api.getArticle(editorState.articleId).then((a) => {
        setTitle(a.title);
        setCategoryId(a.category_id ?? '');
        setTagsStr(a.tags.join(', '));
        setContent(a.content);
      }).catch(() => showToast('Failed to load article', 'error'));
    } else {
      setTitle('');
      setCategoryId('');
      setTagsStr('');
      setContent('');
    }
    setNewCatName('');
    setNewCatColor(CATEGORY_COLORS[0]);
    setTimeout(() => titleRef.current?.focus(), 100);
  }, [editorState, showToast]);

  if (!editorState) return null;

  const handleCreateCategory = async () => {
    const name = newCatName.trim();
    if (!name) return;
    const exists = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast('该分类已存在', 'warning');
      return;
    }
    const usedColors = new Set(categories.map((c) => c.color));
    const color = CATEGORY_COLORS.find((c) => !usedColors.has(c))
      ?? CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length];
    const cat = await createCategory({ name, color: newCatColor });
    if (cat) {
      setCategoryId(cat.id);
      setNewCatName('');
      showToast(`分类「${name}」已创建`, 'success');
    }
  };

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

    const data = {
      title: title.trim(),
      content,
      category_id: categoryId || null,
      tags,
    };

    try {
      if (isEdit && editorState.articleId) {
        await api.updateArticle(editorState.articleId, data);
        showToast('文章已更新', 'success');
      } else {
        await api.createArticle(data);
        showToast('文章已创建', 'success');
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
            <div className={styles.row}>
              <select
                className={styles.select}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">无分类</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.row} style={{ marginTop: 4 }}>
              <input
                type="text"
                className={styles.input}
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="新建分类名称…"
                style={{ flex: 1 }}
              />
              <button className={styles.btn} onClick={handleCreateCategory}>
                + 分类
              </button>
            </div>
            {newCatName && (
              <div className={styles.dotPicker}>
                {CATEGORY_COLORS.map((color) => (
                  <span key={color}>
                    <input
                      type="radio"
                      id={`color-${color}`}
                      name="newCatColor"
                      value={color}
                      checked={newCatColor === color}
                      onChange={() => setNewCatColor(color)}
                    />
                    <label htmlFor={`color-${color}`} style={{ background: color }} />
                  </span>
                ))}
              </div>
            )}
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
