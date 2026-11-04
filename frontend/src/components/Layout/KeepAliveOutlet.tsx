import {
  useContext, useRef, useState, type ReactNode,
} from 'react';
import { useLocation, useOutlet } from 'react-router-dom';
import {
  UNSAFE_LocationContext as LocationContext,
  UNSAFE_NavigationContext as NavigationContext,
  UNSAFE_RouteContext as RouteContext,
} from 'react-router';
import { useApp } from '../../context/AppProvider';
import { QA } from '../QA';
import styles from './KeepAliveOutlet.module.css';

/** 保活窗口标识：智能问答与文章（列表/详情/首页）各为一个窗口 */
function windowKey(pathname: string): string {
  if (pathname === '/qa') return 'qa';
  if (pathname === '/articles') return 'articles';
  if (pathname.startsWith('/articles/')) return 'article';
  return 'home';
}

interface Snapshot {
  navigation: React.ContextType<typeof NavigationContext>;
  location: React.ContextType<typeof LocationContext>;
  route: React.ContextType<typeof RouteContext>;
}

/**
 * 冻结路由上下文包装器：freeze 期间用最后一次非冻结渲染的快照
 * （location/navigator/params）替换实时上下文，URL 变化不影响内部状态；
 * 解冻后恢复实时上下文。配合 display:none 实现「保持挂载 + 状态冻结」。
 */
export function FrozenRouter({ freeze, children }: { freeze: boolean; children: ReactNode }) {
  const navCtx = useContext(NavigationContext);
  const locCtx = useContext(LocationContext);
  const routeCtx = useContext(RouteContext);
  const snapRef = useRef<Snapshot | null>(null);

  if (!freeze) {
    snapRef.current = { navigation: navCtx, location: locCtx, route: routeCtx };
  }
  const ctx = freeze && snapRef.current
    ? snapRef.current
    : { navigation: navCtx, location: locCtx, route: routeCtx };

  return (
    <NavigationContext.Provider value={ctx.navigation}>
      <LocationContext.Provider value={ctx.location}>
        <RouteContext.Provider value={ctx.route}>{children}</RouteContext.Provider>
      </LocationContext.Provider>
    </NavigationContext.Provider>
  );
}

/**
 * 保活式路由出口：窗口切换不卸载、数据不清理。
 *
 * 每个窗口首次渲染后保持挂载（display:none 隐藏）。隐藏期间用冻结的
 * 路由上下文（location/navigator/params 快照）包裹，URL 变化不会干扰
 * 隐藏窗口内部状态（筛选、分页、选中、问答输入等）；重新激活时恢复
 * 实时上下文，且元素引用不变（React 直接跳过重渲染，状态原样保留）。
 */
export function KeepAliveOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  const navCtx = useContext(NavigationContext);
  const locCtx = useContext(LocationContext);
  const routeCtx = useContext(RouteContext);

  const activeKey = windowKey(location.pathname);
  const elsRef = useRef<Map<string, ReactNode>>(new Map());
  const snapRef = useRef<Map<string, Snapshot>>(new Map());
  const [rendered, setRendered] = useState<Set<string>>(new Set([activeKey]));

  // 渲染期登记：活动窗口更新元素与上下文快照；新窗口加入保活集合
  elsRef.current.set(activeKey, outlet);
  snapRef.current.set(activeKey, { navigation: navCtx, location: locCtx, route: routeCtx });
  if (!rendered.has(activeKey)) {
    setRendered(new Set([...rendered, activeKey]));
  }

  const { qaOpen } = useApp();

  const windows = () => (
    <>
      {Array.from(rendered).map((k) => {
        const el = elsRef.current.get(k);
        const isActive = k === activeKey;
        const ctx = isActive
          ? { navigation: navCtx, location: locCtx, route: routeCtx }
          : snapRef.current.get(k)!;
        return (
          <div
            key={k}
            className={isActive ? `${styles.window} ${styles.windowActive}` : styles.window}
            aria-hidden={!isActive}
          >
            <NavigationContext.Provider value={ctx.navigation}>
              <LocationContext.Provider value={ctx.location}>
                <RouteContext.Provider value={ctx.route}>
                  {el}
                </RouteContext.Provider>
              </LocationContext.Provider>
            </NavigationContext.Provider>
          </div>
        );
      })}
    </>
  );

  // 智能问答面板开启且不在问答窗口时：活动窗口 + 问答面板并排。
  // 窗口容器在两种模式下保持同一树位置（仅切换 className），
  // 开关问答面板不触发其他窗口卸载重挂 → 内容不刷新。
  const splitMode = qaOpen && activeKey !== 'qa';
  return (
    <div className={splitMode ? styles.split : styles.plain}>
      <div className={`${styles.mainPane}${splitMode ? ` ${styles.splitMain}` : ''}`}>
        {windows()}
      </div>
      {splitMode && (
        <div className={styles.splitQa}>
          <QA />
        </div>
      )}
    </div>
  );
}
