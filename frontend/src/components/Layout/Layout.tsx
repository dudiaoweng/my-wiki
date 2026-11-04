import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { KeepAliveOutlet, FrozenRouter } from './KeepAliveOutlet';
import { useApp } from '../../context/AppProvider';
import styles from './Layout.module.css';

/** Routes that should fill the full width (no sidebar)。
    智能问答已改为最右侧面板样式，保留侧边栏，不再全宽。 */
const FULL_WIDTH_ROUTES: string[] = [];

export function Layout() {
  const { sidebarOpen, closeSidebar, sidebarCollapsed } = useApp();
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
        {/* 侧边栏也保活：缩进/隐藏时不卸载，路由上下文冻结 */}
        <div
          className={
            hideSidebar
              ? styles.sidebarSlotHidden
              : sidebarCollapsed
                ? styles.sidebarSlotCollapsed
                : styles.sidebarSlot
          }
        >
          <FrozenRouter freeze={hideSidebar}>
            <Sidebar />
          </FrozenRouter>
        </div>
        <main className={`${styles.main} ${hideSidebar ? styles.mainFull : ''}`}>
          {/* 保活出口：QA 与文章窗口切换不卸载、数据不清理 */}
          <KeepAliveOutlet />
        </main>
      </div>
    </div>
  );
}
