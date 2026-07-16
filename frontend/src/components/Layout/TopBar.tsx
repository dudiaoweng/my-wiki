import { NavLink, Link } from 'react-router-dom';
import { useApp } from '../../context/AppProvider';
import styles from './TopBar.module.css';

export function TopBar() {
  const { toggleSidebar } = useApp();

  return (
    <div className={styles.topbar}>
      {/* Left: brand */}
      <div className={styles.left}>
        <button className={styles.menuBtn} onClick={toggleSidebar} aria-label="菜单">
          ☰
        </button>
        <Link to="/" className={styles.brand}>
          <span className={styles.logo}>K</span>
          <span className={styles.brandName}>知识库</span>
        </Link>
      </div>

      {/* Right: tools */}
      <div className={styles.right}>
        <NavLink
          to="/qa"
          className={({ isActive }) =>
            `${styles.toolBtn} ${isActive ? styles.toolBtnActive : ''}`
          }
          title="智能问答"
        >
          🤖 <span className={styles.toolLabel}>智能问答</span>
        </NavLink>
      </div>
    </div>
  );
}
