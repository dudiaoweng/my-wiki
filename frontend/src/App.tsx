import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppProvider';
import { ToastProvider } from './hooks/useToast';
import { Layout } from './components/Layout/Layout';
import { Hero } from './components/Hero';
import { ArticleList } from './components/ArticleList';
import { ArticleDetail } from './components/ArticleDetail';

import { QA } from './components/QA';
import { UploadModal } from './components/UploadModal';
import { EditorModal } from './components/EditorModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ToastContainer } from './components/Toast';
import { ReadingProgress } from './components/ReadingProgress';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

function KbShortcuts() {
  useKeyboardShortcuts();
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <ReadingProgress />
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Hero />} />
              <Route path="articles" element={<ArticleList />} />
              <Route path="articles/:id" element={<ArticleDetail />} />

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
