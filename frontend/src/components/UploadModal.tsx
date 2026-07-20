import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppProvider';
import { useCategories } from '../hooks/useCategories';
import { useToast } from '../hooks/useToast';
import { api } from '../api/client';
import styles from './UploadModal.module.css';

const SUPPORTED_FORMATS = '.txt,.md,.docx,.xlsx,.pptx,.pdf,.mp3,.wav,.mp4,.avi,.mov,.csv,.json,.html,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp';

type Step = 'idle' | 'uploading' | 'done';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadModal() {
  const { uploaderOpen, closeUploader, notifyArticleSaved } = useApp();
  const { categories } = useCategories();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [file, setFile] = useState<File | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (uploaderOpen) {
      setFile(null);
      setCategoryId(searchParams.get('category') ?? '');
      setStep('idle');
      setError(null);
    }
  }, [uploaderOpen]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  };

  const handleUpload = async () => {
    if (!file) return;

    setError(null);
    setStep('uploading');

    try {
      setStep('uploading');
      const article = await api.uploadFile(file, categoryId || undefined);

      setStep('done');
      showToast('文件上传成功，文章已创建', 'success');
      closeUploader();

      // Notify article list and sidebar to refresh
      notifyArticleSaved();

      // Navigate to the article list with inline detail view (shows EntityPanel on right)
      navigate(`/articles?view=${article.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '上传失败';
      setError(msg);
      setStep('idle');
      showToast(msg, 'error');
    }
  };

  if (!uploaderOpen) return null;

  const stepLabels: Record<Step, string> = {
    idle: '',
    uploading: '正在上传并解析文件…',
    done: '完成',
  };

  return (
    <div className={`${styles.overlay} ${styles.open}`} onClick={(e) => { if (e.target === e.currentTarget) closeUploader(); }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>上传文件</h3>
          <button className={styles.closeBtn} onClick={closeUploader} disabled={step !== 'idle' && step !== 'done'}>✕</button>
        </div>

        <div className={styles.body}>
          {step === 'idle' ? (
            <>
              {/* Drop zone */}
              <div
                className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
                role="button"
                tabIndex={0}
                aria-label="选择文件上传"
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                {file ? (
                  <div className={styles.fileInfo}>
                    <div className={styles.fileIcon}>
                      {file.type.startsWith('image/') ? '🖼️' :
                       file.type.includes('pdf') ? '📕' :
                       file.type.includes('word') || file.name.endsWith('.docx') ? '📝' :
                       file.type.includes('excel') || file.name.match(/\.xlsx?$/) ? '📊' :
                       file.type.includes('presentation') || file.name.match(/\.pptx?$/) ? '📽️' :
                       file.type.startsWith('audio/') ? '🎵' :
                       file.type.startsWith('video/') ? '🎬' : '📄'}
                    </div>
                    <div>
                      <div className={styles.fileName}>{file.name}</div>
                      <div className={styles.fileSize}>{formatFileSize(file.size)}</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.dropIcon}>📁</div>
                    <div className={styles.dropText}>拖拽文件到此处或点击选择</div>
                    <div className={styles.dropHint}>
                      支持 <code>.txt</code> <code>.md</code> <code>.docx</code> <code>.xlsx</code> <code>.pptx</code> <code>.pdf</code> <code>.jpg</code> <code>.png</code> 及音视频文件
                    </div>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={SUPPORTED_FORMATS}
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
              </div>

              {/* Category selector */}
              <div className={styles.categoryRow}>
                <span className={styles.categoryLabel}>分类：</span>
                <select
                  className={styles.categorySelect}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">无分类</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {error && <div className={styles.error}>{error}</div>}
            </>
          ) : (
            <div className={styles.progressSection}>
              <div className={styles.spinner} />
              <div className={styles.progressStep}>{stepLabels[step]}</div>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btn} onClick={closeUploader} disabled={step !== 'idle'}>
            取消
          </button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleUpload}
            disabled={!file || step !== 'idle'}
          >
            开始上传
          </button>
        </div>
      </div>
    </div>
  );
}
