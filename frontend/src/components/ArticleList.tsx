import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import { ArticleCard } from './ArticleCard';
import { ArticleDetailInline } from './ArticleDetail';
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

  // Entity highlight (for article content highlighting via rehype plugin)
  const [highlightEntity, setHighlightEntity] = useState<string | null>(null);
  // Tag content navigation（标签词高亮，与实体互斥）
  const [highlightTag, setHighlightTag] = useState<string | null>(null);

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
    setHighlightEntity(null);
  }, []);

  // Handle entity selection — 实体以「名称+类型」为标识，筛选集按 name::type 键存
  const lastEntityNameRef = useRef<string | null>(null);
  const handleEntitySelect = useCallback((entity: string, entityType: string, ctrl: boolean) => {
    const key = `${entity}::${entityType}`;
    lastEntityNameRef.current = entity;
    setSelectedEntities((prev) => {
      const next = new Set(prev);
      if (ctrl) {
        if (next.has(key)) next.delete(key); else next.add(key);
      } else {
        if (next.has(key)) next.delete(key);
        else { next.clear(); next.add(key); }
      }
      return next;
    });
  }, []);

  // 正文高亮按名称（文本无法区分类型）：选中任一类型行即高亮该名称，集合清空才熄灭
  useEffect(() => {
    setHighlightEntity(selectedEntities.size > 0 ? lastEntityNameRef.current : null);
  }, [selectedEntities]);

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
          // 实体节点 id = entity:{name}::{type}，按「名称+类型」匹配
          // 旧数据产生的无类型节点（entity:{name}::）按名称匹配
          if (nodeId?.startsWith('entity:')) {
            const [ename, etype] = nodeId.slice('entity:'.length).split('::');
            if (a.entities?.entities?.some(
              (e) => e.name === ename && (!etype || (e.type ?? '') === etype)
            )) return true;
          }
        }
        return false;
      });
    }

    // Additionally filter by selected entities — 按 (name, type) 精确匹配
    if (selectedEntities.size > 0) {
      result = result.filter((a) =>
        a.entities?.entities?.some((e) =>
          selectedEntities.has(`${e.name}::${e.type ?? '其他'}`)
        )
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

  // Entities (LLM-extracted) — computed from article.entities, keyed by (name, type)
  // 同名但类型不同视为不同实体：分开展示、分别计数
  const llmEntityList = useMemo(() => {
    const counts = new Map<string, number>();
    const creators = new Map<string, string>(); // name -> first created_by
    for (const a of entityPool) {
      if (!a.entities?.entities) continue;
      for (const e of a.entities.entities) {
        const key = `${e.name}::${e.type ?? '其他'}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!creators.has(e.name) && (e as any).created_by) {
          creators.set(e.name, (e as any).created_by);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([key, count]) => {
        const [name, type] = key.split('::');
        return { name, count, type, created_by: creators.get(name) };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.type ?? '').localeCompare(b.type ?? ''));
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
    // 处理中状态包含三态："processing" / "processing:{safe_name}"（读取中）/
    // "recognizing:{safe_name}"（解析中）
    const isBusy = (p?: string | null) => !!p && (p.startsWith('processing') || p.startsWith('recognizing'));
    const processing = articles.filter((a) => isBusy(a.processing));
    if (processing.length === 0) return;
    const timer = setInterval(async () => {
      const updated = await Promise.allSettled(
        processing.map((a) => api.getArticle(a.id).catch(() => null)),
      );
      const done = updated.some(
        (r) => r.status === 'fulfilled' && r.value && !isBusy(r.value.processing),
      );
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
    setHighlightEntity(null);
  };

  const handleBack = () => {
    if (searchParams.has('view')) {
      const params = new URLSearchParams(searchParams);
      params.delete('view');
      setSearchParams(params, { replace: true });
    }
    setViewedArticleId(null);
    setSelectedArticleIds(new Set());
    setHighlightEntity(null);
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
          (() => {
            const currentIndex = displayedArticles.findIndex((a) => a.id === viewedArticleId);
            const prevId = currentIndex > 0 ? displayedArticles[currentIndex - 1]?.id : undefined;
            const nextId = currentIndex >= 0 && currentIndex < displayedArticles.length - 1
              ? displayedArticles[currentIndex + 1]?.id : undefined;
            const handleNavigate = (id: string) => {
              setViewedArticleId(id);
              setSelectedArticleIds(new Set([id]));
              setSelectedEntities(new Set());
              setHighlightEntity(null);
              setHighlightTag(null);
            };
            return (
              <ArticleDetailInline
                key={viewedArticleId}
                articleId={viewedArticleId}
                onBack={handleBack}
                prevArticleId={prevId}
                nextArticleId={nextId}
                onNavigate={handleNavigate}
                selectedEntity={highlightEntity}
                onEntitySelect={(name) => {
                  setHighlightEntity(name);
                  if (name) setHighlightTag(null);  // 实体与标签互斥
                }}
                selectedTag={highlightTag}
                onTagClick={(tag) => {
                  setHighlightTag((prev) => (prev === tag ? null : tag));
                  setHighlightEntity(null);
                }}
                actionsInTopBar
              />
            );
          })()
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
