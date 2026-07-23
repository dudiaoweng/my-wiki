import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import { ArticleCard } from './ArticleCard';
import { ArticleDetailInline } from './ArticleDetailInline';
import { EntityPanel, type ViewMode } from './EntityPanel';
import styles from './ArticleList.module.css';

export function ArticleList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = searchParams.get('category') ?? undefined;
  const search = searchParams.get('search') ?? undefined;
  const tag = searchParams.get('tag') ?? undefined;
  const viewId = searchParams.get('view') ?? undefined;

  const params = useMemo(() => ({ category_id: categoryId, search, tag }), [categoryId, search, tag]);
  const { articles, loading, error, refetch } = useArticles(params);
  const { categories } = useCategories();
  const { openEditor, articleVersion, searchInputRef } = useApp();

  const searchVal = searchParams.get('search') ?? '';

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set('search', value);
    } else {
      params.delete('search');
    }
    params.delete('tag');
    setSearchParams(params, { replace: true });
  };

  // Selection state
  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(new Set());
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());

  // Entity panel mode — kept here to survive loading remounts
  const [entityPanelMode, setEntityPanelMode] = useState<ViewMode>('list');

  // Selected graph node IDs (for visual highlight + article list filtering)
  const [selectedGraphNodeIds, setSelectedGraphNodeIds] = useState<Set<string>>(new Set());

  // Inline article view
  const [viewedArticleId, setViewedArticleId] = useState<string | null>(null);

  const categoryName = categoryId
    ? categories.find((c) => c.id === categoryId)?.name ?? '分类'
    : null;

  const title = tag
    ? `标签: ${tag}`
    : search
      ? `搜索: "${search}"`
      : categoryName ?? '所有文章';

  // Handle article selection
  const handleArticleSelect = useCallback((id: string, ctrl: boolean) => {
    setSelectedArticleIds((prev) => {
      const next = new Set(prev);
      if (ctrl) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else {
        if (next.has(id)) next.delete(id);
        else { next.clear(); next.add(id); }
      }
      return next;
    });
  }, []);

  // Handle article open — show inline detail
  const handleArticleOpen = useCallback((id: string) => {
    setViewedArticleId(id);
    setSelectedArticleIds(new Set([id]));
    setSelectedEntities(new Set());
  }, []);

  // Handle entity selection
  const handleEntitySelect = useCallback((entity: string, ctrl: boolean) => {
    setSelectedEntities((prev) => {
      const next = new Set(prev);
      if (ctrl) {
        if (next.has(entity)) next.delete(entity); else next.add(entity);
      } else {
        if (next.has(entity)) next.delete(entity);
        else { next.clear(); next.add(entity); }
      }
      return next;
    });
  }, []);

  // Handle knowledge graph node click → toggle selection, filter article list locally
  const handleGraphNodeClick = useCallback(
    (_nodeId: string, _nodeType: string, _label: string, multi?: boolean) => {
      setSelectedGraphNodeIds((prev) => {
        const next = new Set(prev);
        if (multi) {
          if (next.has(_nodeId)) next.delete(_nodeId);
          else next.add(_nodeId);
        } else {
          if (next.has(_nodeId) && next.size === 1) next.delete(_nodeId);
          else { next.clear(); next.add(_nodeId); }
        }
        return next;
      });
    },
    [],
  );

  // Combined filter: graph node selection + entity selection (local, no reload)
  const displayedArticles = useMemo(() => {
    let result = articles;

    // Filter by selected graph nodes (local, no reload)
    if (selectedGraphNodeIds.size > 0) {
      result = result.filter((a) => {
        for (const nodeId of selectedGraphNodeIds) {
          if (nodeId === `article:${a.id}`) return true;
          if (nodeId === `category:${a.category_id}`) return true;
          // Match LLM-extracted entity by name
          if (a.entities?.entities?.some((e) => nodeId === `entity:${e.name}`)) return true;
        }
        return false;
      });
    }

    // Additionally filter by selected entities (matches LLM-extracted entities)
    if (selectedEntities.size > 0) {
      result = result.filter((a) =>
        a.entities?.entities?.some((e) => selectedEntities.has(e.name))
      );
    }

    return result;
  }, [articles, selectedGraphNodeIds, selectedEntities]);

  // Compute entity list
  const entityPool = useMemo(() => {
    // If viewing an article, show only its entities
    if (viewedArticleId) {
      const a = articles.find((x) => x.id === viewedArticleId);
      return a ? [a] : [];
    }
    // If articles selected, show their entities
    if (selectedArticleIds.size > 0) {
      return articles.filter((a) => selectedArticleIds.has(a.id));
    }
    // Otherwise all articles
    return articles;
  }, [articles, selectedArticleIds, viewedArticleId]);

  // Entities (LLM-extracted) — computed from article.entities, with most common type
  const llmEntityList = useMemo(() => {
    const counts = new Map<string, number>();
    const types = new Map<string, Map<string, number>>(); // name -> type -> count
    for (const a of entityPool) {
      if (!a.entities?.entities) continue;
      for (const e of a.entities.entities) {
        counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
        if (!types.has(e.name)) types.set(e.name, new Map());
        const tmap = types.get(e.name)!;
        tmap.set(e.type, (tmap.get(e.type) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => {
        const tmap = types.get(name);
        let bestType = '';
        let bestCount = 0;
        if (tmap) {
          for (const [t, c] of tmap) {
            if (c > bestCount) { bestType = t; bestCount = c; }
          }
        }
        return { name, count, type: bestType };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [entityPool]);

  // Clear selections when filters change
  useEffect(() => {
    setSelectedArticleIds(new Set());
    setSelectedEntities(new Set());
    setSelectedGraphNodeIds(new Set());
    setViewedArticleId(null);
  }, [categoryId, search, tag]);

  // Sync viewedArticleId from URL view param (e.g. after file upload)
  useEffect(() => {
    if (viewId) {
      setViewedArticleId(viewId);
      setSelectedArticleIds(new Set([viewId]));
    } else {
      setViewedArticleId(null);
    }
  }, [viewId]);

  // Poll only processing articles — update their cards individually
  useEffect(() => {
    const processing = articles.filter((a) => a.processing === 'processing');
    if (processing.length === 0) return;
    const timer = setInterval(async () => {
      const updated = await Promise.allSettled(
        processing.map((a) => api.getArticle(a.id).catch(() => null)),
      );
      const done = updated.some((r) => r.status === 'fulfilled' && r.value && r.value.processing !== 'processing');
      if (done) refetch(); // only full refetch when something changed
    }, 5000);
    return () => clearInterval(timer);
  }, [articles, refetch]);

  // Refetch when article is saved (editor close after save).
  // Skip the initial mount — useArticles already fetches on mount.
  const initialRender = useRef(true);
  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    if (articleVersion > 0) {
      refetch();
    }
  }, [articleVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    refetch();
    setSelectedArticleIds(new Set());
    setSelectedEntities(new Set());
    setViewedArticleId(null);
  };

  const handleBack = () => {
    if (searchParams.has('view')) {
      const params = new URLSearchParams(searchParams);
      params.delete('view');
      setSearchParams(params, { replace: true });
    }
    setViewedArticleId(null);
    setSelectedArticleIds(new Set());
  };

  // Memoize to avoid new array reference on every render (triggers D3 restart)
  const selectedArticleIdsArray = useMemo(
    () => (viewedArticleId ? [viewedArticleId] : Array.from(selectedArticleIds)),
    [viewedArticleId, selectedArticleIds],
  );

  return (
    <div className={styles.layout}>
      <div className={styles.mainCol}>
        {viewedArticleId ? (
          <ArticleDetailInline key={`${viewedArticleId}-${articleVersion}`} articleId={viewedArticleId} onBack={handleBack} />
        ) : (
          <>
            {/* Header + search — always visible, never unmounted */}
            <div className={styles.header}>
              <h3>{title}</h3>
              <span className={styles.resultCount}>
                {selectedArticleIds.size > 0
                  ? `已选 ${selectedArticleIds.size} / ${displayedArticles.length} 篇`
                  : `共 ${displayedArticles.length} 篇`}
              </span>
              <div className={styles.searchWrap}>
                <span className={styles.searchIcon}>🔍</span>
                <input
                  ref={searchInputRef}
                  type="text"
                  className={styles.searchInput}
                  placeholder={tag ? `标签: ${tag}` : '搜索文章...'}
                  value={searchVal}
                  onChange={handleSearchChange}
                  autoComplete="off"
                  aria-label="搜索知识库"
                />
              </div>
            </div>

            {/* Content below — conditional */}
            {error ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>⚠️</div>
                <p>加载失败：{error}</p>
                <button className={styles.newBtn} onClick={refetch}>重试</button>
              </div>
            ) : loading ? (
              <div className={styles.empty}><p>加载中…</p></div>
            ) : articles.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>📭</div>
                <p>
                  {search || tag
                    ? '没有匹配的文章，试试其他关键词'
                    : '这个分类下还没有文章'}
                </p>
                {!search && !tag && (
                  <button className={styles.newBtn} onClick={() => openEditor(null)}>
                    + 写一篇文章
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.list}>
                {displayedArticles.map((a) => (
                  <ArticleCard
                    key={a.id}
                    article={a}
                    selected={selectedArticleIds.has(a.id)}
                    onSelect={handleArticleSelect}
                    onOpen={handleArticleOpen}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <EntityPanel
        entities={llmEntityList}
        selectedArticleIds={selectedArticleIdsArray}
        articles={articles}
        mode={entityPanelMode}
        onModeChange={setEntityPanelMode}
        onRefresh={refetch}
        onGraphNodeClick={handleGraphNodeClick}
        selectedGraphNodeIds={selectedGraphNodeIds}
        onEntitySelect={handleEntitySelect}
      />
    </div>
  );
}
