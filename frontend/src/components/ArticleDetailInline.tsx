import { useState, useEffect, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { api } from '../api/client';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { AttachmentGallery, useAttachments } from './AttachmentGallery';
import { createEntityHighlightPlugin } from '../utils/rehypeEntityHighlight';
import { useEntityOccurrences } from '../hooks/useEntityOccurrences';
import { EntityOccurrenceBar } from './EntityOccurrenceBar';
import type { Article } from '../types/article';
import styles from './ArticleDetailInline.module.css';

interface Props {
  articleId: string;
  onBack: () => void;
  prevArticleId?: string;
  nextArticleId?: string;
  onNavigate?: (id: string) => void;
  highlightEntity?: string | null;
  onClearHighlight?: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ArticleDetailInline({ articleId, onBack, prevArticleId, nextArticleId, onNavigate, highlightEntity, onClearHighlight }: Props) {
  const { openEditor, requestConfirm, notifyArticleSaved } = useApp();
  const { showToast } = useToast();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getArticle(articleId)
      .then(setArticle)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : '加载失败';
        setError(msg);
        showToast(msg, 'error');
      })
      .finally(() => setLoading(false));
  }, [articleId, showToast]);

  // Poll while background recognition is running
  useEffect(() => {
    if (!article || article.processing !== 'processing') return;
    const timer = setInterval(async () => {
      try {
        const updated = await api.getArticle(articleId);
        setArticle(updated);
        if (updated.processing !== 'processing') {
          clearInterval(timer);
          // Notify list to refresh (for sidebar count, card title, etc.)
          notifyArticleSaved();
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [article, articleId, notifyArticleSaved]);

  // Must be called before any early returns (Rules of Hooks)
  const { mediaItems, cleanContent } = useAttachments(article?.content ?? '', article?.attachment_name);

  // Entity highlighting — normalize optional prop to null
  const entityToHighlight = highlightEntity ?? null;

  const highlightPlugin = useMemo(
    () => createEntityHighlightPlugin(entityToHighlight),
    [entityToHighlight],
  );
  const rehypePlugins = useMemo(
    () => [rehypeRaw, highlightPlugin] as any,
    [highlightPlugin],
  );
  const {
    count: occurrenceCount,
    activeIndex: activeOccurrenceIndex,
    occurrences,
    scrollToOccurrence,
  } = useEntityOccurrences(cleanContent, entityToHighlight);

  if (loading) return <div className={styles.loading}>加载中…</div>;
  if (error) return <div className={styles.loading}>加载失败：{error}</div>;
  if (!article) return <div className={styles.loading}>文章不存在</div>;
  const catColor = article.category?.color ?? 'var(--c-text-muted)';
  const catName = article.category?.name ?? '未分类';

  const handleDelete = () => {
    requestConfirm('确认删除', `确定要删除「${article.title}」吗？`, async () => {
      try {
        await api.deleteArticle(articleId);
        showToast('文章已删除', 'success');
        notifyArticleSaved();
        onBack();
      } catch {
        showToast('删除失败', 'error');
      }
    });
  };

  return (
    <div className={styles.detail}>
      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <button className={styles.backBtn} onClick={onBack}>← 返回列表</button>
          {onNavigate && (
            <div className={styles.navGroup}>
              <button
                className={styles.navBtn}
                disabled={!prevArticleId}
                onClick={() => prevArticleId && onNavigate(prevArticleId)}
              >
                ← 上一篇
              </button>
              <button
                className={styles.navBtn}
                disabled={!nextArticleId}
                onClick={() => nextArticleId && onNavigate(nextArticleId)}
              >
                下一篇 →
              </button>
            </div>
          )}
        </div>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={() => openEditor(article.id)}>✏️ 编辑</button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>🗑 删除</button>
        </div>
      </div>

      <div className={styles.categoryLabel} style={{ color: catColor }}>{catName}</div>
      <h1 className={styles.title}>
        {article.title}
        {article.processing === 'processing' && (
          <span className={styles.processingBadge}>⏳ 解析中…</span>
        )}
      </h1>

      <div className={styles.meta}>
        <span>📅 {formatDate(article.created_at)}</span>
        <span>✏️ {formatDate(article.updated_at)}</span>
        <span>🔖 {article.entities?.entities?.length ?? 0} 个实体</span>
        <span>🔗 {article.entities?.relations?.length ?? 0} 个关系</span>
      </div>

      {article.tags.length > 0 && (
        <div className={styles.tags}>
          {article.tags.map((t) => (
            <span key={t} className={styles.tag}>{t}</span>
          ))}
        </div>
      )}

      <AttachmentGallery items={mediaItems} articleId={articleId} />

      <div className={`${styles.content} markdown-content`}>
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
          {cleanContent}
        </Markdown>

        {entityToHighlight && occurrenceCount > 0 && (
          <EntityOccurrenceBar
            entityName={entityToHighlight}
            entityType={article.entities?.entities?.find((e) => e.name === entityToHighlight)?.type}
            totalCount={occurrenceCount}
            activeIndex={activeOccurrenceIndex}
            occurrences={occurrences}
            onNavigate={scrollToOccurrence}
            onClose={() => onClearHighlight?.()}
          />
        )}
      </div>
    </div>
  );
}
