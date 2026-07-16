import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useApp } from '../../context/AppProvider';
import styles from './Layout.module.css';

/** Routes that should fill the full width (no sidebar) */
const FULL_WIDTH_ROUTES = ['/qa'];

export function Layout() {
  const { sidebarOpen, closeSidebar } = useApp();
  const location = useLocation();
  const hideSidebar = FULL_WIDTH_ROUTES.some((path) =>
    location.pathname.startsWith(path)
  );

  return (
    <div className={styles.shell}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className={styles.overlay} onClick={closeSidebar} />
      )}
      <TopBar />
      <div className={styles.body}>
        {!hideSidebar && <Sidebar />}
        <main className={`${styles.main} ${hideSidebar ? styles.mainFull : ''}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
