import { createContext, useContext, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';

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
}

interface AppContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;

  editorState: EditorState | null;
  openEditor: (articleId?: string | null, preset?: { parentId?: string | null; categoryId?: string | null }) => void;
  closeEditor: () => void;

  confirmState: ConfirmState | null;
  requestConfirm: (title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string) => void;
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

  const requestConfirm = useCallback((title: string, message: string, onConfirm: () => void | Promise<void>, confirmLabel?: string) => {
    setConfirmState({ title, message, onConfirm, confirmLabel });
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

  const value = useMemo(() => ({
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    closeSidebar,
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
    userName,
    userIdNumber,
  }), [
    sidebarOpen, editorState, uploaderOpen, uploaderPreset, articleVersion,
    categoriesVersion,
    confirmState, toggleSidebar, closeSidebar, openEditor,
    closeEditor, openUploader, closeUploader, notifyArticleSaved,
    notifyCategoriesChanged, requestConfirm, closeConfirm, executeConfirm, searchInputRef,
    userName, userIdNumber,
  ]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}
