import { Fragment, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { ArticleCard } from './ArticleCard';
import { ArticleDetailInline } from './ArticleDetail';
import type { Article } from '../types/article';
import type { Category } from '../types/category';
import { EntityPanel } from './EntityPanel';
import type { OrderedArticle } from '../utils/hierarchy';
import styles from './ArticleList.module.css';

// 文章列表分页：每页篇数（与侧边栏/位置选择器的分批加载一致）
const PAGE_SIZE = 10;

/** 由文章集计算某层级（parent 的子目录）的目录分布：仅含子树有匹配的目录，附子树计数。 */
function dirChipsFromArticles(
  categories: Category[],
  base: Article[],
  parent: string | null,
): { category: Category; count: number }[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const direct = new Map<string, number>();
  for (const a of base) {
    if (!a.category_id) continue;
    direct.set(a.category_id, (direct.get(a.category_id) ?? 0) + 1);
  }
  // 子树计数：沿祖先链累计
  const subtree = new Map<string, number>();
  for (const catId of direct.keys()) {
    let cur = byId.get(catId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      subtree.set(cur.id, (subtree.get(cur.id) ?? 0) + (direct.get(catId) ?? 0));
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  return categories
    .filter((c) => (c.parent_id ?? null) === parent && (subtree.get(c.id) ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ category: c, count: subtree.get(c.id) ?? 0 }));
}

/** 目录创建人（去掉尾部 18 位证件号，与文章详情一致） */
function formatDirUser(cn?: string | null): string {
  if (!cn) return '';
  const m = cn.match(/^(.+?)\s+\d{18}$/);
  return m ? m[1] : cn;
}

function formatDirDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 目录颜色可选值（与侧边栏一致） */
const CATEGORY_COLORS = [
  '#1E5C8A', '#7D5E3C', '#3D7B4F', '#A0524B',
  '#5B5A8C', '#C07B3A', '#4A7A8C', '#8C5260',
];

/** 目录修改/删除权限（与侧边栏一致）：无创建人旧数据可改，有则按证件号比对 */
function canModifyCategory(cat: Category, userIdNumber: string): boolean {
  if (!cat.created_by || !userIdNumber) return true;
  const idMatch = cat.created_by.match(/\d{18}/);
  return idMatch ? idMatch[0] === userIdNumber : false;
}

// ── 排序 ────────────────────────────────────────────

type SortField = 'time' | 'title' | 'creator';

interface SortCriterion {
  id: number;
  field: SortField;
  order: 'desc' | 'asc';
}

const SORT_FIELD_LABELS: Record<SortField, string> = {
  time: '时间',
  title: '标题 / 目录名',
  creator: '创建人',
};

/** 目录排序键 */
const dirTimeKey = (d: Category) => d.updated_at ?? d.created_at ?? '';
const dirCreatorKey = (d: Category) => d.created_by ?? '';

/** 文章排序键 */
function articleSortKey(a: Article, f: SortField): string {
  if (f === 'time') return a.updated_at;
  if (f === 'title') return a.title;
  return a.created_by ?? '';
}

/** 字符串比较：空值排后；标题/创建人按中文拼音序 */
function compareKeys(a: string, b: string, numeric: boolean): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return numeric ? a.localeCompare(b) : a.localeCompare(b, 'zh-CN');
}

/** 组合排序比较器：按排序条件先后依次比较 */
function makeComparator<T>(keyOf: (item: T, f: SortField) => string, criteria: SortCriterion[]): (x: T, y: T) => number {
  return (x, y) => {
    for (const c of criteria) {
      const cmp = compareKeys(keyOf(x, c.field), keyOf(y, c.field), c.field === 'time');
      if (cmp !== 0) return c.order === 'desc' ? -cmp : cmp;
    }
    return 0;
  };
}

/** 目录卡片（根目录视图 / 文章列表目录入口统一样式）：含创建人、创建时间、修改/删除 */
function DirCard({
  d, count, to, onClick, title,
  canModify, editing, editName, editColor,
  onEditNameChange, onEditColorChange, onStartEdit, onSaveEdit, onCancelEdit, onDelete,
  draggable = false, dropHighlight = null,
  onDragStart, onDragOver, onDragLeave, onDrop,
}: {
  d: Category;
  count: number;
  to: string;
  onClick?: () => void;
  title: string;
  canModify: boolean;
  editing: boolean;
  editName: string;
  editColor: string;
  onEditNameChange: (v: string) => void;
  onEditColorChange: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  draggable?: boolean;
  dropHighlight?: boolean | null;
  onDragStart?: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLElement>) => void;
}) {
  const meta = [
    formatDirUser(d.created_by) ? `👤 ${formatDirUser(d.created_by)}` : '',
    formatDirDate(d.created_at) ? `📅 ${formatDirDate(d.created_at)}` : '',
  ].filter(Boolean).join(' · ');
  if (editing) {
    return (
      <div className={styles.rootDirCard} style={{ '--dir-accent': d.color } as CSSProperties}>
        <span className={styles.rootDirIcon}>📁</span>
        <form
          className={styles.dirEditForm}
          onSubmit={(e) => {
            e.preventDefault();
            onSaveEdit();
          }}
        >
          <input
            type="text"
            className={styles.dirEditInput}
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEdit();
            }}
            aria-label="目录名称"
          />
          <div className={styles.dirColorRow}>
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`${styles.dirColorDot} ${editColor === c ? styles.dirColorDotActive : ''}`}
                style={{ background: c }}
                onClick={() => onEditColorChange(c)}
                title={c}
              />
            ))}
          </div>
          <div className={styles.dirEditActions}>
            <button type="button" className={styles.dirEditBtn} onClick={onCancelEdit}>取消</button>
            <button
              type="submit"
              className={`${styles.dirEditBtn} ${styles.dirEditBtnPrimary}`}
              disabled={!editName.trim()}
            >
              保存
            </button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`${styles.rootDirCard}${dropHighlight ? ` ${styles.dropTarget}` : ''}`}
      style={{ '--dir-accent': d.color } as CSSProperties}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className={styles.rootDirIcon}>📁</span>
      <span className={styles.rootDirName}>{d.name}</span>
      {/* 创建人/创建时间靠右 */}
      {meta && <span className={styles.rootDirMeta}>{meta}</span>}
      {/* 修改/删除：权限控制同侧边栏 */}
      {canModify && (
        <span className={styles.dirActions}>
          <button
            type="button"
            className={styles.dirActionBtn}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onStartEdit();
            }}
            title={`修改目录名称和颜色`}
          >
            ✎
          </button>
          <button
            type="button"
            className={`${styles.dirActionBtn} ${styles.dirActionBtnDanger}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            title={`删除目录「${d.name}」`}
          >
            ✕
          </button>
        </span>
      )}
      <span className={styles.rootDirCount}>{count} 篇</span>
      <span className={styles.rootDirArrow}>›</span>
    </Link>
  );
}

export function ArticleList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = searchParams.get('category') ?? undefined;
  const search = searchParams.get('search') ?? undefined;
  // 标签累加筛选：URL 可携带多个 ?tag=A&tag=B（AND 叠加）
  const tags = useMemo(() => searchParams.getAll('tag'), [searchParams]);
  // 标签查询串（不含前导 ?），供各类链接拼接复用
  const tagQs = useMemo(
    () => tags.map((t) => `tag=${encodeURIComponent(t)}`).join('&'),
    [tags],
  );
  const viewId = searchParams.get('view') ?? undefined;

  const {
    openEditor, articleVersion, categoriesVersion, searchInputRef,
    advancedSearch, advCategoryId, setAdvCategoryId,
    requestConfirm, userIdNumber,
    notifyArticleSaved, notifyCategoriesChanged,
    dragRef, dropTarget, setDropTarget, startDrag, dragOverTarget, clearDropTarget,
    entityPanelMode,
  } = useApp();
  const { categories, updateCategory, deleteCategory } = useCategories();
  const { showToast } = useToast();

  // ── 拖拽移动（与侧边栏共享状态：列表 ⇄ 侧边栏相互移动）──
  const canMoveArticle = (a: Article) => {
    if (!userIdNumber) return false;
    const m = a.created_by?.match(/\d{18}/)?.[0];
    return m ? m === userIdNumber : !a.created_by;
  };
  const finishMove = () => {
    notifyArticleSaved();       // 列表与侧边栏刷新
    notifyCategoriesChanged();  // 目录结构与计数刷新
  };

  const handleDropOnListCat = async (e: React.DragEvent<HTMLElement>, catId: string) => {
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

  const handleDropOnListArticle = async (e: React.DragEvent<HTMLElement>, articleId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const d = dragRef.current;
    dragRef.current = null;
    // 目录不可挂到文章下（不可用状态，drop 无效）
    if (!d || d.type !== 'article' || d.id === articleId) return;
    try {
      await api.moveArticle(d.id, { parent_id: articleId });
      showToast('文章已移动', 'success');
      finishMove();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移动失败', 'error');
    }
  };

  // ── 目录修改/删除（文章列表目录卡片；权限控制同侧边栏）──
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatColor, setEditCatColor] = useState(CATEGORY_COLORS[0]);

  const startEditCategory = (cat: Category) => {
    setEditingCatId(cat.id);
    setEditCatName(cat.name);
    setEditCatColor(cat.color);
  };
  const cancelEditCategory = () => setEditingCatId(null);
  const saveEditCategory = async () => {
    const name = editCatName.trim();
    if (!name || !editingCatId) return;
    const cat = await updateCategory(editingCatId, { name, color: editCatColor });
    if (cat) setEditingCatId(null);
  };
  const handleDeleteCategory = (cat: Category) => {
    // 有子目录时拒绝删除（前端先行拦截，后端同样兜底）
    if (categories.some((c) => c.parent_id === cat.id)) {
      showToast(`目录「${cat.name}」下还有子目录，请先移动或删除子目录`, 'warning');
      return;
    }
    // 有文章（含嵌套）时拒绝删除
    const count = dirCounts?.[cat.id] ?? 0;
    if (count > 0) {
      showToast(`目录「${cat.name}」下还有 ${count} 篇文章，请先移除或转移文章后再删除`, 'warning');
      return;
    }
    requestConfirm('删除目录', `确定要删除目录「${cat.name}」吗？`, () => {
      deleteCategory(cat.id);
    });
  };

  // 渲染目录卡片（各视图共用：权限、编辑态与删除逻辑一致；可拖拽、可作放置目标）
  const renderDirCard = ({ category: d, count }: { category: Category; count: number }) => (
    <DirCard
      key={d.id}
      d={d}
      count={count}
      to={dirLink(d).to}
      onClick={dirLink(d).onClick}
      title={dirLink(d).title}
      canModify={canModifyCategory(d, userIdNumber)}
      editing={editingCatId === d.id}
      editName={editCatName}
      editColor={editCatColor}
      onEditNameChange={setEditCatName}
      onEditColorChange={setEditCatColor}
      onStartEdit={() => startEditCategory(d)}
      onSaveEdit={saveEditCategory}
      onCancelEdit={cancelEditCategory}
      onDelete={() => handleDeleteCategory(d)}
      draggable={canModifyCategory(d, userIdNumber)}
      dropHighlight={dropTarget === `cat:${d.id}`}
      onDragStart={(e) => startDrag(e, 'cat', d.id, canModifyCategory(d, userIdNumber))}
      onDragOver={(e) => dragOverTarget(e, `cat:${d.id}`)}
      onDragLeave={() => clearDropTarget(`cat:${d.id}`)}
      onDrop={(e) => handleDropOnListCat(e, d.id)}
    />
  );

  // 分页：页码（1 起）；目录/搜索/标签/高级搜索变化时回到第 1 页
  const [page, setPage] = useState(1);
  const advMode = searchParams.get('adv') === '1' && !!advancedSearch;
  useEffect(() => {
    setPage(1);
  }, [categoryId, search, tags, advMode, advancedSearch, advCategoryId]);

  const params = useMemo(() => ({
    category_id: categoryId,
    search,
    tag: tags.length ? tags : undefined,
    // 层级浏览：只显示直接挂载在当前位置（顶级）的文章，深层文章经父文章的
    // 子文章树导航进入；搜索/标签为全局查询，不受层级限制
    root_only: !search && tags.length === 0,
    skip: (page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
  }), [categoryId, search, tags, page]);
  const { articles, total, loading, error, refetch } = useArticles(params);

  // ── 高级搜索模式（?adv=1 + 已提交条件）：与搜索结果处理一致 ──
  // 目录筛选（结果根目录视图点击目录进入）追加为 category 条件（子树匹配）
  const advConditions = useMemo(() => {
    const conds = [...(advancedSearch ?? [])];
    if (advCategoryId) {
      conds.push({ type: 'category' as const, value: advCategoryId, connector: 'and', negated: false });
    }
    return conds;
  }, [advancedSearch, advCategoryId]);

  const [advArticles, setAdvArticles] = useState<Article[]>([]);
  const [advTotal, setAdvTotal] = useState(0);
  const [advLoading, setAdvLoading] = useState(false);
  const [advError, setAdvError] = useState<string | null>(null);
  useEffect(() => {
    if (!advMode || !advancedSearch) return;
    let cancelled = false;
    setAdvLoading(true);
    setAdvError(null);
    api.advancedSearchArticles(advConditions, (page - 1) * PAGE_SIZE, PAGE_SIZE)
      .then((d) => {
        if (cancelled) return;
        setAdvArticles(d.items);
        setAdvTotal(d.total);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setAdvError(e instanceof Error ? e.message : '高级搜索失败');
      })
      .finally(() => {
        if (!cancelled) setAdvLoading(false);
      });
    return () => { cancelled = true; };
  }, [advMode, advancedSearch, advCategoryId, advConditions, page]);

  // 完整结果集（上限 200）：目录分布/结果根目录视图用（与搜索模式同机制）
  const [advFullArticles, setAdvFullArticles] = useState<Article[] | null>(null);
  useEffect(() => {
    if (!advMode || !advancedSearch) {
      setAdvFullArticles(null);
      return;
    }
    let cancelled = false;
    api.advancedSearchArticles(advConditions, 0, 200)
      .then((d) => { if (!cancelled) setAdvFullArticles(d.items); })
      .catch(() => { if (!cancelled) setAdvFullArticles([]); });
    return () => { cancelled = true; };
  }, [advMode, advancedSearch, advCategoryId, advConditions]);

  // 高级搜索结果的目录分布（当前层级：全部 = 顶级；选中目录 = 其子目录）
  const advDirChips = useMemo(
    () => (advMode && advFullArticles
      ? dirChipsFromArticles(categories, advFullArticles, advCategoryId)
      : []),
    [advMode, advFullArticles, categories, advCategoryId],
  );

  // 高级搜索结果中选中目录的祖先链（面包屑用）
  const advCategoryChain = useMemo(() => {
    if (!advCategoryId) return [];
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chain: { id: string; name: string; color: string }[] = [];
    const seen = new Set<string>();
    let cur = byId.get(advCategoryId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift({ id: cur.id, name: cur.name, color: cur.color });
      cur = cur.parent_id ? (byId.get(cur.parent_id) ?? undefined) : undefined;
    }
    return chain;
  }, [advCategoryId, categories]);

  // 分页总数与越界修正：文章删除等导致总页数减少时自动回到最后一页
  const totalPages = Math.max(1, Math.ceil(((advMode ? advTotal : (total ?? 0))) / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // 翻页后回到列表顶部（header 一并上移，保证看到本页开头）
  const mainColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mainColRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [page]);

  // 筛选框：对当前结果的关键词动态筛选（本地过滤，与顶部搜索框解耦、不写 URL）
  const [filterText, setFilterText] = useState('');

  // ── 排序：组合条件（时间 / 标题·目录名 / 创建人），各条件可倒序/正序 ──
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([
    { id: 0, field: 'time', order: 'desc' },
  ]);
  const [sortOpen, setSortOpen] = useState(false);
  const sortWrapRef = useRef<HTMLDivElement>(null);
  const sortPanelRef = useRef<HTMLDivElement>(null);
  // 面板用 portal 固定定位（避免被主列滚动容器裁剪左侧），打开时按按钮位置计算
  const [sortPanelPos, setSortPanelPos] = useState<{ top: number; left: number } | null>(null);
  const sortIdRef = useRef(1);

  const toggleSortPanel = () => {
    if (!sortOpen) {
      const rect = sortWrapRef.current?.getBoundingClientRect();
      if (rect) {
        // 面板左侧与按钮左侧对齐（右缘越界时收进视口）
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - 308);
        setSortPanelPos({ top: rect.bottom + 6, left });
      }
      setSortOpen(true);
    } else {
      setSortOpen(false);
    }
  };
  const addSortCriterion = () => {
    setSortCriteria((prev) => [...prev, { id: sortIdRef.current++, field: 'time', order: 'desc' }]);
  };
  const updateSortCriterion = (id: number, patch: Partial<Omit<SortCriterion, 'id'>>) => {
    setSortCriteria((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const removeSortCriterion = (id: number) => {
    setSortCriteria((prev) => (prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));
  };
  const resetSort = () => {
    setSortCriteria([{ id: sortIdRef.current++, field: 'time', order: 'desc' }]);
    setSortOpen(false);
  };
  // 点击外部 / 滚动主列时关闭排序面板（面板经 portal 渲染，需同时检查两处容器）
  useEffect(() => {
    if (!sortOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      const inButton = sortWrapRef.current?.contains(t);
      const inPanel = sortPanelRef.current?.contains(t);
      if (!inButton && !inPanel) setSortOpen(false);
    };
    const onScroll = () => setSortOpen(false);
    document.addEventListener('mousedown', onDown);
    const mainCol = mainColRef.current;
    mainCol?.addEventListener('scroll', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      mainCol?.removeEventListener('scroll', onScroll);
    };
  }, [sortOpen]);

  // Selection state
  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(new Set());
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());

  // Entity panel mode 已上移至 AppProvider：由顶部工具栏「知识图谱」按钮切换

  // Selected graph node IDs (for visual highlight + article list filtering)
  const [selectedGraphNodeIds, setSelectedGraphNodeIds] = useState<Set<string>>(new Set());

  // Inline article view
  const [viewedArticleId, setViewedArticleId] = useState<string | null>(null);
  // 被浏览文章不在当前列表中时（如从侧边栏打开目录树深层文章），单独拉取供实体面板使用
  const [viewedArticleDetail, setViewedArticleDetail] = useState<Article | null>(null);

  // Entity highlight (for article content highlighting via rehype plugin)
  const [highlightEntity, setHighlightEntity] = useState<string | null>(null);

  // 面包屑只呈现目录路径：🏠 + 目录链；搜索/标签信息由顶部工具栏 chip 与侧边栏结果树呈现
  const hasFilter = Boolean(categoryId || tags.length || search);
  // 根目录视图：🏠 = 根目录（浏览模式且未选目录）；根目录下没有文章，仅展示顶级目录卡片
  const isRootView = !search && tags.length === 0 && !categoryId;
  // 结果根目录视图：搜索/标签模式「🏠」= 基于结果的根目录，同样没有文章，仅展示有匹配的目录
  const isResultRootView = Boolean(search || tags.length) && !categoryId;

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

  // 目录递归文章数（目录卡片徽章 / 删除保护共用）；
  // 文章/目录变更后刷新
  const [dirCounts, setDirCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getCategoryArticleCounts()
      .then((d) => { if (!cancelled) setDirCounts(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [articleVersion, categoriesVersion]);

  // ── 搜索结果作为文章列表展示的基础 ──
  // 搜索/标签模式拉取完整匹配集（上限 200，与侧边栏搜索树一致），
  // 目录入口只展示匹配集内当前层级（选中目录的子目录 / 顶级）的目录
  const [dirBaseArticles, setDirBaseArticles] = useState<Article[] | null>(null);
  useEffect(() => {
    if (!search && tags.length === 0) {
      setDirBaseArticles(null);
      return;
    }
    let cancelled = false;
    // 全量匹配集（不带目录过滤）：目录分布按「直接目录 + 祖先累计」本地计算，
    // 与侧边栏结果树一致；后端目录过滤为直接匹配，带目录会截断分布统计
    const baseParams = search
      ? { search, limit: 200 }
      : { tag: tags, limit: 200 };
    api.getArticles(baseParams)
      .then((d) => { if (!cancelled) setDirBaseArticles(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [search, tags]);

  // 目录入口：
  // 浏览模式 = 选中目录的全部子目录（该目录的文件由列表直接展示）；
  // 搜索/标签模式 = 以匹配结果为基准，仅显示有匹配的子目录（附子树匹配数）；
  // 高级搜索模式 = 与搜索一致（以结果为基准）；
  // 未选中 = 顶级目录
  const dirChips = useMemo(() => {
    const parent = categoryId ?? null;
    if (!search && tags.length === 0) {
      return categories
        .filter((c) => (c.parent_id ?? null) === parent)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ category: c, count: null as number | null }));
    }
    return dirChipsFromArticles(categories, dirBaseArticles ?? [], parent);
  }, [categories, categoryId, search, tags, dirBaseArticles]);

  // 当前生效的目录 chips（高级搜索模式用其结果分布）
  const effectiveDirChips = advMode ? advDirChips : dirChips;

  // 结果根目录视图的目录卡片（按筛选框关键词过滤目录名）
  const filteredDirChips = useMemo(() => {
    const kw = filterText.trim().toLowerCase();
    if (!kw) return effectiveDirChips;
    return effectiveDirChips.filter(({ category }) => category.name.toLowerCase().includes(kw));
  }, [effectiveDirChips, filterText]);

  // 排序后的目录列表（各视图目录卡片；目录与文章一同排序）
  const sortedDirs = useMemo(() => {
    const dirs = filteredDirChips.map(({ category, count }) => ({
      category,
      count: count != null ? count : dirCounts?.[category.id] ?? 0,
    }));
    dirs.sort(makeComparator(
      (it, f) => f === 'time' ? dirTimeKey(it.category) : f === 'title' ? it.category.name : dirCreatorKey(it.category),
      sortCriteria,
    ));
    return dirs;
  }, [filteredDirChips, dirCounts, sortCriteria]);

  // 目录链接（按当前模式保留筛选状态）
  const dirLink = (d: Category): { to: string; onClick?: () => void; title: string } => {
    if (advMode) return { to: '/articles?adv=1', onClick: () => setAdvCategoryId(d.id), title: `筛选结果到目录「${d.name}」` };
    if (search) return { to: `/articles?search=${encodeURIComponent(search)}&category=${d.id}`, title: `筛选结果到目录「${d.name}」` };
    if (tags.length) return { to: `/articles?${tagQs}&category=${d.id}`, title: `筛选结果到目录「${d.name}」` };
    return { to: `/articles?category=${d.id}`, title: `进入目录「${d.name}」` };
  };

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
    let result = advMode ? advArticles : articles;

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

    // 筛选框：关键词动态筛选当前结果（标题 + 正文，大小写不敏感）
    const kw = filterText.trim().toLowerCase();
    if (kw) {
      result = result.filter(
        (a) => a.title.toLowerCase().includes(kw) || a.content.toLowerCase().includes(kw),
      );
    }

    return result;
  }, [advMode, advArticles, articles, selectedGraphNodeIds, selectedEntities, filterText]);

  // 文章层级深度（卡片缩进用；父链截断于当前集合内）
  const articleDepthMap = useMemo(() => {
    const byId = new Map(displayedArticles.map((a) => [a.id, a]));
    const depths = new Map<string, number>();
    for (const a of displayedArticles) {
      let d = 0;
      let cur = a.parent_id;
      const seen = new Set<string>();
      while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        d += 1;
        cur = byId.get(cur)!.parent_id;
      }
      depths.set(a.id, d);
    }
    return depths;
  }, [displayedArticles]);

  // 文章排序：组合排序条件（时间/标题/创建人 × 倒序/正序）
  const orderedArticles = useMemo(() => {
    const list: OrderedArticle[] = displayedArticles.map((article) => ({
      article,
      depth: articleDepthMap.get(article.id) ?? 0,
    }));
    list.sort(makeComparator(
      (it, f) => articleSortKey(it.article, f),
      sortCriteria,
    ));
    return list;
  }, [displayedArticles, articleDepthMap, sortCriteria]);

  // 目录与文章分别排序：目录按条件排序后始终置于文章列表上方

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
  }, [categoryId, search, tags]);

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

  // ── 文章卡片列表 + 分页器（普通列表 / 高级搜索结果共用）──
  const renderArticleList = () => (
    <>
      {filterText.trim() && displayedArticles.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🔍</div>
          <p>当前结果中无匹配「{filterText.trim()}」的文章</p>
        </div>
      )}
      <div className={styles.list}>
        {orderedArticles.map(({ article: a, depth }) => (
          <ArticleCard
            key={a.id}
            article={a}
            depth={depth}
            selected={selectedArticleIds.has(a.id)}
            onSelect={handleArticleSelect}
            onOpen={handleArticleOpen}
            draggable={canMoveArticle(a)}
            dropHighlight={dropTarget === a.id ? 'drop' : dropTarget === `invalid:${a.id}` ? 'invalid' : null}
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
            onDrop={(e) => handleDropOnListArticle(e, a.id)}
          />
        ))}
      </div>
      {totalPages > 1 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ‹ 上一页
          </button>
          {(() => {
            // 页码窗口：当前页前后各 2 个，最多 5 个页码
            const start = Math.max(1, Math.min(page - 2, totalPages - 4));
            const end = Math.min(totalPages, start + 4);
            const pages: number[] = [];
            for (let p = start; p <= end; p++) pages.push(p);
            return pages.map((p) => (
              <button
                key={p}
                type="button"
                className={p === page ? `${styles.pageBtn} ${styles.pageBtnActive}` : styles.pageBtn}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ));
          })()}
          <button
            type="button"
            className={styles.pageBtn}
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页 ›
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className={styles.layout}>
      <div className={styles.mainCol} ref={mainColRef}>
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
                  } else if (cid) {
                    // 无父文章：返回所在目录的文章列表
                    const params = new URLSearchParams(searchParams);
                    params.delete('view');
                    params.set('category', cid);
                    setSearchParams(params);
                    setViewedArticleId(null);
                    setSelectedArticleIds(new Set());
                    setHighlightEntity(null);
                  } else {
                    handleBack();
                  }
                }}
                prevArticleId={prevId}
                nextArticleId={nextId}
                onNavigate={handleNavigate}
                selectedEntity={highlightEntity}
                onEntitySelect={setHighlightEntity}
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
                {advMode ? (
                  <>
                    {/* 高级搜索面包屑：🏠 = 搜索结果根目录；目录链在结果内筛选 */}
                    <Link to="/articles?adv=1" onClick={() => setAdvCategoryId(null)}>🏠</Link>
                    {advCategoryChain.map((c, i) => (
                      <Fragment key={c.id}>
                        {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
                        {i < advCategoryChain.length - 1 ? (
                          <Link
                            to="/articles?adv=1"
                            onClick={() => setAdvCategoryId(c.id)}
                            style={{ color: c.color }}
                          >
                            {c.name}
                          </Link>
                        ) : (
                          <span className={styles.breadcrumbCurrent} style={{ color: c.color }}>
                            {c.name}
                          </span>
                        )}
                      </Fragment>
                    ))}
                  </>
                ) : !hasFilter ? (
                  /* 浏览根目录 */
                  <span className={styles.breadcrumbCurrent}>🏠</span>
                ) : !categoryId ? (
                  /* 筛选根视图（未选目录）：/ = 基于搜索/标签结果的根目录（当前节点） */
                  <span className={styles.breadcrumbCurrent}>🏠</span>
                ) : (
                  <>
                    {/* 🏠：搜索/标签时为结果根目录，浏览时为根目录 */}
                    <Link
                      to={search
                        ? `/articles?search=${encodeURIComponent(search)}`
                        : tags.length
                          ? `/articles?${tagQs}`
                          : '/articles'}
                    >
                      🏠
                    </Link>
                    {categoryChain.map((c, i) => (
                      <Fragment key={c.id}>
                        {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
                        {i < categoryChain.length - 1 ? (
                          // 上级目录可点击（搜索/标签模式下保留过滤状态）
                          <Link
                            to={search
                              ? `/articles?search=${encodeURIComponent(search)}&category=${c.id}`
                              : tags.length
                                ? `/articles?${tagQs}&category=${c.id}`
                                : `/articles?category=${c.id}`}
                            style={{ color: c.color }}
                          >
                            {c.name}
                          </Link>
                        ) : (
                          <span className={styles.breadcrumbCurrent} style={{ color: c.color }}>
                            {c.name}
                          </span>
                        )}
                      </Fragment>
                    ))}
                  </>
                )}
              </nav>
              <span className={styles.resultCount}>
                {advMode
                  ? `共 ${advTotal} 篇`
                  : isRootView || isResultRootView
                    ? `共 ${sortedDirs.length} 个目录`
                    : selectedArticleIds.size > 0
                      ? `已选 ${selectedArticleIds.size} / ${total ?? displayedArticles.length} 篇`
                      : `共 ${total ?? displayedArticles.length} 篇`}
              </span>
              {/* ── 排序：组合条件（时间 / 标题·目录名 / 创建人，倒序/正序），目录与文章一同排序 ── */}
              <div className={styles.sortWrap} ref={sortWrapRef}>
                <button
                  type="button"
                  className={styles.sortBtn}
                  onClick={toggleSortPanel}
                  title="排序（时间 / 标题·目录名 / 创建人，可组合）"
                >
                  ⇅ 排序{sortCriteria.length > 1 ? `(${sortCriteria.length})` : ''}
                </button>
                {sortOpen && sortPanelPos && createPortal(
                  <div
                    ref={sortPanelRef}
                    className={styles.sortPanel}
                    style={{ top: sortPanelPos.top, left: sortPanelPos.left }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className={styles.sortPanelTitle}>排序（按条件先后优先级）</div>
                    {sortCriteria.map((c, i) => (
                      <div key={c.id} className={styles.sortRow}>
                        <span className={styles.sortIndex}>{i + 1}</span>
                        <select
                          className={styles.sortField}
                          value={c.field}
                          onChange={(e) => updateSortCriterion(c.id, { field: e.target.value as SortField })}
                        >
                          {(Object.keys(SORT_FIELD_LABELS) as SortField[]).map((f) => (
                            <option key={f} value={f}>{SORT_FIELD_LABELS[f]}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.sortOrderBtn}
                          onClick={() => updateSortCriterion(c.id, { order: c.order === 'desc' ? 'asc' : 'desc' })}
                          title="切换倒序/正序"
                        >
                          {c.order === 'desc' ? '↓ 倒序' : '↑ 正序'}
                        </button>
                        <button
                          type="button"
                          className={styles.sortRemoveBtn}
                          onClick={() => removeSortCriterion(c.id)}
                          disabled={sortCriteria.length <= 1}
                          title="删除该排序条件"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div className={styles.sortActions}>
                      <button type="button" className={styles.sortAddBtn} onClick={addSortCriterion}>
                        ＋ 添加排序
                      </button>
                      <button type="button" className={styles.sortResetBtn} onClick={resetSort}>
                        重置
                      </button>
                    </div>
                  </div>,
                  document.body,
                )}
              </div>
              <div className={styles.searchWrap}>
                <span className={styles.searchIcon}>
                  {/* 筛选漏斗图标 */}
                  <svg
                    width="14"
                    height="14"
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
                  ref={searchInputRef}
                  type="text"
                  className={styles.searchInput}
                  placeholder="筛选当前结果…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  autoComplete="off"
                  aria-label="筛选当前结果"
                />
                {filterText && (
                  <button
                    type="button"
                    className={styles.searchClearBtn}
                    onClick={() => setFilterText('')}
                    title="清除筛选"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {advMode && !advCategoryId ? (
              /* ── 高级搜索结果根目录视图：仅展示有匹配的顶级目录（结果根下没有文章）── */
              <div className={styles.rootDirs}>
                {sortedDirs.length === 0 ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>🔍</div>
                    <p>
                      {filterText.trim()
                        ? `无匹配「${filterText.trim()}」的目录`
                        : '没有匹配的文章，试试调整搜索条件'}
                    </p>
                  </div>
                ) : (
                  sortedDirs.map(renderDirCard)
                )}
              </div>
            ) : advMode ? (
              /* ── 高级搜索结果（选中目录内）：目录在上、文章在下，分别排序 ── */
              <>
                {sortedDirs.length > 0 && (
                  <div className={styles.rootDirs}>
                    {sortedDirs.map(renderDirCard)}
                  </div>
                )}
                {advError ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>⚠️</div>
                    <p>搜索失败：{advError}</p>
                  </div>
                ) : advLoading ? (
                  <div className={styles.empty}><p>搜索中…</p></div>
                ) : advArticles.length === 0 && sortedDirs.length === 0 ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>🔍</div>
                    <p>没有匹配的文章，试试调整搜索条件</p>
                  </div>
                ) : (
                  renderArticleList()
                )}
              </>
            ) : isRootView ? (
              /* ── 根目录视图：/ = 根目录，仅展示顶级目录卡片（根目录下没有文章，文章都在目录中）── */
              <div className={styles.rootDirs}>
                {!categories.some((c) => !c.parent_id) ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>📁</div>
                    <p>还没有目录，请在侧边栏「新增目录」创建</p>
                  </div>
                ) : sortedDirs.length === 0 ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>🔍</div>
                    <p>无匹配「{filterText.trim()}」的目录</p>
                  </div>
                ) : (
                  sortedDirs.map(renderDirCard)
                )}
              </div>
            ) : isResultRootView ? (
              /* ── 搜索/标签结果根目录视图：仅展示有匹配的顶级目录（结果根下没有文章）── */
              <div className={styles.rootDirs}>
                {sortedDirs.length === 0 ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>🔍</div>
                    <p>
                      {filterText.trim()
                        ? `无匹配「${filterText.trim()}」的目录`
                        : '没有匹配的文章，试试其他关键词'}
                    </p>
                  </div>
                ) : (
                  sortedDirs.map(renderDirCard)
                )}
              </div>
            ) : (
              /* ── 目录在上、文章在下，分别排序（选中目录视图：
                 与侧边栏目录树同步，选中目录时列表跟随）── */
              <>
                {sortedDirs.length > 0 && (
                  <div className={styles.rootDirs}>
                    {sortedDirs.map(renderDirCard)}
                  </div>
                )}
                {error ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>⚠️</div>
                    <p>加载失败：{error}</p>
                    <button className={styles.newBtn} onClick={refetch}>重试</button>
                  </div>
                ) : loading ? (
                  <div className={styles.empty}><p>加载中…</p></div>
                ) : articles.length === 0 && dirChips.length === 0 ? (
                  <div className={styles.empty}>
                    <div className={styles.emptyIcon}>📭</div>
                    <p>
                      {search || tags.length
                        ? '没有匹配的文章，试试其他关键词'
                        : categoryId
                          ? '这个目录下还没有文章'
                          : '还没有文章'}
                    </p>
                    {!search && tags.length === 0 && (
                      <button className={styles.newBtn} onClick={() => openEditor(null)}>
                        + 写一篇文章
                      </button>
                    )}
                  </div>
                ) : (
                  renderArticleList()
                )}
              </>
            )}
          </>
        )}
      </div>

      <EntityPanel
        entities={llmEntityList}
        selectedArticleIds={selectedArticleIdsArray}
        articles={articles}
        mode={entityPanelMode}
        onRefresh={refetch}
        onGraphNodeClick={handleGraphNodeClick}
        selectedGraphNodeIds={selectedGraphNodeIds}
        onEntitySelect={handleEntitySelect}
      />
    </div>
  );
}
