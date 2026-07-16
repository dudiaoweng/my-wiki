import { createContext, useContext, useState, useRef, type ReactNode } from 'react';

interface EditorState {
  isOpen: boolean;
  articleId: string | null; // null = create mode
}

interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface AppContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;

  editorState: EditorState | null;
  openEditor: (articleId?: string | null) => void;
  closeEditor: () => void;

  confirmState: ConfirmState | null;
  requestConfirm: (title: string, message: string, onConfirm: () => void) => void;
  closeConfirm: () => void;
  executeConfirm: () => void;

  uploaderOpen: boolean;
  openUploader: () => void;
  closeUploader: () => void;

  articleVersion: number;
  notifyArticleSaved: () => void;

  searchInputRef: React.RefObject<HTMLInputElement>;
}

const AppContext = createContext<AppContextValue>(null!);

export function useApp() {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [articleVersion, setArticleVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null!);

  const toggleSidebar = () => setSidebarOpen((p) => !p);
  const closeSidebar = () => setSidebarOpen(false);

  const openEditor = (articleId: string | null = null) => {
    setEditorState({ isOpen: true, articleId });
  };
  const closeEditor = () => setEditorState(null);

  const openUploader = () => setUploaderOpen(true);
  const closeUploader = () => setUploaderOpen(false);

  const requestConfirm = (title: string, message: string, onConfirm: () => void) => {
    setConfirmState({ title, message, onConfirm });
  };
  const closeConfirm = () => setConfirmState(null);
  const executeConfirm = () => {
    confirmState?.onConfirm();
    setConfirmState(null);
  };

  return (
    <AppContext.Provider
      value={{
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
        articleVersion,
        notifyArticleSaved: () => setArticleVersion((v) => v + 1),
        confirmState,
        requestConfirm,
        closeConfirm,
        executeConfirm,
        searchInputRef,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
