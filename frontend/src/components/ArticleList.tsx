import { Fragment, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import { ArticleCard } from './ArticleCard';
import { ArticleDetailInline } from './ArticleDetail';
import type { Article } from '../types/article';
import { EntityPanel, type ViewMode } from './EntityPanel';
import { orderByHierarchy } from '../utils/hierarchy';
import styles from './ArticleList.module.css';

export function ArticleList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = searchParams.get('category') ?? undefined;
  const search = searchParams.get('search') ?? undefined;
  const tag = searchParams.get('tag') ?? undefined;
  const viewId = searchParams.get('view') ?? undefined;

  const params = useMemo(() => ({
    category_id: categoryId,
    search,
    tag,
    // 层级浏览：只显示直接挂载在当前位置（顶级）的文章，深层文章经父文章的
    // 子文章树导航进入；搜索/标签为全局查询，不受层级限制
    root_only: !search && !tag,
  }), [categoryId, search, tag]);
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
  // 被浏览文章不在当前列表中时（如从侧边栏打开目录树深层文章），单独拉取供实体面板使用
  const [viewedArticleDetail, setViewedArticleDetail] = useState<Article | null>(null);

  // Entity highlight (for article content highlighting via rehype plugin)
  const [highlightEntity, setHighlightEntity] = useState<string | null>(null);
  // Tag content navigation（标签词高亮，与实体互斥）
  const [highlightTag, setHighlightTag] = useState<string | null>(null);

  const categoryName = categoryId
    ? categories.find((c) => c.id === categoryId)?.name ?? '目录'
    : null;

  const categoryColor = categoryId
    ? categories.find((c) => c.id === categoryId)?.color
    : undefined;

  const title = tag
    ? `标签: ${tag}`
    : search
      ? `搜索: "${search}"`
      : categoryName ?? '所有文章';

  // 面包屑：全部 / 目录（含上级目录链）/ 标签 / 搜索
  const hasFilter = Boolean(categoryId || tag || search);

  // 当前目录的祖先链（子目录嵌套场景，根→叶子，含自身）
  const categoryChain = useMemo(() => {
    if (!categoryId) return [];
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chain: { id: string; name: string; color: string }[] = [];
    const seen = new Set<string>();
    let cur = byId.get(categoryId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift({ id: cur.id, name: cur.name, color: cur.color });
      cur = cur.parent_id ? (byId.get(cur.parent_id) ?? undefined) : undefined;
    }
    return chain;
  }, [categoryId, categories]);

  // Handle article selection
  // 同级子目录（当前目录的直接子目录；「全部」视图 = 顶级目录）
  const siblingDirs = useMemo(() => {
    const parent = categoryId ?? null;
    return categories
      .filter((c) => (c.parent_id ?? null) === parent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, categoryId]);

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

  // 正文高亮按名称（文本无法区目录型）：选中任一类型行即高亮该名称，集合清空才熄灭
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

  // 树状排布：子文章紧随父文章之后（同层按更新时间降序），根按更新时间降序
  const orderedArticles = useMemo(() => orderByHierarchy(displayedArticles), [displayedArticles]);

  // Compute entity list
  const entityPool = useMemo(() => {
    // If viewing an article, show only its entities（不在列表时用单独拉取的详情兜底）
    if (viewedArticleId) {
      const a = articles.find((x) => x.id === viewedArticleId) ?? viewedArticleDetail ?? undefined;
      return a ? [a] : [];
    }
    // If articles selected, show their entities
    if (selectedArticleIds.size > 0) {
      return articles.filter((a) => selectedArticleIds.has(a.id));
    }
    // Otherwise all articles
    return articles;
  }, [articles, selectedArticleIds, viewedArticleId, viewedArticleDetail]);

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

  // 被浏览文章不在当前列表时，单独拉取详情（实体面板数据来源兜底）
  useEffect(() => {
    if (!viewedArticleId) {
      setViewedArticleDetail(null);
      return;
    }
    if (articles.some((x) => x.id === viewedArticleId)) {
      setViewedArticleDetail(null);
      return;
    }
    let cancelled = false;
    api.getArticle(viewedArticleId)
      .then((a) => {
        if (!cancelled) setViewedArticleDetail(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewedArticleId, articles]);

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
            const orderedIds = orderedArticles.map((o) => o.article.id);
            const currentIndex = orderedIds.indexOf(viewedArticleId);
            const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] : undefined;
            const nextId = currentIndex >= 0 && currentIndex < orderedIds.length - 1
              ? orderedIds[currentIndex + 1] : undefined;
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
                onReturn={(pid, cid) => {
                  if (pid) {
                    // 返回父文章：切换内联视图到父文章
                    setViewedArticleId(pid);
                    setSelectedArticleIds(new Set([pid]));
                    setSelectedEntities(new Set());
                    setHighlightEntity(null);
                    setHighlightTag(null);
                  } else if (cid) {
                    // 无父文章：返回所在目录的文章列表
                    const params = new URLSearchParams(searchParams);
                    params.delete('view');
                    params.set('category', cid);
                    setSearchParams(params);
                    setViewedArticleId(null);
                    setSelectedArticleIds(new Set());
                    setHighlightEntity(null);
                    setHighlightTag(null);
                  } else {
                    handleBack();
                  }
                }}
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
              {/* 面包屑路径与详情页同模式：全部 / 目录（含上级目录链）/ 标签 / 搜索 */}
              <nav className={styles.breadcrumb} aria-label="面包屑导航">
                {hasFilter ? (
                  <>
                    <Link to="/articles">全部</Link>
                    <span className={styles.breadcrumbSep}>/</span>
                    {categoryId && categoryChain.length > 0 ? (
                      categoryChain.map((c, i) => (
                        <Fragment key={c.id}>
                          {i < categoryChain.length - 1 ? (
                            <Link to={`/articles?category=${c.id}`} style={{ color: c.color }}>
                              {c.name}
                            </Link>
                          ) : (
                            <span className={styles.breadcrumbCurrent} style={{ color: c.color }}>
                              {c.name}
                            </span>
                          )}
                          <span className={styles.breadcrumbSep}>/</span>
                        </Fragment>
                      ))
                    ) : (
                      <span
                        className={styles.breadcrumbCurrent}
                        style={categoryColor ? { color: categoryColor } : undefined}
                      >
                        {title}
                      </span>
                    )}
                  </>
                ) : (
                  <span className={styles.breadcrumbCurrent}>全部</span>
                )}
              </nav>
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

            {/* 同级子目录入口 */}
            {siblingDirs.length > 0 && (
              <div className={styles.dirRow}>
                {siblingDirs.map((d) => (
                  <Link
                    key={d.id}
                    to={`/articles?category=${d.id}`}
                    className={styles.dirChip}
                    style={{ '--dir-accent': d.color } as CSSProperties}
                    title={`进入目录「${d.name}」`}
                  >
                    <span className={styles.dirChipIcon}>📁</span>
                    <span className={styles.dirChipName}>{d.name}</span>
                  </Link>
                ))}
              </div>
            )}

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
                    : '这个目录下还没有文章'}
                </p>
                {!search && !tag && (
                  <button className={styles.newBtn} onClick={() => openEditor(null)}>
                    + 写一篇文章
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.list}>
                {orderedArticles.map(({ article: a, depth }) => (
                  <ArticleCard
                    key={a.id}
                    article={a}
                    depth={depth}
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
