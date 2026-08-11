import { useEffect, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppProvider';
import { useCategories } from '../../hooks/useCategories';
import { useArticles } from '../../hooks/useArticles';
import { useToast } from '../../hooks/useToast';
import styles from './Sidebar.module.css';

const CATEGORY_COLORS = [
  '#1E5C8A', '#7D5E3C', '#3D7B4F', '#A0524B',
  '#5B5A8C', '#C07B3A', '#4A7A8C', '#8C5260',
];

export function Sidebar() {
  const { sidebarOpen, closeSidebar, openEditor, openUploader, articleVersion, requestConfirm, userIdNumber } = useApp();
  const { categories, createCategory, updateCategory, deleteCategory } = useCategories();
  const { articles, refetch } = useArticles();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const activeCategoryId = searchParams.get('category');

  // Find the active category object
  const activeCategory = activeCategoryId
    ? categories.find((c) => c.id === activeCategoryId) ?? null
    : null;

  // Inline create state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(CATEGORY_COLORS[0]);

  // Inline edit state: which category id is being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  // Refetch when articles change (e.g. after upload)
  useEffect(() => {
    if (articleVersion > 0) {
      refetch();
    }
  }, [articleVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const getCount = (categoryId: string) =>
    articles.filter((a) => a.category_id === categoryId).length;

  const canModify = (cat: { created_by?: string | null }) => {
    if (!cat.created_by || !userIdNumber) return true;
    const idMatch = cat.created_by.match(/\d{18}/);
    return idMatch ? idMatch[0] === userIdNumber : false;
  };

  // ── Create ──
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const cat = await createCategory({ name, color: newColor });
    if (cat) {
      setShowCreate(false);
      setNewName('');
      setNewColor(CATEGORY_COLORS[0]);
    }
  };

  const cancelCreate = () => {
    setShowCreate(false);
    setNewName('');
    setNewColor(CATEGORY_COLORS[0]);
  };

  // ── Edit (from header button — operates on active category) ──
  const handleEditActive = () => {
    if (!activeCategory) return;
    setEditingId(activeCategory.id);
    setEditName(activeCategory.name);
    setEditColor(activeCategory.color);
  };

  const handleUpdate = async () => {
    const name = editName.trim();
    if (!name || !editingId) return;
    const cat = await updateCategory(editingId, { name, color: editColor });
    if (cat) {
      setEditingId(null);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  // ── Delete (from header button — operates on active category) ──
  const handleDeleteActive = () => {
    if (!activeCategory) return;

    // Check if category has articles — refuse on frontend side
    const articleCount = getCount(activeCategory.id);
    if (articleCount > 0) {
      showToast(
        `分类「${activeCategory.name}」下还有 ${articleCount} 篇文章，请先移除或转移文章后再删除`,
        'warning',
      );
      return;
    }

    requestConfirm('删除分类', `确定要删除分类「${activeCategory.name}」吗？`, () => {
      deleteCategory(activeCategory.id);
    });
  };

  return (
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
      <nav className={styles.nav}>
        <div className={styles.section}>
          <div className={styles.sectionLabel}>浏览</div>
          <NavLink
            to="/articles"
            className={`${styles.item} ${!activeCategoryId ? styles.itemActive : ''}`}
            onClick={closeSidebar}
          >
            <span style={{ fontSize: 16 }}>📄</span> 所有文章
            <span className={styles.count}>{articles.length}</span>
          </NavLink>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionLabel}>分类</div>
            <div className={styles.headerActions}>
              <button
                className={`${styles.headerActionBtn} ${styles.headerActionAdd}`}
                onClick={() => setShowCreate(!showCreate)}
                title="新建分类"
              >
                +
              </button>
              <button
                className={styles.headerActionBtn}
                onClick={handleEditActive}
                disabled={!activeCategory || !canModify(activeCategory)}
                title={activeCategory ? (canModify(activeCategory) ? `编辑「${activeCategory.name}」` : '只有创建人可以编辑') : '请先选择分类'}
              >
                ✎
              </button>
              <button
                className={`${styles.headerActionBtn} ${styles.headerActionDanger}`}
                onClick={handleDeleteActive}
                disabled={!activeCategory || !canModify(activeCategory)}
                title={activeCategory ? (canModify(activeCategory) ? `删除「${activeCategory.name}」` : '只有创建人可以删除') : '请先选择分类'}
              >
                ✕
              </button>
            </div>
          </div>

          {/* ── Inline create form ── */}
          {showCreate && (
            <div className={styles.catForm}>
              <input
                type="text"
                className={styles.catInput}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="分类名称…"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') cancelCreate();
                }}
              />
              <div className={styles.colorRow}>
                {CATEGORY_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`${styles.colorDot} ${newColor === c ? styles.colorDotActive : ''}`}
                    style={{ background: c }}
                    onClick={() => setNewColor(c)}
                    title={c}
                  />
                ))}
              </div>
              <div className={styles.formActions}>
                <button className={styles.formBtn} onClick={cancelCreate}>取消</button>
                <button className={`${styles.formBtn} ${styles.formBtnPrimary}`} onClick={handleCreate} disabled={!newName.trim()}>创建</button>
              </div>
            </div>
          )}

          {categories.map((cat) => (
            <div key={cat.id} className={styles.catRow}>
              {editingId === cat.id ? (
                /* ── Inline edit form ── */
                <div className={styles.catForm}>
                  <input
                    type="text"
                    className={styles.catInput}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleUpdate();
                      if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                  <div className={styles.colorRow}>
                    {CATEGORY_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`${styles.colorDot} ${editColor === c ? styles.colorDotActive : ''}`}
                        style={{ background: c }}
                        onClick={() => setEditColor(c)}
                        title={c}
                      />
                    ))}
                  </div>
                  <div className={styles.formActions}>
                    <button className={styles.formBtn} onClick={cancelEdit}>取消</button>
                    <button className={`${styles.formBtn} ${styles.formBtnPrimary}`} onClick={handleUpdate} disabled={!editName.trim()}>保存</button>
                  </div>
                </div>
              ) : (
                /* ── Normal row ── */
                <NavLink
                  to={`/articles?category=${cat.id}`}
                  className={`${styles.item} ${activeCategoryId === cat.id ? styles.itemActive : ''}`}
                  onClick={closeSidebar}
                >
                  <span className={styles.dot} style={{ background: cat.color }} />
                  <span className={styles.catName}>{cat.name}</span>
                  {cat.created_by && (
                    <span
                      className={styles.catCreator}
                      title={`创建人：${cat.created_by.replace(/\s+\d{18}$/, '')}${cat.created_at ? '\n创建时间：' + new Date(cat.created_at).toLocaleString('zh-CN') : ''}${cat.updated_at && cat.updated_at !== cat.created_at ? '\n更新时间：' + new Date(cat.updated_at).toLocaleString('zh-CN') : ''}`}
                    >👤</span>
                  )}
                  <span className={styles.count}>{getCount(cat.id)}</span>
                </NavLink>
              )}
            </div>
          ))}
        </div>
      </nav>

      <div className={styles.actions}>
        <button
          className={styles.newBtn}
          onClick={() => {
            openEditor(null);
            closeSidebar();
          }}
        >
          <span className={styles.newBtnIcon}>+</span> 新建文章
        </button>
        <button
          className={styles.uploadBtn}
          onClick={() => {
            openUploader();
            closeSidebar();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
            padding: '10px 16px',
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            marginTop: 8,
            transition: 'all var(--transition-fast)',
          }}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>↑</span> 上传文件
        </button>
      </div>
    </aside>
  );
}
