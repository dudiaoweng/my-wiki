import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppProvider';
import { useCategories } from '../../hooks/useCategories';
import { useArticles } from '../../hooks/useArticles';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const { sidebarOpen, closeSidebar, openEditor, openUploader } = useApp();
  const { categories } = useCategories();
  const { articles } = useArticles();

  const getCount = (categoryId: string) =>
    articles.filter((a) => a.category_id === categoryId).length;

  return (
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
      <nav className={styles.nav}>
        <div className={styles.section}>
          <div className={styles.sectionLabel}>浏览</div>
          <NavLink
            to="/articles"
            end
            className={({ isActive }) =>
              `${styles.item} ${isActive ? styles.itemActive : ''}`
            }
            onClick={closeSidebar}
          >
            <span style={{ fontSize: 16 }}>📄</span> 所有文章
            <span className={styles.count}>{articles.length}</span>
          </NavLink>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>分类</div>
          {categories.map((cat) => (
            <NavLink
              key={cat.id}
              to={`/articles?category=${cat.id}`}
              className={({ isActive }) =>
                `${styles.item} ${isActive ? styles.itemActive : ''}`
              }
              onClick={closeSidebar}
            >
              <span className={styles.dot} style={{ background: cat.color }} />
              {cat.name}
              <span className={styles.count}>{getCount(cat.id)}</span>
            </NavLink>
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
