import { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppProvider';
import { ToastProvider } from './hooks/useToast';
import { Layout } from './components/Layout/Layout';
import { Hero } from './components/Hero';
import { ArticleList } from './components/ArticleList';

import { QA } from './components/QA';
import { UploadModal } from './components/UploadModal';
import { EditorModal } from './components/EditorModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ToastContainer } from './components/Toast';
import { ReadingProgress } from './components/ReadingProgress';
import { CertErrorPage } from './components/CertErrorPage';
import { LoginPage } from './components/LoginPage';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { checkAuthStatus, getStoredDevUser, clearStoredDevUser } from './api/auth';

const ArticleDetail = lazy(() =>
  import('./components/ArticleDetail').then((m) => ({ default: m.ArticleDetail })),
);

function KbShortcuts() {
  useKeyboardShortcuts();
  return null;
}

const isDev = import.meta.env.DEV;

type AuthState = 'loading' | 'login' | 'ok' | 'denied';

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [userName, setUserName] = useState('');
  const [userIdNumber, setUserIdNumber] = useState('');

  const checkAuth = useCallback(async () => {
    // Dev mode: need a selected user first
    if (isDev) {
      const stored = getStoredDevUser();
      if (!stored) return 'login' as const;
    }

    const result = await checkAuthStatus();
    if (result?.authenticated) {
      const name = result.name || result.display_name || '';
      setUserName(name);
      setUserIdNumber(result.id_number || '');
      return 'ok' as const;
    }
    return 'denied' as const;
  }, []);

  useEffect(() => {
    // Clean up ?auth=1 left by the /api/auth/login redirect (production mode).
    const params = new URLSearchParams(window.location.search);
    if (params.has('auth')) {
      params.delete('auth');
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '');
      window.history.replaceState(null, '', newUrl);
    }

    (async () => {
      const state = await checkAuth();
      setAuthState(state);
    })();
  }, [checkAuth]);

  useEffect(() => {
    const handler = () => {
      if (isDev) {
        clearStoredDevUser();
        setAuthState('login');
      } else {
        setAuthState('denied');
      }
    };
    window.addEventListener('auth:forbidden', handler);
    return () => window.removeEventListener('auth:forbidden', handler);
  }, []);

  const handleDevLogin = () => {
    // User is already stored in sessionStorage by LoginPage.
    // Re-run checkAuth — the proxy will now forward requests with the
    // selected client cert, and the backend returns the real CN.
    setAuthState('loading');
    checkAuth().then(setAuthState);
  };

  if (authState === 'loading') {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--c-text-muted)' }}>
        验证身份…
      </div>
    );
  }

  if (authState === 'denied') {
    return <CertErrorPage />;
  }

  if (authState === 'login') {
    return <LoginPage onLogin={handleDevLogin} />;
  }

  return (
    <BrowserRouter>
      <ToastProvider>
        <AppProvider userName={userName} userIdNumber={userIdNumber}>
          <ReadingProgress />
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Hero />} />
              <Route path="articles" element={<ArticleList />} />
              <Route
                path="articles/:id"
                element={
                  <Suspense fallback={<div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--c-text-muted)' }}>加载中…</div>}>
                    <ArticleDetail />
                  </Suspense>
                }
              />
              <Route path="qa" element={<QA />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <EditorModal />
          <UploadModal />
          <ConfirmDialog />
          <ToastContainer />
          <KbShortcuts />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
