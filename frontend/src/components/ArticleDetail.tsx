import { useState, useEffect, useMemo, useDeferredValue } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { api } from '../api/client';
import { useArticles } from '../hooks/useArticles';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { AttachmentGallery, useAttachments } from './AttachmentGallery';
import { createEntityHighlightPlugin } from '../utils/rehypeEntityHighlight';
import { createSearchHighlightPlugin } from '../utils/rehypeSearchHighlight';
import { useEntityOccurrences } from '../hooks/useEntityOccurrences';
import { useArticleSearch } from '../hooks/useArticleSearch';
import { EntityOccurrenceBar } from './EntityOccurrenceBar';
import { SearchNavBar } from './SearchNavBar';
import type { Article } from '../types/article';
import styles from './ArticleDetail.module.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

/** Extract the name portion from a CN like "谢林 320100198601010018". */
function formatUser(cn: string | null): string {
  if (!cn) return '';
  const match = cn.match(/^(.+?)\s+\d{18}$/);
  return match ? match[1] : cn;
}

export function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { openEditor, requestConfirm, notifyArticleSaved } = useApp();
  const { showToast } = useToast();

  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  // In-article search state
  const [searchQuery, setSearchQuery] = useState('');
  // Defer the expensive highlight re-render so typing stays responsive
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // Fetch full article list for prev/next navigation
  const { articles: allArticles } = useArticles();
  const currentIndex = allArticles.findIndex((a) => a.id === id);
  const prevId = currentIndex > 0 ? allArticles[currentIndex - 1]?.id : undefined;
  const nextId = currentIndex >= 0 && currentIndex < allArticles.length - 1
    ? allArticles[currentIndex + 1]?.id : undefined;

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api
      .getArticle(id)
      .then(setArticle)
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load article');
        showToast('文章不存在', 'error');
      })
      .finally(() => setLoading(false));
  }, [id, showToast]);

  // Poll while background recognition is running
  useEffect(() => {
    if (!id || !article || article.processing !== 'processing') return;
    const timer = setInterval(async () => {
      try {
        const updated = await api.getArticle(id);
        setArticle(updated);
        if (updated.processing !== 'processing') {
          clearInterval(timer);
          notifyArticleSaved();
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [article, id, notifyArticleSaved]);

  // Must be called before any early returns (Rules of Hooks)
  const { mediaItems, cleanContent } = useAttachments(article?.content ?? '', article?.attachment_name);

  // Entity highlighting
  const highlightPlugin = useMemo(
    () => createEntityHighlightPlugin(selectedEntity),
    [selectedEntity],
  );

  // Search highlighting — uses deferred value to keep UI responsive while typing
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
  } = useEntityOccurrences(cleanContent, selectedEntity);

  // In-article search — uses deferred value for DOM-based hook
  const contentLength = useMemo(() => cleanContent.length, [cleanContent]);
  const {
    count: searchCount,
    activeIndex: activeSearchIndex,
    occurrences: searchOccurrences,
    scrollToMatch,
  } = useArticleSearch(searchTerm, contentLength);

  const isSearchActive = searchTerm.length > 0;
  const isSearchPending = searchQuery.trim() && searchQuery.trim() !== searchTerm;

  // Memoize Markdown element BEFORE early returns (Rules of Hooks)
  const markdownEl = useMemo(
    () => (
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
        {cleanContent}
      </Markdown>
    ),
    [cleanContent, rehypePlugins],
  );

  if (loading) {
    return <div className={styles.loading}>加载中…</div>;
  }

  if (error || !article) {
    return (
      <div className={styles.loading}>
        <p>{error ?? '文章不存在'}</p>
        <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 16 }} onClick={() => navigate('/articles')}>
          返回列表
        </button>
      </div>
    );
  }

  const catColor = article.category?.color ?? 'var(--c-text-muted)';
  const catName = article.category?.name ?? '未分类';
  const entityCount = article.entities?.entities?.length ?? 0;
  const relationCount = article.entities?.relations?.length ?? 0;

  const handleDelete = () => {
    if (!id) return;
    requestConfirm('确认删除', `确定要删除「${article.title}」吗？此操作不可撤销。`, async () => {
      try {
        await api.deleteArticle(id);
        showToast('文章已删除', 'success');
        notifyArticleSaved();
        navigate('/articles');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Delete failed';
        showToast(msg, 'error');
      }
    });
  };

  const handleTagClick = (tag: string) => {
    navigate(`/articles?tag=${encodeURIComponent(tag)}`);
  };

  return (
    <div className={styles.detail}>
      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/articles')}>
            ← 返回列表
          </button>
          <div className={styles.navGroup}>
            <button
              className={styles.navBtn}
              disabled={!prevId}
              onClick={() => prevId && navigate(`/articles/${prevId}`)}
            >
              ← 上一篇
            </button>
            <button
              className={styles.navBtn}
              disabled={!nextId}
              onClick={() => nextId && navigate(`/articles/${nextId}`)}
            >
              下一篇 →
            </button>
          </div>
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
        </div>
      </div>

      <div className={styles.header}>
        <div className={styles.categoryLabel} style={{ color: catColor }}>
          {catName}
        </div>
        <h1 className={styles.title}>
          {article.title}
          {article.processing === 'processing' && (
            <span className={styles.processingBadge}>⏳ 解析中…</span>
          )}
        </h1>
        <div className={styles.meta}>
          <span>📅 创建于 {formatDate(article.created_at)}</span>
          {article.created_by && (
            <span title={article.created_by}>👤 创建人 {formatUser(article.created_by)}</span>
          )}
          {article.created_at !== article.updated_at && (
            <>
              <span>✏️ 更新于 {formatDate(article.updated_at)}</span>
              {article.updated_by && (
                <span title={article.updated_by}>👤 更新人 {formatUser(article.updated_by)}</span>
              )}
            </>
          )}
          <span>🔖 {entityCount} 个实体</span>
          <span>🔗 {relationCount} 个关系</span>
        </div>
        {article.tags.length > 0 && (
          <div className={styles.tags}>
            {article.tags.map((t) => (
              <button
                key={t}
                className={styles.tag}
                onClick={() => handleTagClick(t)}
                title={`查看所有标记为「${t}」的文章`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <AttachmentGallery items={mediaItems} articleId={id} />

      <div className={`${styles.content} markdown-content`} id="article-content">
        {markdownEl}

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

        {selectedEntity && occurrenceCount > 0 && (
          <EntityOccurrenceBar
            entityName={selectedEntity}
            entityType={article.entities?.entities?.find((e) => e.name === selectedEntity)?.type}
            totalCount={occurrenceCount}
            activeIndex={activeOccurrenceIndex}
            occurrences={occurrences}
            onNavigate={scrollToOccurrence}
            onClose={() => setSelectedEntity(null)}
          />
        )}
      </div>

      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => openEditor(article.id)}
        >
          ✏️ 编辑
        </button>
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>
          🗑 删除
        </button>
      </div>
    </div>
  );
}
