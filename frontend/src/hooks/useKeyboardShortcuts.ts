import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppProvider';

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();
  const { searchInputRef, openEditor, closeEditor, editorState, confirmState, closeConfirm } = useApp();
  const focusTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.ctrlKey || e.metaKey;

      if (isCmdOrCtrl && e.key === 'k') {
        e.preventDefault();
        if (location.pathname === '/') navigate('/articles');
        focusTimerRef.current = setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      if (isCmdOrCtrl && e.key === 'n') {
        e.preventDefault();
        openEditor(null);
        return;
      }

      if (e.key === 'Escape') {
        if (confirmState) {
          closeConfirm();
        } else if (editorState?.isOpen) {
          closeEditor();
        } else if (location.pathname.startsWith('/articles/') && location.pathname.split('/').length === 3) {
          navigate('/articles');
        }
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    };
  }, [navigate, location, searchInputRef, openEditor, closeEditor, editorState, confirmState, closeConfirm]);
}
