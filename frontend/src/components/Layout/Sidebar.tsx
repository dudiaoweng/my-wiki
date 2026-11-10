import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppProvider';
import { HighlightText } from '../HighlightText';
import { useCategories } from '../../hooks/useCategories';
import { useArticles } from '../../hooks/useArticles';
import { useToast } from '../../hooks/useToast';
import { api } from '../../api/client';
import type { Article } from '../../types/article';
import type { Category } from '../../types/category';
import styles from './Sidebar.module.css';

const CATEGORY_COLORS = [
  '#1E5C8A', '#7D5E3C', '#3D7B4F', '#A0524B',
  '#5B5A8C', '#C07B3A', '#4A7A8C', '#8C5260',
];

export function Sidebar() {
  const {
    sidebarOpen, closeSidebar, openEditor, openUploader, articleVersion, requestConfirm,
    userIdNumber, notifyCategoriesChanged, notifyArticleSaved,
    advancedSearch, advCategoryId, setAdvCategoryId,
    dragRef, dropTarget, setDropTarget, startDrag, dragOverTarget, clearDropTarget,
  } = useApp();
  const { categories, createCategory, updateCategory, deleteCategory } = useCategories();
  const { articles, refetch } = useArticles();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const activeCategoryId = searchParams.get('category');
  // 当前正在浏览的文章：独立详情页路由（/articles/:id）或列表内联查看（?view=）统一推导
  const viewedArticleId = searchParams.get('view');
  const pathArticleId = location.pathname.startsWith('/articles/')
    ? decodeURIComponent(location.pathname.slice('/articles/'.length))
    : null;
  const currentArticleId = viewedArticleId || pathArticleId;

  // Find the active category object
  const activeCategory = activeCategoryId
    ? categories.find((c) => c.id === activeCategoryId) ?? null
    : null;

  // Inline create state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(CATEGORY_COLORS[0]);
  const [newParentId, setNewParentId] = useState('');  // '' = 顶级目录

  // Inline edit state: which category id is being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  // ── 目录/文章手动分批载入（与位置选择组件一致，每批 ≤10 条）──
  const BATCH_SIZE = 10;
  // key = `cat:<目录id>`（目录下的顶级文章）或 文章 id（其子文章）
  const [loaded, setLoaded] = useState<Record<string, Article[]>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [expandedArticleIds, setExpandedArticleIds] = useState<Set<string>>(new Set());

  // ── 拖拽移动（与文章列表共享状态：自己的目录/文章可拖动，
  //    拖到目标目录/文章/全部按钮上变更位置）──
  // 文章创建人校验（无创建人的旧数据视为可移动）
  const canMoveArticle = (a: Article) => {
    if (!userIdNumber) return false;
    const m = a.created_by?.match(/\d{18}/)?.[0];
    return m ? m === userIdNumber : !a.created_by;
  };

  const finishMove = () => {
    notifyArticleSaved();       // 触发已展开节点的重载
    notifyCategoriesChanged();  // 目录结构刷新
  };

  const handleDropOnCat = async (e: DragEvent<HTMLElement>, catId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || (d.type === 'cat' && d.id === catId)) return;
    try {
      if (d.type === 'cat') {
        await api.moveCategory(d.id, catId);
        showToast('目录已移动', 'success');
      } else {
        await api.moveArticle(d.id, { category_id: catId, parent_id: '' });
        showToast('文章已移动', 'success');
      }
      finishMove();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移动失败', 'error');
    }
  };

  const handleDropOnArticle = async (e: DragEvent<HTMLElement>, articleId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const d = dragRef.current;
    dragRef.current = null;
    // 目录不可拖到文章上（不可用状态，drop 无效）
    if (!d || d.type !== 'article' || d.id === articleId) return;
    try {
      await api.moveArticle(d.id, { parent_id: articleId });
      showToast('文章已移动', 'success');
      finishMove();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移动失败', 'error');
    }
  };

  const handleDropOnRoot = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      if (d.type === 'cat') {
        await api.moveCategory(d.id, '');
        showToast('目录已移到顶级', 'success');
      } else {
        await api.moveArticle(d.id, { parent_id: '' });
        showToast('文章已移到顶级', 'success');
      }
      finishMove();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移动失败', 'error');
    }
  };

  const catKey = (catId: string) => `cat:${catId}`;

  // 当前选中的文章对象（全局列表优先，已载入分批数据兜底）——新建/上传的默认位置
  const currentArticle = useMemo(() => {
    if (!currentArticleId) return null;
    const found = articles.find((a) => a.id === currentArticleId);
    if (found) return found;
    for (const list of Object.values(loaded)) {
      const hit = list.find((a) => a.id === currentArticleId);
      if (hit) return hit;
    }
    return null;
  }, [currentArticleId, articles, loaded]);

  const loadBatch = useCallback(async (key: string, offset: number, limit: number = BATCH_SIZE) => {
    setLoadingKeys((prev) => new Set(prev).add(key));
    try {
      const isCat = key.startsWith('cat:');
      const data = isCat
        ? await api.getArticles({ category_id: key.slice(4), root_only: true, limit, skip: offset })
        : await api.getArticles({ parent_id: key, limit, skip: offset });
      setLoaded((prev) => ({
        ...prev,
        [key]: offset === 0 ? data : [...(prev[key] ?? []), ...data],
      }));
      setHasMore((prev) => ({ ...prev, [key]: data.length >= limit }));
    } catch {
      // 静默失败：保留已有数据
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const toggleCat = (catId: string) => {
    const key = catKey(catId);
    const cat = categories.find((c) => c.id === catId);
    const willExpand = !expandedCats.has(catId);
    if (willExpand) {
      // 手风琴模式：展开某目录时收缩「同上级」的其他目录
      const pid = cat?.parent_id ?? null;
      setExpandedCats((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          const other = categories.find((c) => c.id === id);
          if ((other?.parent_id ?? null) !== pid) next.add(id);
        }
        next.add(catId);
        return next;
      });
    } else {
      setExpandedCats((prev) => {
        const next = new Set(prev);
        next.delete(catId);
        return next;
      });
    }
    // 首次展开且尚未载入过 → 拉取第一批
    if (willExpand && (loaded[key]?.length ?? 0) === 0) loadBatch(key, 0);
  };

  const toggleArticle = (id: string) => {
    const willExpand = !expandedArticleIds.has(id);
    setExpandedArticleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (willExpand && (loaded[id]?.length ?? 0) === 0) loadBatch(id, 0);
  };

  // ── 目录/文章筛选 ──
  const [catQuery, setCatQuery] = useState('');
  const catFilter = catQuery.trim().toLowerCase();
  const isFiltering = catFilter !== '';

  // 全局搜索状态（由顶部搜索 Enter / 列表页搜索写入 URL ?search= 驱动）
  const listSearch = searchParams.get('search') ?? '';
  // 高级搜索关键词条件（排除“非”条件）：侧边栏结果树同样醒目标识
  const advHighlightTerms = useMemo(
    () => (advancedSearch ?? [])
      .filter((c) => c.type === 'keyword' && !c.negated && c.value)
      .map((c) => (c.value as string).trim())
      .filter(Boolean),
    [advancedSearch],
  );
  // 标签筛选状态（点击文章标签写入 URL ?tag= 驱动）
  // 标签累加筛选：URL 可携带多个 ?tag=A&tag=B（AND 叠加）
  const listTags = useMemo(() => searchParams.getAll('tag'), [searchParams]);
  // 侧边栏醒目标识：顶部全局搜索词 + 标签筛选 + 高级搜索关键词 + 侧边栏筛选词
  const highlightTerms = useMemo(
    () => Array.from(new Set([listSearch, ...listTags, catQuery, ...advHighlightTerms].map((t) => t.trim()).filter(Boolean))),
    [listSearch, listTags, catQuery, advHighlightTerms],
  );
  const tagMode = listTags.length > 0;
  const tagQs = useMemo(
    () => listTags.map((t) => `tag=${encodeURIComponent(t)}`).join('&'),
    [listTags],
  );

  // 侧边栏筛选：基于当前搜索结果的筛选（搜索模式下过滤 facets；
  // 浏览模式下过滤目录名 + 后端标题查询），不写 URL，与顶部搜索解耦
  const handleCatQueryChange = (value: string) => {
    setCatQuery(value);
  };

  const searchMode = listSearch.trim() !== '';
  // 高级搜索模式（?adv=1 + 已提交条件）：侧边栏与搜索结果处理一致，展示结果目录树
  const advMode = searchParams.get('adv') === '1' && !!advancedSearch;

  const facetHref = (catId: string | null) =>
    `/articles?search=${encodeURIComponent(listSearch)}${catId ? `&category=${catId}` : ''}`;

  // 标签筛选模式的目录链接（?tag= + category 下钻）
  const tagHref = (catId: string) =>
    `/articles?${tagQs}&category=${catId}`;

  // 结果树目录链接：高级搜索模式条件存于上下文（非 URL），点击时设置目录筛选
  const treeCatHref = (catId: string) => (advMode ? '/articles?adv=1' : tagMode ? tagHref(catId) : facetHref(catId));
  const handleTreeCatClick = (catId: string) => {
    if (advMode) setAdvCategoryId(catId);
    closeSidebar();
  };
  // 结果树中的当前目录高亮（高级搜索用上下文目录，搜索用 URL category）
  const activeCatId = advMode ? advCategoryId : activeCategoryId;

  // 搜索树目录收缩状态：默认全部展开；搜索词/高级搜索条件/标签变化时重置
  const [searchCollapsedCats, setSearchCollapsedCats] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSearchCollapsedCats(new Set());
  }, [listSearch, advancedSearch, listTags]);
  const toggleSearchCat = (catId: string) => {
    setSearchCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId); else next.add(catId);
      return next;
    });
  };

  // 搜索/高级搜索/标签筛选模式：目录-文章树数据（匹配文章按目录组织，上限 200 条）
  const [searchTreeArticles, setSearchTreeArticles] = useState<Article[] | null>(null);
  useEffect(() => {
    if (!searchMode && !advMode && !tagMode) {
      setSearchTreeArticles(null);
      return;
    }
    let cancelled = false;
    if (advMode && advancedSearch) {
      api.advancedSearchArticles(advancedSearch, 0, 200)
        .then((d) => {
          if (cancelled) return;
          setSearchTreeArticles(d.items);
        })
        .catch(() => { if (!cancelled) setSearchTreeArticles([]); });
    } else if (tagMode) {
      api.getArticles({ tag: listTags, limit: 200 })
        .then((data) => { if (!cancelled) setSearchTreeArticles(data); })
        .catch(() => { if (!cancelled) setSearchTreeArticles([]); });
    } else {
      api.getArticles({ search: listSearch, limit: 200 })
        .then((data) => { if (!cancelled) setSearchTreeArticles(data); })
        .catch(() => { if (!cancelled) setSearchTreeArticles([]); });
    }
    return () => { cancelled = true; };
  }, [searchMode, advMode, tagMode, listSearch, listTags, advancedSearch]);

  // 搜索树结构：按侧边栏筛选词过滤匹配文章 → 目录可见集（含祖先链）
  const searchTree = useMemo(() => {
    if (!searchTreeArticles) return null;
    const matched = catFilter
      ? searchTreeArticles.filter((a) => a.title.toLowerCase().includes(catFilter))
      : searchTreeArticles;
    const byCat = new Map<string, Article[]>();
    for (const a of matched) {
      if (!a.category_id) continue;
      byCat.set(a.category_id, [...(byCat.get(a.category_id) ?? []), a]);
    }
    const visible = new Set<string>(byCat.keys());
    const byId = new Map(categories.map((c) => [c.id, c]));
    for (const catId of [...byCat.keys()]) {
      let cur = byId.get(catId);
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        visible.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    return { byCat, visible, matchedCount: matched.length };
  }, [searchTreeArticles, catFilter, categories]);

  /** 搜索模式：按目录层级递归渲染匹配文章树（默认全部展开，目录可收缩）。 */
  const renderSearchTreeNodes = (catList: Category[], depth: number): JSX.Element => (
    <ul className={styles.articleTree}>
      {catList.map((cat) => {
        const kids = (categoryChildren.get(cat.id) ?? [])
          .filter((k) => searchTree?.visible.has(k.id) ?? false);
        const arts = searchTree?.byCat.get(cat.id) ?? [];
        const isCollapsed = searchCollapsedCats.has(cat.id);
        return (
          <li key={cat.id}>
            <div className={styles.catRowMain} style={{ paddingLeft: depth * 14 }}>
              <button
                type="button"
                className={styles.catToggle}
                onClick={() => toggleSearchCat(cat.id)}
                title={isCollapsed ? '展开' : '收起'}
                aria-expanded={!isCollapsed}
              >
                <span className={styles.catFolderWrap}>
                  <span className={styles.catFolderIcon}>{isCollapsed ? '📁' : '📂'}</span>
                  <span className={styles.catFolderDot} style={{ background: cat.color }} />
                </span>
              </button>
              <NavLink
                to={treeCatHref(cat.id)}
                className={`${styles.item} ${activeCatId === cat.id ? styles.itemActive : ''}`}
                onClick={() => handleTreeCatClick(cat.id)}
                title={`筛选到目录「${cat.name}」`}
              >
                <span className={styles.catName}><HighlightText text={cat.name} terms={highlightTerms} /></span>
                <span className={styles.count}>{arts.length}</span>
              </NavLink>
            </div>
            {!isCollapsed && kids.length > 0 && renderSearchTreeNodes(kids, depth + 1)}
            {!isCollapsed && arts.length > 0 && (
              <div className={styles.catArticles} style={{ marginLeft: (depth + 1) * 14 }}>
                {arts.map((a) => (
                  <NavLink
                    key={a.id}
                    to={advMode
                      ? `/articles?adv=1&view=${a.id}`
                      : tagMode
                        ? `/articles?${tagQs}&view=${a.id}`
                        : `/articles?search=${encodeURIComponent(listSearch)}&view=${a.id}`}
                    className={`${styles.articleItem}${currentArticleId === a.id ? ` ${styles.articleItemActive}` : ''}`}
                    onClick={closeSidebar}
                    title={a.title}
                  >
                    <span className={styles.articleIcon}>📄</span>
                    <span className={styles.articleTitle}><HighlightText text={a.title} terms={highlightTerms} /></span>
                  </NavLink>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  // 可见目录的顶级节点（按名称排序）
  const searchTreeRoots = useMemo(() => {
    if (!searchTree) return [];
    return categories
      .filter((c) => !c.parent_id && searchTree.visible.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, searchTree]);

  // 目录名匹配（客户端）；文章标题匹配走后端 title 查询（分批）
  const nameMatchedCats = isFiltering
    ? categories.filter((c) => c.name.toLowerCase().includes(catFilter))
    : [];

  const [searchResults, setSearchResults] = useState<Article[]>([]);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchSeqRef = useRef(0);

  const runSearch = useCallback(async (q: string, offset: number) => {
    const seq = ++searchSeqRef.current;
    setSearchLoading(true);
    try {
      const data = await api.getArticles({ title: q, limit: BATCH_SIZE, skip: offset });
      if (seq !== searchSeqRef.current) return; // 过期请求丢弃
      setSearchResults((prev) => (offset === 0 ? data : [...prev, ...data]));
      setSearchHasMore(data.length >= BATCH_SIZE);
    } catch {
      // 静默失败
    } finally {
      if (seq === searchSeqRef.current) setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = catQuery.trim();
    if (!q || searchMode || tagMode) {
      searchSeqRef.current++;
      setSearchResults([]);
      setSearchHasMore(false);
      setSearchLoading(false);
      return;
    }
    runSearch(q, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catQuery, runSearch]);

  // 筛选时自动展开并载入「目录名命中」的目录（搜索/标签模式下不执行——侧边栏仅过滤结果树）
  useEffect(() => {
    if (!isFiltering || searchMode || tagMode) return;
    nameMatchedCats.forEach((c) => {
      setExpandedCats((prev) => (prev.has(c.id) ? prev : new Set(prev).add(c.id)));
      if ((loaded[catKey(c.id)]?.length ?? 0) === 0) loadBatch(catKey(c.id), 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catFilter]);

  /** 递归渲染文章行（子文章分批载入，可继续展开/加载更多）。 */
  const renderArticleNodes = (list: Article[]): JSX.Element => (
    <ul className={styles.articleTree}>
      {list.map((a) => {
        const kids = loaded[a.id] ?? [];
        const isExpanded = expandedArticleIds.has(a.id);
        // 文章图标恒定 📄；有子文章时在图标上叠加展开箭头（兼作展开开关），无子文章为静态图标
        const hasKids = a.children_tree.length > 0;
        return (
          <li key={a.id}>
            <div
              className={`${styles.articleRow}${dropTarget === a.id ? ` ${styles.dropTarget}` : ''}${dropTarget === `invalid:${a.id}` ? ` ${styles.dropTargetInvalid}` : ''}`}
              draggable={canMoveArticle(a)}
              onDragStart={(e) => startDrag(e, 'article', a.id, canMoveArticle(a))}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragRef.current?.type === 'cat') {
                  // 目录不能挂到文章下：不可用状态
                  e.dataTransfer.dropEffect = 'none';
                  if (dropTarget !== `invalid:${a.id}`) setDropTarget(`invalid:${a.id}`);
                } else {
                  dragOverTarget(e, a.id);
                }
              }}
              onDragLeave={() => {
                clearDropTarget(a.id);
                clearDropTarget(`invalid:${a.id}`);
              }}
              onDrop={(e) => handleDropOnArticle(e, a.id)}
            >
              {hasKids ? (
                <button
                  type="button"
                  className={styles.articleIconWrap}
                  onClick={() => toggleArticle(a.id)}
                  title={isExpanded ? '收起子文章' : '展开子文章'}
                  aria-expanded={isExpanded}
                >
                  <span className={styles.articleIcon}>📄</span>
                  <span className={`${styles.articleExpandBadge}${isExpanded ? ` ${styles.articleExpandBadgeOpen}` : ''}`}>▸</span>
                </button>
              ) : (
                <span className={styles.articleIconWrap}>
                  <span className={styles.articleIcon}>📄</span>
                </span>
              )}
              <NavLink
                to={`/articles?view=${a.id}`}
                className={`${styles.articleItem}${currentArticleId === a.id ? ` ${styles.articleItemActive}` : ''}`}
                onClick={closeSidebar}
                title={a.title}
              >
                <span className={styles.articleTitle}><HighlightText text={a.title} terms={highlightTerms} /></span>
              </NavLink>
            </div>
            {isExpanded && kids.length > 0 && renderArticleNodes(kids)}
            {isExpanded && kids.length === 0 && loadingKeys.has(a.id) && (
              <span className={styles.articleLoading}>加载中…</span>
            )}
            {isExpanded && hasMore[a.id] && (
              <button
                type="button"
                className={styles.sidebarLoadMore}
                onClick={() => loadBatch(a.id, kids.length)}
                disabled={loadingKeys.has(a.id)}
              >
                {loadingKeys.has(a.id) ? '加载中…' : `加载更多（已载入 ${kids.length} 条）`}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  // 子目录表：上级目录 → 直接子目录（按名称排序）
  const categoryChildren = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const c of categories) {
      if (!c.parent_id) continue;
      map.set(c.parent_id, [...(map.get(c.parent_id) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [categories]);

  // 新建目录表单：显示在父目录内容末尾（顶级目录则显示在列表末尾），无位置选择
  const renderCreateForm = (): JSX.Element => (
    <div className={styles.catForm}>
      <input
        type="text"
        className={styles.catInput}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="目录名称…"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleCreate();
          if (e.key === 'Escape') cancelCreate();
        }}
      />
      <div className={styles.colorRow}>
        {CATEGORY_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.colorDot} ${newColor === c ? styles.colorDotActive : ''}`}
            style={{ background: c }}
            onClick={() => setNewColor(c)}
            title={c}
          />
        ))}
      </div>
      <div className={styles.formActions}>
        <button className={styles.formBtn} onClick={cancelCreate}>取消</button>
        <button className={`${styles.formBtn} ${styles.formBtnPrimary}`} onClick={handleCreate} disabled={!newName.trim()}>创建</button>
      </div>
    </div>
  );

  /** 递归渲染目录节点：子目录（树形）+ 该目录的文章（分批载入）。 */
  const renderCategoryNode = (cat: Category): JSX.Element => {
    const kids = categoryChildren.get(cat.id) ?? [];
    const catIsExpanded = isFiltering || expandedCats.has(cat.id);
    // 有子目录或文章时显示展开按钮
    const chevronVisible = kids.length > 0
      || (loaded[catKey(cat.id)]?.length ?? 0) > 0
      || !!hasMore[catKey(cat.id)]
      || getCount(cat.id) > 0;
    return (
      <div key={cat.id} className={styles.catRow} style={{ '--tree-accent': cat.color } as CSSProperties}>
        {editingId === cat.id ? (
          /* ── Inline edit form ── */
          <div className={styles.catForm}>
            <input
              type="text"
              className={styles.catInput}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleUpdate();
                if (e.key === 'Escape') cancelEdit();
              }}
            />
            <div className={styles.colorRow}>
              {CATEGORY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${styles.colorDot} ${editColor === c ? styles.colorDotActive : ''}`}
                  style={{ background: c }}
                  onClick={() => setEditColor(c)}
                  title={c}
                />
              ))}
            </div>
            <div className={styles.formActions}>
              <button className={styles.formBtn} onClick={cancelEdit}>取消</button>
              <button className={`${styles.formBtn} ${styles.formBtnPrimary}`} onClick={handleUpdate} disabled={!editName.trim()}>保存</button>
            </div>
          </div>
        ) : (
          /* ── Normal row ── */
          <>
            <div
              className={`${styles.catRowMain}${dropTarget === `cat:${cat.id}` ? ` ${styles.dropTarget}` : ''}`}
              draggable={canModify(cat)}
              onDragStart={(e) => startDrag(e, 'cat', cat.id, canModify(cat))}
              onDragOver={(e) => dragOverTarget(e, `cat:${cat.id}`)}
              onDragLeave={() => clearDropTarget(`cat:${cat.id}`)}
              onDrop={(e) => handleDropOnCat(e, cat.id)}
            >
              {(chevronVisible || catIsExpanded) ? (
                <button
                  type="button"
                  className={styles.catToggle}
                  onClick={() => toggleCat(cat.id)}
                  disabled={isFiltering}
                  title={catIsExpanded ? '收起' : '展开'}
                  aria-expanded={catIsExpanded}
                >
                  <span className={styles.catFolderWrap}>
                    <span className={styles.catFolderIcon}>{catIsExpanded ? '📂' : '📁'}</span>
                    <span className={styles.catFolderDot} style={{ background: cat.color }} />
                  </span>
                </button>
              ) : (
                /* 无文章目录：不灰显（正常图标 + 颜色点），仍不可展开 */
                <span className={styles.catFolderWrap}>
                  <span className={styles.catFolderIcon}>📁</span>
                  <span className={styles.catFolderDot} style={{ background: cat.color }} />
                </span>
              )}
              <NavLink
                to={`/articles?category=${cat.id}`}
                className={`${styles.item} ${activeCategoryId === cat.id ? styles.itemActive : ''}`}
                onClick={() => {
                  // 选中目录（导航）+ 展开或收缩
                  toggleCat(cat.id);
                  closeSidebar();
                }}
                title={`查看「${cat.name}」目录（点击切换展开）`}
              >
                <span className={styles.catName}><HighlightText text={cat.name} terms={highlightTerms} /></span>
                {cat.created_by && (
                  <span
                    className={styles.catCreator}
                    title={`创建人：${cat.created_by.replace(/\s+\d{18}$/, '')}${cat.created_at ? '\n创建时间：' + new Date(cat.created_at).toLocaleString('zh-CN') : ''}${cat.updated_at && cat.updated_at !== cat.created_at ? '\n更新时间：' + new Date(cat.updated_at).toLocaleString('zh-CN') : ''}`}
                  >👤</span>
                )}
              </NavLink>
              {canModify(cat) && (
                <div className={styles.catRowActions}>
                  <button
                    type="button"
                    className={styles.catActionBtn}
                    onClick={() => startEdit(cat)}
                    title={`编辑目录名称「${cat.name}」`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={`${styles.catActionBtn} ${styles.catActionBtnDanger}`}
                    onClick={() => handleDelete(cat)}
                    title={`删除「${cat.name}」`}
                  >
                    ✕
                  </button>
                </div>
              )}
              <span className={styles.count}>
                {getTotalCount(cat.id)}
              </span>
            </div>
            {catIsExpanded && (
              <div className={styles.catArticles}>
                {/* 子目录（树形递归） */}
                {kids.length > 0 && (
                  <div className={styles.catChildren}>
                    {kids.map((k) => renderCategoryNode(k))}
                  </div>
                )}
                {/* 本目录文章（分批载入） */}
                {loadingKeys.has(catKey(cat.id)) && (loaded[catKey(cat.id)] ?? []).length === 0 ? (
                  <span className={styles.articleLoading}>加载中…</span>
                ) : (loaded[catKey(cat.id)] ?? []).length === 0 ? (
                  kids.length === 0 && <span className={styles.articleEmpty}>暂无文章</span>
                ) : (
                  renderArticleNodes(loaded[catKey(cat.id)] ?? [])
                )}
                {hasMore[catKey(cat.id)] && (loaded[catKey(cat.id)]?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    className={styles.sidebarLoadMore}
                    onClick={() => loadBatch(catKey(cat.id), (loaded[catKey(cat.id)] ?? []).length)}
                    disabled={loadingKeys.has(catKey(cat.id))}
                  >
                    {loadingKeys.has(catKey(cat.id)) ? '加载中…' : `加载更多（已载入 ${(loaded[catKey(cat.id)] ?? []).length} 条）`}
                  </button>
                )}
                {showCreate && newParentId === cat.id && renderCreateForm()}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // 展开某目录的祖先链（含自身），使嵌套目录可见
  const expandCategoryChain = (catId: string) => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: Category | undefined = byId.get(catId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    setExpandedCats((prev) => {
      const next = new Set(prev);
      chain.forEach((id) => next.add(id));
      return next;
    });
    chain.forEach((id) => {
      if ((loaded[catKey(id)]?.length ?? 0) === 0) loadBatch(catKey(id), 0);
    });
  };

  // 当前浏览的目录自动展开（含祖先链）并载入；
  // 无文章且无子目录的目录点击名称只导航、不展开
  useEffect(() => {
    if (!activeCategoryId) return;
    const cat = categories.find((c) => c.id === activeCategoryId);
    const hasContent = !!cat && (
      (categoryChildren.get(cat.id) ?? []).length > 0 || getCount(cat.id) > 0
    );
    if (!hasContent) return;
    expandCategoryChain(activeCategoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategoryId, loadBatch]);

  // 正在浏览某文章时：自动展开其目录与祖先链，使选中文章醒目可见
  useEffect(() => {
    if (!currentArticleId) return;
    const byId = new Map(articles.map((a) => [a.id, a]));
    const start = byId.get(currentArticleId);
    if (!start) return;
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let cur: Article | undefined = start.parent_id ? byId.get(start.parent_id) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      ancestors.push(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (start.category_id) {
      expandCategoryChain(start.category_id);
    }
    ancestors.forEach((id) => {
      setExpandedArticleIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      if ((loaded[id]?.length ?? 0) === 0) loadBatch(id, 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentArticleId, loadBatch, articles]);

  // Refetch when articles change (e.g. after upload / save)：按已载入数量刷新已展开的节点
  useEffect(() => {
    if (articleVersion > 0) {
      refetch();
      expandedCats.forEach((id) => {
        const key = catKey(id);
        const n = loaded[key]?.length ?? 0;
        loadBatch(key, 0, Math.max(BATCH_SIZE, n));
      });
      expandedArticleIds.forEach((id) => {
        const n = loaded[id]?.length ?? 0;
        loadBatch(id, 0, Math.max(BATCH_SIZE, n));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleVersion]);

  // 顶级文章数（与动态载入的子列表一致）
  const getCount = (categoryId: string) =>
    articles.filter((a) => a.category_id === categoryId && !a.parent_id).length;

  // 目录树文章总数：本目录文章 + 所有子目录中的文章（递归；徽章计数与删除保护共用）
  const getTotalCount = (categoryId: string): number => {
    const seen = new Set<string>();
    const walk = (id: string): number => {
      if (seen.has(id)) return 0; // 数据异常成环防御
      seen.add(id);
      let sum = articles.filter((a) => a.category_id === id).length;
      for (const sub of categoryChildren.get(id) ?? []) {
        sum += walk(sub.id);
      }
      return sum;
    };
    return walk(categoryId);
  };

  const canModify = (cat: { created_by?: string | null }) => {
    if (!cat.created_by || !userIdNumber) return true;
    const idMatch = cat.created_by.match(/\d{18}/);
    return idMatch ? idMatch[0] === userIdNumber : false;
  };

  // ── Create ──
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const cat = await createCategory({ name, color: newColor, parent_id: newParentId || null });
    if (cat) {
      setShowCreate(false);
      setNewName('');
      setNewColor(CATEGORY_COLORS[0]);
      setNewParentId('');
    }
  };

  const cancelCreate = () => {
    setShowCreate(false);
    setNewName('');
    setNewColor(CATEGORY_COLORS[0]);
    setNewParentId('');
  };

  // ── Edit（行内按钮 + 头部按钮共用）──
  const startEdit = (cat: Category) => {
    setEditingId(cat.id);
    setEditName(cat.name);
    setEditColor(cat.color);
  };

  const handleUpdate = async () => {
    const name = editName.trim();
    if (!name || !editingId) return;
    // parent_id 始终发送：'' = 顶级目录
    const cat = await updateCategory(editingId, { name, color: editColor });
    if (cat) {
      setEditingId(null);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  // ── Delete（行内按钮 + 头部按钮共用）──
  const handleDelete = (cat: Category) => {
    // 有子目录时拒绝删除（前端先行拦截，后端同样兜底）
    if ((categoryChildren.get(cat.id) ?? []).length > 0) {
      showToast(
        `目录「${cat.name}」下还有子目录，请先移动或删除子目录`,
        'warning',
      );
      return;
    }

    // Check if category has articles — refuse on frontend side（含嵌套文章）
    const articleCount = getTotalCount(cat.id);
    if (articleCount > 0) {
      showToast(
        `目录「${cat.name}」下还有 ${articleCount} 篇文章，请先移除或转移文章后再删除`,
        'warning',
      );
      return;
    }

    requestConfirm('删除目录', `确定要删除目录「${cat.name}」吗？`, () => {
      deleteCategory(cat.id);
    });
  };

  return (
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
      {/* 顶部固定区：「全部」按钮 + 筛选框（不随目录树滚动） */}
      <div className={styles.navHeader}>
        <div className={styles.sectionHeader}>
          <NavLink
            to={advMode
              ? '/articles?adv=1'
              : searchMode
                ? `/articles?search=${encodeURIComponent(listSearch)}`
                : tagMode
                  ? `/articles?${tagQs}`
                  : '/articles'}
            className={`${styles.allBtn} ${advMode ? (advCategoryId ? '' : styles.allBtnActive) : !activeCategoryId ? styles.allBtnActive : ''}${dropTarget === 'root' ? ` ${styles.dropTarget}` : ''}`}
            onClick={() => {
              // 浏览模式：全部 = 根目录；筛选模式：全部 = 基于当前搜索/标签的结果根目录
              if (advMode) setAdvCategoryId(null);
              closeSidebar();
            }}
            title={advMode || searchMode || tagMode
              ? '查看全部筛选结果（拖拽目录/文章到此 = 移到顶级）'
              : '查看全部文章 — 根目录（拖拽目录/文章到此 = 移到顶级）'}
            onDragOver={(e) => dragOverTarget(e, 'root')}
            onDragLeave={() => clearDropTarget('root')}
            onDrop={handleDropOnRoot}
          >
            <span className={styles.allBtnIcon}>🏠</span>
          </NavLink>
          <div className={styles.catSearch}>
            <span className={styles.catSearchIcon}>
              {/* 筛选漏斗图标 */}
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </span>
            <input
              type="text"
              className={styles.catSearchInput}
              placeholder="筛选目录或文章标题…"
              value={catQuery}
              onChange={(e) => handleCatQueryChange(e.target.value)}
              autoComplete="off"
            />
            {catQuery && (
              <button
                type="button"
                className={styles.catSearchClear}
                onClick={() => handleCatQueryChange('')}
                title="清除筛选"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      <nav
        className={styles.nav}
        onDragOver={(e) => dragOverTarget(e, 'root')}
        onDragLeave={() => clearDropTarget('root')}
        onDrop={handleDropOnRoot}
      >
        <div className={styles.section}>

          {searchMode || advMode || tagMode ? (
            /* ── 按搜索/高级搜索/标签筛选结果组织的目录-文章树（「全部结果」由顶部「全部」按钮承担）── */
            <div className={styles.searchFacets}>
              {!searchTree ? (
                <div className={styles.articleLoading}>统计中…</div>
              ) : searchTreeRoots.length === 0 ? (
                <div className={styles.articleLoading}>无匹配文章</div>
              ) : (
                renderSearchTreeNodes(searchTreeRoots, 0)
              )}
            </div>
          ) : (
            <>
          {isFiltering && nameMatchedCats.length === 0 && searchResults.length === 0 && !searchLoading && (
            <div className={styles.catSearchEmpty}>无匹配目录或文章</div>
          )}

          {(isFiltering
            ? nameMatchedCats
            : categories.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name))
          ).map((cat) => renderCategoryNode(cat))}

          {showCreate && newParentId === '' && renderCreateForm()}

          {/* ── 筛选：文章标题匹配（后端查询，分批载入）── */}
          {isFiltering && (searchResults.length > 0 || searchLoading || searchHasMore) && (
            <div className={styles.catSearchResults}>
              <div className={styles.sectionLabel}>文章标题匹配</div>
              {searchResults.map((a) => (
                <NavLink
                  key={a.id}
                  to={`/articles?view=${a.id}`}
                  className={`${styles.articleItem}${currentArticleId === a.id ? ` ${styles.articleItemActive}` : ''}`}
                  onClick={closeSidebar}
                  title={a.title}
                >
                  <span className={styles.articleIcon}>📄</span>
                  <span className={styles.articleTitle}><HighlightText text={a.title} terms={highlightTerms} /></span>
                  {a.category && (
                    <span className={styles.searchCatTag} style={{ color: a.category.color }}>
                      {a.category.name}
                    </span>
                  )}
                </NavLink>
              ))}
              {searchLoading && searchResults.length === 0 && (
                <span className={styles.articleEmpty}>搜索中…</span>
              )}
              {searchHasMore && (
                <button
                  type="button"
                  className={styles.sidebarLoadMore}
                  onClick={() => runSearch(catQuery.trim(), searchResults.length)}
                  disabled={searchLoading}
                >
                  {searchLoading ? '加载中…' : `加载更多（已载入 ${searchResults.length} 条）`}
                </button>
              )}
            </div>
          )}
            </>
          )}
        </div>
      </nav>

      <div className={styles.actions}>
        <button
          className={styles.newBtn}
          onClick={() => {
            // 已选中文章时：新文章默认挂载到该文章下（同目录）
            openEditor(null, currentArticle
              ? { parentId: currentArticle.id, categoryId: currentArticle.category_id }
              : undefined);
            closeSidebar();
          }}
        >
          <span className={styles.newBtnIcon}>📝</span> 新建文章
        </button>
        <div className={styles.actionRow}>
          <button
            className={styles.secondaryBtn}
            onClick={() => {
              // 当前选中的目录下新建子目录（无选中时为顶级目录）；展开父目录使表单可见
              setNewParentId(activeCategoryId ?? '');
              if (activeCategoryId) expandCategoryChain(activeCategoryId);
              setShowCreate(true);
              closeSidebar();
            }}
            title={activeCategory
              ? `在「${activeCategory.name}」下新建子目录`
              : '新建顶级目录'}
          >
            <span className={styles.newBtnIcon}>📁</span> 新增目录
          </button>
          <button
            className={styles.secondaryBtn}
            onClick={() => {
              // 已选中文章时：上传文件默认挂载到该文章下（同目录）
              openUploader(currentArticle
                ? { parentId: currentArticle.id, categoryId: currentArticle.category_id }
                : undefined);
              closeSidebar();
            }}
          >
            <span className={styles.newBtnIcon}>📤</span> 上传文件
          </button>
        </div>
      </div>
    </aside>
  );
}
