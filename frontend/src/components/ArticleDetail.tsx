import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { api } from '../api/client';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { AttachmentGallery, useAttachments } from './AttachmentGallery';
import { CommentSection } from './CommentSection';
import { createEntityHighlightPlugin } from '../utils/rehypeEntityHighlight';
import { createSearchHighlightPlugin } from '../utils/rehypeSearchHighlight';
import { useEntityOccurrences } from '../hooks/useEntityOccurrences';
import { useArticleSearch } from '../hooks/useArticleSearch';
import { EntityOccurrenceBar } from './EntityOccurrenceBar';
import { SearchNavBar } from './SearchNavBar';
import type { Article } from '../types/article';
import styles from './ArticleDetail.module.css';

// ─── Helpers ────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function formatUser(cn: string | null): string {
  if (!cn) return '';
  const match = cn.match(/^(.+?)\s+\d{18}$/);
  return match ? match[1] : cn;
}

// ─── Shared article detail view ─────────────────────

interface ArticleDetailViewProps {
  articleId: string;
  onBack: () => void;
  prevArticleId?: string;
  nextArticleId?: string;
  onNavigate?: (id: string) => void;
  /** Selected entity name (works for both EntityPanel-driven and local state). */
  selectedEntity?: string | null;
  /** Called when user selects or clears an entity. */
  onEntitySelect?: (name: string | null) => void;
  /** Called when user clicks a tag (page mode navigates to tag filter). */
  onTagClick?: (tag: string) => void;
  /** Show edit/delete buttons in top bar instead of at page bottom. */
  actionsInTopBar?: boolean;
}

export function ArticleDetailView({
  articleId, onBack, prevArticleId, nextArticleId, onNavigate,
  selectedEntity, onEntitySelect, onTagClick, actionsInTopBar,
}: ArticleDetailViewProps) {
  const { openEditor, requestConfirm, notifyArticleSaved, articleVersion, userIdNumber } = useApp();
  const { showToast } = useToast();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentTexts, setCommentTexts] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);

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
          notifyArticleSaved();
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [article, articleId, notifyArticleSaved]);

  // Re-fetch article when articleVersion changes (e.g. after editing in EditorModal)
  const prevVersionRef = useRef(articleVersion);
  useEffect(() => {
    if (prevVersionRef.current !== articleVersion) {
      prevVersionRef.current = articleVersion;
      api.getArticle(articleId).then(setArticle).catch(() => {});
    }
  }, [articleVersion, articleId]);

  // Must be called before any early returns (Rules of Hooks)
  const { mediaItems, cleanContent } = useAttachments(article?.content ?? '', article?.attachment_name);

  const MAX_PREVIEW_CHARS = 3000;
  const isLong = cleanContent.length > MAX_PREVIEW_CHARS;

  const entityToHighlight = selectedEntity ?? null;

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const highlightPlugin = useMemo(
    () => createEntityHighlightPlugin(entityToHighlight),
    [entityToHighlight],
  );

  const articleEntityOccurrenceCount = useMemo(() => {
    if (!entityToHighlight || !cleanContent) return 0;
    const escaped = entityToHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let count = 0;
    regex.lastIndex = 0;
    while (regex.exec(cleanContent) !== null) count++;
    return count;
  }, [cleanContent, entityToHighlight]);

  const searchTerm = deferredSearchQuery.trim();
  const searchPlugin = useMemo(
    () => createSearchHighlightPlugin(searchTerm || null),
    [searchTerm],
  );

  const rehypePlugins = useMemo(
    () => [rehypeRaw, highlightPlugin, searchPlugin] as any,
    [highlightPlugin, searchPlugin],
  );

  const {
    count: occurrenceCount,
    activeIndex: activeOccurrenceIndex,
    occurrences,
    scrollToOccurrence,
  } = useEntityOccurrences(cleanContent, entityToHighlight, commentTexts);

  const contentLength = useMemo(() => cleanContent.length, [cleanContent]);
  const {
    count: searchCount,
    activeIndex: activeSearchIndex,
    occurrences: searchOccurrences,
    scrollToMatch,
  } = useArticleSearch(searchTerm, contentLength);

  const isSearchActive = searchTerm.length > 0;
  const isSearchPending = searchQuery.trim() && searchQuery.trim() !== searchTerm;

  const displayContent = useMemo(() => {
    if (isLong && !expanded) {
      return cleanContent.slice(0, MAX_PREVIEW_CHARS) + '\n\n...';
    }
    return cleanContent;
  }, [cleanContent, isLong, expanded]);

  const markdownEl = useMemo(
    () => (
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
        {displayContent}
      </Markdown>
    ),
    [displayContent, rehypePlugins],
  );

  if (loading) return <div className={styles.loading}>加载中…</div>;
  if (error) return <div className={styles.loading}>加载失败：{error}</div>;
  if (!article) return <div className={styles.loading}>文章不存在</div>;

  const catColor = article.category?.color ?? 'var(--c-text-muted)';
  const catName = article.category?.name ?? '未分类';
  const isCreator = userIdNumber
    ? (article.created_by?.match(/\d{18}/)?.[0] ?? '') === userIdNumber
    : false;

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
          {actionsInTopBar && (
            <button className={styles.backBtn} onClick={onBack}>← 返回列表</button>
          )}
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
        <div className={styles.topBarRight}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="在文章中搜索…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            {searchQuery && (
              <button
                className={styles.searchClear}
                onClick={() => setSearchQuery('')}
                title="清除搜索"
              >
                ✕
              </button>
            )}
          </div>
          {isSearchPending && (
            <span className={styles.searchNoResults}>搜索中…</span>
          )}
          {isSearchActive && !isSearchPending && searchCount === 0 && (
            <span className={styles.searchNoResults}>无匹配</span>
          )}
          {isCreator && (
            <div className={styles.actions}>
              <button className={styles.btn} onClick={() => openEditor(article.id)}>✏️ 编辑</button>
              <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>🗑 删除</button>
            </div>
          )}
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
        {article.created_by && (
          <span title={article.created_by}>👤 创建人 {formatUser(article.created_by)}</span>
        )}
        <span>📅 创建于 {formatDate(article.created_at)}</span>
        {article.created_at !== article.updated_at && (
          <span>✏️ 更新于 {formatDate(article.updated_at)}</span>
        )}
        <span>🔖 {article.entities?.entities?.length ?? 0} 个实体</span>
        <span>🔗 {article.entities?.relations?.length ?? 0} 个关系</span>
      </div>

      {article.tags.length > 0 && (
        <div className={styles.tags}>
          {article.tags.map((t) => (
            onTagClick ? (
              <button key={t} className={styles.tag} onClick={() => onTagClick(t)}
                title={`查看所有标记为「${t}」的文章`}>{t}</button>
            ) : (
              <span key={t} className={styles.tag}>{t}</span>
            )
          ))}
        </div>
      )}

      <div className={`${styles.content} markdown-content`} id="article-content">
        {markdownEl}

        {isLong && (
          <div style={{ textAlign: 'center', margin: '12px 0' }}>
            <button
              className={styles.btn}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '收起' : `展开全文（共 ${Math.ceil(cleanContent.length / 1000)}k 字）`}
            </button>
          </div>
        )}

        {isSearchActive && searchCount > 0 && (
          <SearchNavBar
            searchTerm={searchTerm}
            totalCount={searchCount}
            activeIndex={activeSearchIndex}
            occurrences={searchOccurrences}
            onNavigate={scrollToMatch}
            onClose={() => setSearchQuery('')}
          />
        )}
      </div>

      <AttachmentGallery items={mediaItems} articleId={articleId} />

      <CommentSection
        articleId={articleId}
        selectedEntity={entityToHighlight}
        entityOccurrenceOffset={articleEntityOccurrenceCount}
        onCommentTextsChange={setCommentTexts}
      />

      {entityToHighlight && occurrenceCount > 0 && (
        <EntityOccurrenceBar
          entityName={entityToHighlight}
          entityType={article.entities?.entities?.find((e) => e.name === entityToHighlight)?.type}
          totalCount={occurrenceCount}
          activeIndex={activeOccurrenceIndex}
          occurrences={occurrences}
          onNavigate={scrollToOccurrence}
          onClose={() => onEntitySelect?.(null)}
        />
      )}
    </div>
  );
}

// Re-export for backward compatibility
export { ArticleDetailView as ArticleDetailInline };
