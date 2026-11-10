import { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AdvancedSearchCondition } from '../api/client';
import type { ViewMode } from '../components/EntityPanel';

interface EditorState {
  isOpen: boolean;
  articleId: string | null; // null = create mode
  /** create 模式预选父文章（如「添加子文章」入口） */
  parentId?: string | null;
  /** create 模式预选目录 */
  categoryId?: string | null;
}

interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  /** false = 普通操作确认（主题色按钮）；默认 true = 危险操作（红色按钮） */
  danger?: boolean;
}

interface AppContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  /** 桌面端侧边栏缩进（隐藏，主区扩展）；移动端仍为抽屉，不受此状态影响 */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;

  editorState: EditorState | null;
  openEditor: (articleId?: string | null, preset?: { parentId?: string | null; categoryId?: string | null }) => void;
  closeEditor: () => void;

  confirmState: ConfirmState | null;
  requestConfirm: (title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string, danger?: boolean) => void;
  closeConfirm: () => void;
  executeConfirm: () => void;

  uploaderOpen: boolean;
  openUploader: (preset?: { parentId?: string | null; categoryId?: string | null }) => void;
  closeUploader: () => void;
  /** 上传弹窗打开时的位置预设（如从侧边栏选中文章发起） */
  uploaderPreset: { parentId?: string | null; categoryId?: string | null } | null;

  articleVersion: number;
  notifyArticleSaved: () => void;

  categoriesVersion: number;
  notifyCategoriesChanged: () => void;

  searchInputRef: React.RefObject<HTMLInputElement>;

  /** 左上角图标：在智能问答与文章窗口间切换（保活，数据不清理） */
  switchWindow: () => void;

  /** 高级搜索：已提交的条件（文章列表 adv 模式据此取数；与顶部搜索框融合提交） */
  advancedSearch: AdvancedSearchCondition[] | null;
  setAdvancedSearch: (conditions: AdvancedSearchCondition[] | null) => void;
  /** 高级搜索结果中的目录筛选（结果根目录视图中点击目录进入；null = 全部结果） */
  advCategoryId: string | null;
  setAdvCategoryId: (categoryId: string | null) => void;

  /** 智能问答面板开关：开启时与文章/实体窗口并排显示在最右侧 */
  qaOpen: boolean;
  setQaOpen: (v: boolean) => void;

  /** 实体面板视图模式（列表/知识图谱）：由顶部工具栏「知识图谱」按钮切换 */
  entityPanelMode: ViewMode;
  setEntityPanelMode: (mode: ViewMode) => void;

  /** 跨组件拖拽（侧边栏 ⇄ 文章列表相互移动）：拖拽源与当前悬停目标 */
  dragRef: React.MutableRefObject<{ type: 'cat' | 'article'; id: string } | null>;
  dropTarget: string | null;
  setDropTarget: (v: string | null) => void;
  startDrag: (e: React.DragEvent<HTMLElement>, type: 'cat' | 'article', id: string, allowed: boolean) => void;
  dragOverTarget: (e: React.DragEvent<HTMLElement>, key: string) => void;
  clearDropTarget: (key: string) => void;

  /** Current authenticated user name (from mTLS cert CN or dev user selection) */
  userName: string;
  /** Full ID number from the certificate CN (shown in tooltip) */
  userIdNumber: string;
}

const AppContext = createContext<AppContextValue>(null!);

export function useApp() {
  return useContext(AppContext);
}

interface AppProviderProps {
  children: ReactNode;
  userName?: string;
  userIdNumber?: string;
}

export function AppProvider({ children, userName = '', userIdNumber = '' }: AppProviderProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [articleVersion, setArticleVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null!); // ref is always attached before use

  const toggleSidebar = useCallback(() => setSidebarOpen((p) => !p), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((p) => !p), []);

  const openEditor = useCallback((
    articleId: string | null = null,
    preset?: { parentId?: string | null; categoryId?: string | null },
  ) => {
    setEditorState({
      isOpen: true,
      articleId,
      parentId: preset?.parentId,
      categoryId: preset?.categoryId,
    });
  }, []);
  const closeEditor = useCallback(() => setEditorState(null), []);

  const [uploaderPreset, setUploaderPreset] = useState<{ parentId?: string | null; categoryId?: string | null } | null>(null);
  const openUploader = useCallback((preset?: { parentId?: string | null; categoryId?: string | null }) => {
    setUploaderPreset(preset ?? null);
    setUploaderOpen(true);
  }, []);
  const closeUploader = useCallback(() => setUploaderOpen(false), []);

  const requestConfirm = useCallback((title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string, danger?: boolean) => {
    setConfirmState({ title, message, onConfirm, confirmLabel, danger });
  }, []);
  const closeConfirm = useCallback(() => setConfirmState(null), []);
  const confirmRef = useRef<ConfirmState | null>(null);
  confirmRef.current = confirmState;
  const executeConfirm = useCallback(async () => {
    try {
      await confirmRef.current?.onConfirm();
    } catch {
      // errors handled by the callback's own catch blocks
    }
    setConfirmState(null);
  }, []);

  const notifyArticleSaved = useCallback(() => setArticleVersion((v) => v + 1), []);
  const [categoriesVersion, setCategoriesVersion] = useState(0);
  const notifyCategoriesChanged = useCallback(() => setCategoriesVersion((v) => v + 1), []);

  // ── 窗口切换（左上角图标）：智能问答 ⇄ 文章窗口 ──
  // 记录文章窗口最后地址（含查询串），从 QA 切回时回到离开前的位置；
  // location 放 ref 保证 switchWindow 引用稳定（context value 不变不引发全树重渲染）
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  locationRef.current = location;
  const articlesPathRef = useRef('/articles');
  useEffect(() => {
    const p = location.pathname;
    if (p === '/articles' || p.startsWith('/articles/')) {
      articlesPathRef.current = location.pathname + location.search;
    }
  }, [location]);

  const switchWindow = useCallback(() => {
    if (locationRef.current.pathname === '/qa') {
      navigate(articlesPathRef.current || '/articles');
    } else {
      navigate('/qa');
    }
  }, [navigate]);

  // ── 高级搜索（条件由顶部搜索框面板提交）──
  const [advancedSearch, setAdvancedSearch] = useState<AdvancedSearchCondition[] | null>(null);
  const [advCategoryId, setAdvCategoryId] = useState<string | null>(null);

  // ── 智能问答面板开关（与文章/实体窗口并排）──
  const [qaOpen, setQaOpen] = useState(false);

  // ── 实体面板视图模式：列表 ⇄ 知识图谱（顶部工具栏「知识图谱」按钮切换）──
  const [entityPanelMode, setEntityPanelMode] = useState<ViewMode>('list');

  // ── 跨组件拖拽（侧边栏 ⇄ 文章列表）：拖拽源 ref + 悬停目标状态 ──
  const dragRef = useRef<{ type: 'cat' | 'article'; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const startDrag = useCallback((
    e: React.DragEvent<HTMLElement>,
    type: 'cat' | 'article',
    id: string,
    allowed: boolean,
  ) => {
    if (!allowed) {
      e.preventDefault();
      return;
    }
    dragRef.current = { type, id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const dragOverTarget = useCallback((e: React.DragEvent<HTMLElement>, key: string) => {
    e.preventDefault();
    e.stopPropagation(); // 防止冒泡到外层行覆盖高亮目标
    e.dataTransfer.dropEffect = 'move';
    setDropTarget((t) => (t === key ? t : key));
  }, []);

  const clearDropTarget = useCallback((key: string) => {
    setDropTarget((t) => (t === key ? null : t));
  }, []);

  // 拖拽结束（含中途取消）：清理拖拽源与悬停高亮
  useEffect(() => {
    const onDragEnd = () => {
      dragRef.current = null;
      setDropTarget(null);
    };
    window.addEventListener('dragend', onDragEnd);
    return () => window.removeEventListener('dragend', onDragEnd);
  }, []);

  const value = useMemo(() => ({
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    closeSidebar,
    sidebarCollapsed,
    toggleSidebarCollapsed,
    editorState,
    openEditor,
    closeEditor,
    uploaderOpen,
    openUploader,
    closeUploader,
    uploaderPreset,
    articleVersion,
    notifyArticleSaved,
    categoriesVersion,
    notifyCategoriesChanged,
    confirmState,
    requestConfirm,
    closeConfirm,
    executeConfirm,
    searchInputRef,
    switchWindow,
    qaOpen,
    setQaOpen,
    entityPanelMode,
    setEntityPanelMode,
    advancedSearch,
    setAdvancedSearch,
    advCategoryId,
    setAdvCategoryId,
    dragRef,
    dropTarget,
    setDropTarget,
    startDrag,
    dragOverTarget,
    clearDropTarget,
    userName,
    userIdNumber,
  }), [
    sidebarOpen, sidebarCollapsed, toggleSidebarCollapsed,
    editorState, uploaderOpen, uploaderPreset, articleVersion,
    categoriesVersion,
    confirmState, toggleSidebar, closeSidebar, openEditor,
    closeEditor, openUploader, closeUploader, notifyArticleSaved,
    notifyCategoriesChanged, requestConfirm, closeConfirm, executeConfirm, searchInputRef,
    switchWindow, qaOpen, setQaOpen, entityPanelMode, setEntityPanelMode, advancedSearch, setAdvancedSearch, advCategoryId, setAdvCategoryId,
    dragRef, dropTarget, setDropTarget, startDrag, dragOverTarget, clearDropTarget,
    userName, userIdNumber,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}
