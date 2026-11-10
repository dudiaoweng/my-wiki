import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppProvider';
import { useCategories } from '../hooks/useCategories';
import { useArticles } from '../hooks/useArticles';
import { useToast } from '../hooks/useToast';
import { api } from '../api/client';
import { PositionField, type Position } from './PositionPicker';
import styles from './UploadModal.module.css';

const SUPPORTED_FORMATS = '.txt,.md,.docx,.xlsx,.pptx,.pdf,.mp3,.wav,.mp4,.avi,.mov,.csv,.json,.html,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp';

type Step = 'idle' | 'uploading' | 'done';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadModal() {
  const { uploaderOpen, uploaderPreset, closeUploader, notifyArticleSaved, requestConfirm } = useApp();
  const { categories } = useCategories();
  const { articles: allArticles, refetch: refetchArticles } = useArticles();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [file, setFile] = useState<File | null>(null);
  // 文章位置（目录 + 挂载位置归并）：parentId 为空 = 顶级文章
  const [position, setPosition] = useState<Position>({ categoryId: '', parentId: null });
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (uploaderOpen) {
      // 打开弹窗时刷新文章列表，保证位置树的文章数据最新
      refetchArticles();
      setFile(null);
      // 位置预设：侧边栏选中文章 > URL 目录参数
      setPosition({
        categoryId: uploaderPreset?.categoryId ?? searchParams.get('category') ?? '',
        parentId: uploaderPreset?.parentId ?? null,
      });
      setStep('idle');
      setError(null);
    }
  }, [uploaderOpen, uploaderPreset, refetchArticles, searchParams]);

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

  const performUpload = async () => {
    setError(null);
    setStep('uploading');

    try {
      setStep('uploading');
      const article = await api.uploadFile(file!, position.categoryId, position.parentId || undefined);

      setStep('done');
      showToast(
        position.parentId ? '文件上传成功，已创建为子文章' : '文件上传成功，文章已创建',
        'success',
      );
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

  const handleUpload = () => {
    if (!file) return;
    // 上传文件也必须选择位置（目录）
    if (!position.categoryId) {
      showToast('请选择位置（目录）', 'error');
      return;
    }

    // Check file size before uploading (backend limit: 500MB)
    const MAX_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      setError(`文件过大（${sizeMB}MB，最大 500MB）`);
      showToast(`文件过大（${sizeMB}MB，最大 500MB）`, 'error');
      return;
    }

    // 上传为子文章：确认后才继续，避免误挂载到当前文章下
    if (position.parentId) {
      const parentTitle = allArticles.find((a) => a.id === position.parentId)?.title;
      requestConfirm(
        '上传为子文章',
        `文件将作为「${parentTitle ?? '所选文章'}」的子文章上传，是否继续？`,
        performUpload,
        '继续上传',
        false,
      );
      return;
    }

    void performUpload();
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
          <h3>{position.parentId ? '上传文件（作为子文章）' : '上传文件'}</h3>
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

              {/* 文章位置（目录 + 挂载位置，与编辑器共用组件） */}
              <div className={styles.positionGroup}>
                <span className={styles.categoryLabel}>位置：</span>
                <PositionField
                  categories={categories}
                  articles={allArticles}
                  value={position}
                  onChange={setPosition}
                  onOpen={() => refetchArticles()}
                />
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
            disabled={!file || !position.categoryId || step !== 'idle'}
          >
            开始上传
          </button>
        </div>
      </div>
    </div>
  );
}
