import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Category } from '../types/category';
import type { Article } from '../types/article';
import { api } from '../api/client';
import styles from './PositionPicker.module.css';

/** 文章位置：categoryId 必选；parentId 为空 = 顶级（直接挂在目录下）。 */
export interface Position {
  categoryId: string;
  parentId: string | null;
}

/** 分批载入大小：展开子文章 / 标题筛选每次最多载入条数。 */
const BATCH_SIZE = 10;

/** 位置选择结果文案：完整路径 = 目录链（祖先 / … / 本目录）/ 祖先文章… / 父文章。 */
export function buildPositionText(position: Position, categories: Category[], articles: Article[]): string {
  if (!position.categoryId) return '';
  // 目录链：从本目录向上追溯到顶级目录（嵌套子目录场景显示完整路径）
  const catById = new Map(categories.map((c) => [c.id, c]));
  const catChain: string[] = [];
  const seenC = new Set<string>();
  let cc: Category | undefined = catById.get(position.categoryId);
  while (cc && !seenC.has(cc.id)) {
    seenC.add(cc.id);
    catChain.unshift(cc.name);
    cc = cc.parent_id ? catById.get(cc.parent_id) : undefined;
  }
  const catPath = catChain.join(' / ');
  if (!position.parentId) return catPath;
  // 父文章链：从父文章向上追溯到顶级文章
  const byId = new Map(articles.map((a) => [a.id, a]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(position.parentId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur.title);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return `${catPath} / ${chain.join(' / ')}`;
}

interface PositionPickerProps {
  categories: Category[];
  /** 全量文章列表：仅用于选中路径文案与初始展开祖先链推导 */
  articles: Article[];
  value: Position;
  /** 不可选的文章 ID（编辑时：自身 + 全部子孙，防挂载成环） */
  excludedArticleIds?: Set<string>;
  onChange: (position: Position) => void;
  /** 下拉层内嵌模式：去掉外框（树区自带滚动） */
  bare?: boolean;
}

const catKey = (catId: string) => `cat:${catId}`;

/**
 * 位置选择器：目录与挂载位置归并为一个「手动分批载入」树。
 * - 展开目录 → 按批载入其顶级文章；展开文章 → 按批载入其子文章；
 * - 每批最多 BATCH_SIZE 条，不足一批即无更多；有更多时显示「加载更多」；
 * - 顶部标题筛选框走后端 title 查询，同样分批 + 加载更多。
 */
export function PositionPicker({
  categories, articles, value, excludedArticleIds, onChange, bare = false,
}: PositionPickerProps) {
  // ── 手动分批载入状态 ──
  // key = `cat:<目录id>`（目录下的顶级文章）或 文章 id（其子文章）
  const [loaded, setLoaded] = useState<Record<string, Article[]>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadBatch = async (key: string, offset: number) => {
    setLoadingKeys((prev) => new Set(prev).add(key));
    try {
      const isCat = key.startsWith('cat:');
      const data = isCat
        ? await api.getArticles({
            category_id: key.slice(4), root_only: true, limit: BATCH_SIZE, skip: offset,
          })
        : await api.getArticles({ parent_id: key, limit: BATCH_SIZE, skip: offset });
      setLoaded((prev) => ({
        ...prev,
        [key]: offset === 0 ? data : [...(prev[key] ?? []), ...data],
      }));
      setHasMore((prev) => ({ ...prev, [key]: data.length >= BATCH_SIZE }));
    } catch {
      // 静默失败：保持已有数据
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const toggle = (key: string) => {
    const willExpand = !expandedIds.has(key);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    // 首次展开且尚未载入过 → 拉取第一批
    if (willExpand && (loaded[key]?.length ?? 0) === 0) loadBatch(key, 0);
  };

  // 初始展开：选中节点的祖先链（含其目录与上级目录链），逐级载入（组件随下拉层按需挂载）
  useEffect(() => {
    const keys = new Set<string>();
    if (value.categoryId) {
      keys.add(catKey(value.categoryId));
      // 上级目录链（子目录嵌套场景）
      const catById = new Map(categories.map((c) => [c.id, c]));
      const seenC = new Set<string>();
      let cc: Category | undefined = catById.get(value.categoryId);
      while (cc && !seenC.has(cc.id)) {
        seenC.add(cc.id);
        if (cc.parent_id) {
          keys.add(catKey(cc.parent_id));
          cc = catById.get(cc.parent_id);
        } else {
          cc = undefined;
        }
      }
    }
    if (value.parentId) {
      const byId = new Map(articles.map((a) => [a.id, a]));
      const seen = new Set<string>();
      let cur = byId.get(value.parentId);
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        keys.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    if (keys.size === 0) return;
    setExpandedIds(keys);
    keys.forEach((k) => loadBatch(k, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 标题筛选（后端 title 查询，分批 + 加载更多）──
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Article[]>([]);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchSeqRef = useRef(0);

  const runSearch = async (q: string, offset: number) => {
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
  };

  const isFiltering = query.trim() !== '';
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      searchSeqRef.current++;
      setSearchResults([]);
      setSearchHasMore(false);
      setSearchLoading(false);
      return;
    }
    runSearch(q, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const renderLoadMore = (key: string, onClick: () => void) =>
    hasMore[key] && (
      <button
        type="button"
        className={styles.loadMoreBtn}
        onClick={onClick}
        disabled={loadingKeys.has(key)}
      >
        {loadingKeys.has(key) ? '加载中…' : `加载更多（已载入 ${loaded[key]?.length ?? 0} 条）`}
      </button>
    );

  const renderArticleRow = (a: Article, depth: number) => {
    const key = a.id;
    const kids = loaded[key] ?? [];
    const isExpanded = expandedIds.has(key);
    const excluded = !!excludedArticleIds?.has(a.id);
    const selected = value.parentId === a.id;
    // 有子文章（children_tree 非空）时图标叠加展开箭头
    const hasKids = a.children_tree.length > 0;
    return (
      <div key={a.id}>
        <div className={styles.nodeRow} style={{ paddingLeft: depth * 18 }}>
          {hasKids ? (
            <button
              type="button"
              className={styles.nodeToggle}
              onClick={() => toggle(key)}
              title={isExpanded ? '收起子文章' : '展开子文章'}
              aria-expanded={isExpanded}
            >
              <span className={styles.iconWrap}>
                <span className={styles.docIcon}>📄</span>
                <span className={`${styles.expandBadge}${isExpanded ? ` ${styles.expandBadgeOpen}` : ''}`}>▸</span>
              </span>
            </button>
          ) : (
            <span className={styles.iconWrap}>
              <span className={styles.docIcon}>📄</span>
            </span>
          )}
          <button
            type="button"
            className={`${styles.node}${selected ? ` ${styles.nodeSelected}` : ''}${excluded ? ` ${styles.nodeDisabled}` : ''}`}
            onClick={() => !excluded && onChange({ categoryId: a.category_id ?? '', parentId: a.id })}
            disabled={excluded}
            title={excluded
              ? '不能挂载到自身或其子文章下'
              : `挂载到「${a.title}」下，成为其子文章`}
          >
            <span className={styles.nodeTitle}>{a.title}</span>
          </button>
        </div>
        {isExpanded && kids.length > 0 && (
          <ul className={styles.tree}>
            {kids.map((k) => (
              <li key={k.id}>{renderArticleRow(k, depth + 1)}</li>
            ))}
          </ul>
        )}
        {isExpanded && hasMore[key] && (
          <div style={{ paddingLeft: (depth + 1) * 18 }}>
            {renderLoadMore(key, () => loadBatch(key, kids.length))}
          </div>
        )}
      </div>
    );
  };

  // ── 目录树（子目录嵌套）──
  const categoryChildren = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const c of categories) {
      if (!c.parent_id) continue;
      map.set(c.parent_id, [...(map.get(c.parent_id) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [categories]);

  const categoryRoots = useMemo(
    () => categories.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  );

  /** 递归渲染目录节点：先子目录（树形），再本目录文章（分批载入）。 */
  const renderCategoryNode = (cat: Category, depth: number): JSX.Element => {
    const key = catKey(cat.id);
    const subCats = categoryChildren.get(cat.id) ?? [];
    const kids = loaded[key] ?? [];
    const isExpanded = expandedIds.has(key);
    const catSelected = value.parentId === null && value.categoryId === cat.id;
    // 有子目录或文章时显示展开按钮
    const chevronVisible = subCats.length > 0
      || kids.length > 0
      || !!hasMore[key]
      || articles.some((x) => x.category_id === cat.id && !x.parent_id);
    return (
      <div key={cat.id} className={styles.categoryBlock}>
        <div className={styles.nodeRow} style={{ paddingLeft: depth * 16 }}>
          {(chevronVisible || isExpanded) ? (
            <button
              type="button"
              className={styles.nodeToggle}
              onClick={() => toggle(key)}
              title={isExpanded ? '收起' : '展开'}
              aria-expanded={isExpanded}
            >
              <span className={styles.folderWrap}>
                <span className={styles.folderIcon}>{isExpanded ? '📂' : '📁'}</span>
                <span className={styles.folderDot} style={{ background: cat.color }} />
              </span>
            </button>
          ) : (
            <span className={styles.folderDim}>
              <span className={styles.folderWrap}>
                <span className={styles.folderIcon}>📁</span>
                <span className={styles.folderDot} style={{ background: cat.color }} />
              </span>
            </span>
          )}
          <button
            type="button"
            className={`${styles.node} ${styles.categoryNode}${catSelected ? ` ${styles.nodeSelected}` : ''}`}
            onClick={() => onChange({ categoryId: cat.id, parentId: null })}
            title={`作为顶级文章挂在目录「${cat.name}」下`}
          >
            <span className={styles.nodeTitle}>{cat.name}</span>
          </button>
        </div>
        {isExpanded && (
          <>
            {subCats.length > 0 && (
              <div className={styles.subCatList}>
                {subCats.map((k) => renderCategoryNode(k, depth + 1))}
              </div>
            )}
            {kids.length > 0 && (
              <ul className={styles.tree}>
                {kids.map((k) => (
                  <li key={k.id}>{renderArticleRow(k, depth + 1)}</li>
                ))}
              </ul>
            )}
            {kids.length === 0 && subCats.length === 0 && loadingKeys.has(key) && (
              <div className={styles.empty}>加载中…</div>
            )}
            {kids.length === 0 && subCats.length === 0 && !loadingKeys.has(key) && (
              <div className={styles.empty}>暂无文章</div>
            )}
            {hasMore[key] && (
              <div style={{ paddingLeft: (depth + 1) * 16 }}>
                {renderLoadMore(key, () => loadBatch(key, kids.length))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={`${styles.picker}${bare ? ` ${styles.pickerBare}` : ''}`}>
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="筛选文章标题…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => setQuery('')}
            title="清除筛选"
          >
            ✕
          </button>
        )}
      </div>
      <div className={styles.scroll}>
        {isFiltering ? (
          <>
            {searchResults.map((a) => {
              const excluded = !!excludedArticleIds?.has(a.id);
              const selected = value.parentId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`${styles.node}${selected ? ` ${styles.nodeSelected}` : ''}${excluded ? ` ${styles.nodeDisabled}` : ''}`}
                  onClick={() => !excluded && onChange({ categoryId: a.category_id ?? '', parentId: a.id })}
                  disabled={excluded}
                  title={`挂载到「${a.title}」下，成为其子文章`}
                >
                  <span className={styles.nodeIcon}>📄</span>
                  <span className={styles.nodeTitle}>{a.title}</span>
                  {a.category && (
                    <span className={styles.resultCat} style={{ color: a.category.color }}>
                      {a.category.name}
                    </span>
                  )}
                </button>
              );
            })}
            {searchResults.length === 0 && !searchLoading && (
              <div className={styles.empty}>无匹配文章</div>
            )}
            {searchLoading && searchResults.length === 0 && (
              <div className={styles.empty}>搜索中…</div>
            )}
            {searchHasMore && (
              <button
                type="button"
                className={styles.loadMoreBtn}
                onClick={() => runSearch(query.trim(), searchResults.length)}
                disabled={searchLoading}
              >
                {searchLoading ? '加载中…' : `加载更多（已载入 ${searchResults.length} 条）`}
              </button>
            )}
          </>
        ) : (
          categoryRoots.map((cat) => renderCategoryNode(cat, 0))
        )}
      </div>
    </div>
  );
}

interface PositionFieldProps {
  categories: Category[];
  articles: Article[];
  value: Position;
  /** 不可选的文章 ID（编辑时：自身 + 全部子孙，防挂载成环） */
  excludedArticleIds?: Set<string>;
  onChange: (position: Position) => void;
  /** 打开下拉层时回调（用于动态加载最新数据） */
  onOpen?: () => void;
}

/**
 * 文章位置字段（编辑器 / 上传弹窗共用）：
 * 一行展示选择结果 + 「选择」按钮，点击展开锚定下拉层（portal 渲染）。
 */
export function PositionField({
  categories, articles, value, excludedArticleIds, onChange, onOpen,
}: PositionFieldProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  const openDropdown = () => {
    onOpen?.();
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) setDropdownStyle({ top: rect.bottom - 1, left: rect.left, width: rect.width });
    setOpen(true);
  };

  // 打开期间：容器滚动/窗口缩放时跟随重定位
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (rect) setDropdownStyle({ top: rect.bottom - 1, left: rect.left, width: rect.width });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rowRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const text = buildPositionText(value, categories, articles);
  // 选中父文章时明确提示：新建/上传后将成为其子文章
  const parentArticle = value.parentId
    ? articles.find((a) => a.id === value.parentId) ?? null
    : null;

  // 点击/键盘切换下拉（整个字段区域即触发器，不设专门「选择」按钮）
  const toggleDropdown = () => (open ? setOpen(false) : openDropdown());

  return (
    <>
      <div className={styles.positionField}>
        <div
          className={`${styles.positionRow}${open ? ` ${styles.positionRowOpen}` : ''}`}
          ref={rowRef}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggleDropdown}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleDropdown();
            }
          }}
          title="点击选择文章位置"
        >
          <span className={styles.positionValue} title={text || undefined}>
            {text || <span className={styles.positionPlaceholder}>请选择文章所属的目录或父文章</span>}
          </span>
          <span className={styles.positionArrow}>{open ? '▴' : '▾'}</span>
        </div>
        {parentArticle && (
          <div className={styles.positionHint} role="status">
            ℹ️ 父文章：<strong>{parentArticle.title}</strong>，将作为其子文章
          </div>
        )}
      </div>

      {open && dropdownStyle && createPortal(
        <div ref={dropdownRef} className={styles.positionDropdown} style={dropdownStyle}>
          <PositionPicker
            categories={categories}
            articles={articles}
            value={value}
            excludedArticleIds={excludedArticleIds}
            onChange={(pos) => {
              onChange(pos);
              setOpen(false);
            }}
            bare
          />
        </div>,
        document.body,
      )}
    </>
  );
}
