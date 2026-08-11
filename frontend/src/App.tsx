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
  import('./components/ArticleDetailPage').then((m) => ({ default: m.ArticleDetail })),
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
    // Production: no cert → show login; Dev: should not happen
    return isDev ? 'denied' as const : 'login' as const;
  }, []);

  useEffect(() => {
    // Clean up ?auth=1 left by the /api/auth/login redirect.
    const params = new URLSearchParams(window.location.search);
    const cameFromLogin = params.has('auth');
    if (cameFromLogin) {
      params.delete('auth');
      const newSearch = params.toString();
      const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '');
      window.history.replaceState(null, '', newUrl);
    }

    // Port 8000 (CERT_NONE): always show login page — no API access here.
    // Port 8443 (CERT_REQUIRED): always check auth — TLS layer already
    //     verified the cert; if the browser cached the cert choice, login is
    //     transparent; otherwise the TLS connection itself fails.
    // Dev mode: Vite dev server on :5173, always check auth.
    const isLoginPort = !isDev && window.location.port === '8000';
    if (isLoginPort && !cameFromLogin) {
      setAuthState('login');
      return;
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
      }
      setAuthState('login');
    };
    window.addEventListener('auth:forbidden', handler);
    return () => window.removeEventListener('auth:forbidden', handler);
  }, []);

  const handleLogin = () => {
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
    // Only reached in dev mode when backend is unreachable
    return <CertErrorPage />;
  }

  if (authState === 'login') {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--c-page)', overflow: 'auto',
      }}>
        <div style={{
          display: 'flex',
          flexDirection: isDev ? 'row' : 'column',
          alignItems: 'center', gap: isDev ? 48 : 0,
        }}>
          <Hero />
          <LoginPage onLogin={handleLogin} />
        </div>
      </div>
    );
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
