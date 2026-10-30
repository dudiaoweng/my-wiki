import { Fragment, useState, useEffect, useMemo, useRef, useDeferredValue, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
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
import { ChildTree, countDescendants } from './ChildTree';
import { useCategories } from '../hooks/useCategories';
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

// ─── 子文章树（与文章卡片共用组件）──────────────────

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
  /** Selected tag for content navigation highlight（与实体同机制，选中即高亮导航）. */
  selectedTag?: string | null;
  /** Called when user clicks a tag（选中/取消，触发内容导航）. */
  onTagClick?: (tag: string) => void;
  /** Show edit/delete buttons in top bar instead of at page bottom. */
  actionsInTopBar?: boolean;
  /** 智能返回：优先父文章，其次所在目录；不传则退回 onBack */
  onReturn?: (parentId: string | null, categoryId: string | null) => void;
}

export function ArticleDetailView({
  articleId, onBack, prevArticleId, nextArticleId, onNavigate,
  selectedEntity, onEntitySelect, selectedTag, onTagClick, actionsInTopBar, onReturn,
}: ArticleDetailViewProps) {
  const { openEditor, requestConfirm, notifyArticleSaved, articleVersion, userIdNumber } = useApp();
  const { showToast } = useToast();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentTexts, setCommentTexts] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getArticle(articleId)
      .then((a) => {
        if (!cancelled) setArticle(a);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : '加载失败';
        setError(msg);
        showToast(msg, 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [articleId, showToast]);

  // Poll while background processing is running:
  // "processing" / "processing:file" = 读取中（文本提取）；"recognizing:file" = 解析中（LLM 识别）
  const procState = article?.processing ?? '';
  const isProcessing = procState.startsWith('processing') || procState.startsWith('recognizing');
  useEffect(() => {
    if (!article || !isProcessing) return;
    const timer = setInterval(async () => {
      try {
        const updated = await api.getArticle(articleId);
        setArticle(updated);
        if (!updated.processing) {
          clearInterval(timer);
          notifyArticleSaved();
        }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [article, articleId, notifyArticleSaved, isProcessing]);

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

  // 内容导航高亮词：标签优先（选中标签清空实体，反之亦然，由父级保证）
  const highlightTerm = selectedTag ?? selectedEntity ?? null;
  const highlightClass = selectedTag ? 'tag-highlight' : 'entity-highlight';
  const highlightActiveClass = selectedTag ? 'tag-highlight-active' : 'entity-highlight-active';

  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const highlightPlugin = useMemo(
    () => createEntityHighlightPlugin(highlightTerm, 0, highlightClass),
    [highlightTerm, highlightClass],
  );

  const articleEntityOccurrenceCount = useMemo(() => {
    if (!highlightTerm || !cleanContent) return 0;
    const escaped = highlightTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let count = 0;
    regex.lastIndex = 0;
    while (regex.exec(cleanContent) !== null) count++;
    return count;
  }, [cleanContent, highlightTerm]);

  const searchTerm = deferredSearchQuery.trim();
  const searchPlugin = useMemo(
    () => createSearchHighlightPlugin(searchTerm || null),
    [searchTerm],
  );

  const rehypePlugins = useMemo(
    () => [rehypeRaw, rehypeSanitize, highlightPlugin, searchPlugin] as any,
    [highlightPlugin, searchPlugin],
  );

  const {
    count: occurrenceCount,
    activeIndex: activeOccurrenceIndex,
    occurrences,
    scrollToOccurrence,
  } = useEntityOccurrences(cleanContent, highlightTerm, commentTexts, highlightActiveClass);

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

  // ── 评论/子文章 Tab（钩子必须在早退之前，避免钩子数量变化崩溃）──
  // 选择记录绑定文章 ID：换文章（上一篇/下一篇）时选择自动失效，新文章默认打开评论页
  const [tabSelection, setTabSelection] = useState<{ articleId: string | null; tab: 'children' | 'comments' } | null>(null);
  const effectiveTab = tabSelection?.articleId === articleId ? tabSelection.tab : 'comments';

  // 文章所属目录的祖先链（子目录嵌套场景，含自身，根→叶子）
  const { categories } = useCategories();
  const categoryChain = useMemo(() => {
    if (!article?.category) return [];
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chain: { id: string; name: string; color: string }[] = [];
    const seen = new Set<string>();
    let cur: { id: string; name: string; color: string; parent_id?: string | null } | null = article.category;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift({ id: cur.id, name: cur.name, color: cur.color });
      cur = cur.parent_id ? (byId.get(cur.parent_id) ?? null) : null;
    }
    return chain;
  }, [article?.category, categories]);
  const selectTab = useCallback((tab: 'children' | 'comments') => {
    setTabSelection({ articleId, tab });
  }, [articleId]);
  const [commentCount, setCommentCount] = useState(0);

  // 评论文本上报：评论页激活时参与实体出现位置统计；子文章页时清空
  // （隐藏的评论文本不参与计数，避免出现位置指向不可见的 DOM）
  const handleCommentTextsChange = useCallback((texts: string[]) => {
    setCommentCount(texts.length);
    setCommentTexts(effectiveTab === 'comments' ? texts : []);
  }, [effectiveTab]);

  if (loading) return <div className={styles.loading}>加载中…</div>;
  if (error) return <div className={styles.loading}>加载失败：{error}</div>;
  if (!article) return <div className={styles.loading}>文章不存在</div>;

  const totalDescendants = countDescendants(article.children_tree);
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
      } catch (e) {
        // 后端 409（有子文章）等错误信息原样展示
        const msg = e instanceof Error ? e.message : '删除失败';
        showToast(msg, 'error');
      }
    });
  };

  const handleRecognize = async () => {
    try {
      const updated = await api.recognizeArticle(articleId);
      setArticle(updated);  // processing 置为 "recognizing"，触发既有轮询刷新
      showToast('已开始重新解析文章内容', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '重新解析失败';
      showToast(msg, 'error');
    }
  };

  return (
    <div className={styles.detail}>
      {/* 面包屑路径：全部 / 目录（含上级目录链）/ 文章 / 子文章 / … / 当前文章 */}
      <nav className={styles.breadcrumb} aria-label="面包屑导航">
        <Link to="/articles">全部</Link>
        <span className={styles.breadcrumbSep}>/</span>
        {categoryChain.map((c) => (
          <Fragment key={c.id}>
            <Link
              to={`/articles?category=${c.id}`}
              className={styles.crumbCategory}
              style={{ '--crumb-cat': c.color } as CSSProperties}
              title={`查看「${c.name}」目录下的所有文章`}
            >
              {c.name}
            </Link>
            <span className={styles.breadcrumbSep}>/</span>
          </Fragment>
        ))}
        {article.ancestors.map((anc) => (
          <Fragment key={anc.id}>
            <Link to={`/articles?view=${anc.id}`} title={anc.title}>{anc.title}</Link>
            <span className={styles.breadcrumbSep}>/</span>
          </Fragment>
        ))}
        <span className={styles.crumbCurrent} title={article.title}>{article.title}</span>
      </nav>

      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>
          {actionsInTopBar && (
            <button
              className={styles.backBtn}
              onClick={() => {
                // 智能返回：有父文章 → 父文章；否则 → 所在目录；无 onReturn 时退回列表
                if (onReturn) onReturn(article.parent_id, article.category_id);
                else onBack();
              }}
            >
              ← 返回
            </button>
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
          <button
            className={styles.btn}
            onClick={() => openEditor(null, { parentId: article.id, categoryId: article.category_id })}
            title="在该文章下新建子文章"
          >
            ＋ 新建子文章
          </button>
          {isCreator && (
            <div className={styles.actions}>
              <button
                className={styles.btn}
                onClick={handleRecognize}
                disabled={isProcessing}
                title="对文章文本内容重新解析：提取标签/实体、重建检索索引"
              >
                🧠 重新解析
              </button>
              <button className={styles.btn} onClick={() => openEditor(article.id)}>✏️ 编辑</button>
              <button className={styles.btn} onClick={handleDelete}>🗑 删除</button>
            </div>
          )}
        </div>
      </div>

      <h1 className={styles.title}>
        {article.title}
        {isProcessing && (
          <span className={styles.processingBadge}>
            ⏳ {procState.startsWith('recognizing') ? '解析中…' : '读取中…'}
          </span>
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
              <button key={t}
                className={`${styles.tag}${t === selectedTag ? ` ${styles.tagActive}` : ''}`}
                onClick={() => onTagClick(t)}
                title={t === selectedTag ? '取消内容导航' : `内容导航：定位文中所有「${t}」（再点取消）`}>{t}</button>
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

      <AttachmentGallery
        items={mediaItems}
        articleId={articleId}
        processing={article.processing}
        onReprocess={isCreator ? async (item) => {
          const safeName = item.src.split('/').pop()?.split('?')[0];
          if (!safeName) return;
          try {
            await api.reprocessAttachment(articleId, safeName);
            showToast(`已开始重新解析「${item.name}」`, 'success');
            const updated = await api.getArticle(articleId);
            setArticle(updated);
          } catch (e: unknown) {
            const msg = (e instanceof Error && e.message) ? e.message : '重新解析失败';
            showToast(msg, 'error');
          }
        } : undefined}
      />

      <div className={styles.tabsBar} role="tablist" aria-label="文章附属内容">
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'comments'}
          className={`${styles.tabBtn}${effectiveTab === 'comments' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => selectTab('comments')}
        >
          💬 评论{commentCount > 0 && <span className={styles.tabBadge}>{commentCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === 'children'}
          className={`${styles.tabBtn}${effectiveTab === 'children' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => selectTab('children')}
        >
          📁 子文章{totalDescendants > 0 && <span className={styles.tabBadge}>{totalDescendants}</span>}
        </button>
      </div>

      <div role="tabpanel" className={effectiveTab === 'comments' ? undefined : styles.tabHidden}>
        <CommentSection
          articleId={articleId}
          selectedEntity={highlightTerm}
          highlightClassName={highlightClass}
          entityOccurrenceOffset={articleEntityOccurrenceCount}
          onCommentTextsChange={handleCommentTextsChange}
        />
      </div>

      <div role="tabpanel" className={effectiveTab === 'children' ? undefined : styles.tabHidden}>
        <div className={styles.childTreeSection}>
          <ChildTree
            nodes={article.children_tree}
            getHref={(id) => `/articles?view=${id}`}
          />
        </div>
      </div>

      {highlightTerm && occurrenceCount > 0 && (
        <EntityOccurrenceBar
          entityName={highlightTerm}
          entityType={selectedTag
            ? undefined
            : article.entities?.entities?.find((e) => e.name === highlightTerm)?.type}
          totalCount={occurrenceCount}
          activeIndex={activeOccurrenceIndex}
          occurrences={occurrences}
          onNavigate={scrollToOccurrence}
          onClose={() => {
            if (selectedTag) onTagClick?.(selectedTag);
            else onEntitySelect?.(null);
          }}
        />
      )}
    </div>
  );
}

// Re-export for backward compatibility
export { ArticleDetailView as ArticleDetailInline };
