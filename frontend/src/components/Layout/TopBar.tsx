import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../../context/AppProvider';
import { useToast } from '../../hooks/useToast';
import { api } from '../../api/client';
import type { AdvancedSearchCondition } from '../../api/client';
import type { Article } from '../../types/article';
import styles from './TopBar.module.css';

const SEARCH_LIMIT = 15;

/** 高级搜索条件行（关键词 / 人员 / 时间范围，与或非组合） */
interface AdvRow {
  id: number;
  type: 'keyword' | 'person' | 'time';
  value: string;
  start: string;
  end: string;
  connector: 'and' | 'or';
  negated: boolean;
}

let advRowId = 1;
const makeAdvRow = (): AdvRow => ({
  id: advRowId++, type: 'keyword', value: '', start: '', end: '', connector: 'and', negated: false,
});

function advRowValid(row: AdvRow): boolean {
  if (row.type === 'time') return Boolean(row.start || row.end);
  return row.value.trim() !== '';
}

function advRowToCondition(row: AdvRow): AdvancedSearchCondition {
  const cond: AdvancedSearchCondition = { type: row.type, connector: row.connector, negated: row.negated };
  if (row.type === 'time') {
    cond.start = row.start || null;
    cond.end = row.end || null;
  } else {
    cond.value = row.value.trim();
  }
  return cond;
}

const ADV_PLACEHOLDERS: Record<AdvRow['type'], string> = {
  keyword: '标题/正文包含…',
  person: '创建人姓名或工号…',
  time: '',
};

export function TopBar() {
  const {
    toggleSidebar, toggleSidebarCollapsed, sidebarCollapsed,
    qaOpen, setQaOpen,
    entityPanelMode, setEntityPanelMode,
    advancedSearch, setAdvancedSearch, setAdvCategoryId,
    userName, userIdNumber,
  } = useApp();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  // 标签累加筛选：可同时激活多个标签（?tag=A&tag=B）
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [results, setResults] = useState<Article[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // ── 高级搜索（与搜索框融合：面板从搜索框下方弹出）──
  const [advOpen, setAdvOpen] = useState(false);
  const [advRows, setAdvRows] = useState<AdvRow[]>([]);
  // 高级搜索条件已设置 → 图标醒目标识 + 普通搜索禁用（直到清除）
  const advActive = Boolean(advancedSearch);

  // 与 URL ?search= / ?tag= 同步（仅文章窗口回显；问答等窗口保留原内容，禁用不清除）
  useEffect(() => {
    if (location.pathname !== '/articles') return;
    const params = new URLSearchParams(location.search);
    setQuery(params.get('search') ?? '');
    setActiveTags(params.getAll('tag'));
  }, [location]);

  // 智能问答按钮的切换高亮：问答面板开启或处于问答窗口时激活
  const isQa = location.pathname === '/qa';
  const qaActive = qaOpen || isQa;

  // 进入问答窗口：收起搜索下拉（输入框禁用后下拉不再有意义）
  useEffect(() => {
    if (isQa) {
      setOpen(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, [isQa]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // 数据库即时搜索：防抖后直接查后端（title+content），结果下拉展示
  const runSearch = async (q: string) => {
    const seq = ++seqRef.current;
    setSearching(true);
    try {
      const data = await api.getArticles({ search: q, limit: SEARCH_LIMIT });
      if (seq !== seqRef.current) return; // 过期请求丢弃
      setResults(data);
      setOpen(true);
    } catch {
      // 静默失败
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  };

  const handleChange = (value: string) => {
    setQuery(value);
    if (advOpen) setAdvOpen(false);  // 输入关键词时收起高级搜索面板
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = value.trim();
    if (!q) {
      seqRef.current++;
      setResults([]);
      setSearching(false);
      setOpen(false);
      // 清空搜索：在文章页时退出搜索结果视图
      if (location.pathname === '/articles') {
        navigate('/articles', { replace: true });
      }
      return;
    }
    // 数据库即时搜索：仅更新下拉结果，不写 URL（与侧边栏筛选解耦；
    // Enter / 查看全部结果时才进入完整搜索页）
    timerRef.current = setTimeout(() => runSearch(q), 300);
  };

  // Enter = 查看全部结果（完整列表页）；Esc = 关闭下拉
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (timerRef.current) clearTimeout(timerRef.current);
      const q = query.trim();
      setOpen(false);
      navigate(q ? `/articles?search=${encodeURIComponent(q)}` : '/articles');
    } else if (e.key === 'Escape') {
      setOpen(false);
      setAdvOpen(false);
    }
  };

  // 点击外部关闭下拉 / 高级搜索面板
  useEffect(() => {
    if (!open && !advOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdvOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, advOpen]);

  const goFullResults = () => {
    setOpen(false);
    navigate(`/articles?search=${encodeURIComponent(query.trim())}`);
  };

  // ── 高级搜索：面板开关与提交 ──
  const toggleAdv = () => {
    setAdvOpen((p) => !p);
    setOpen(false);  // 与结果下拉互斥
  };

  const updateAdvRow = (id: number, patch: Partial<AdvRow>) => {
    setAdvRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleAdvSearch = () => {
    const valid = advRows.filter(advRowValid);
    if (valid.length === 0) {
      showToast('请至少填写一个搜索条件', 'error');
      return;
    }
    setAdvancedSearch(valid.map(advRowToCondition));
    setAdvCategoryId(null);
    setAdvOpen(false);
    navigate('/articles?adv=1');
  };

  const clearAdvSearch = () => {
    setAdvancedSearch(null);
    setAdvCategoryId(null);
    setAdvOpen(false);
    navigate('/articles');
  };

  // ── 知识图谱切换（原实体面板内的「切换为图谱视图」按钮上移至顶部）──
  // 图谱视图显示在文章窗口右侧的实体面板中：非文章窗口时先跳转，保证切换立即可见
  const toggleEntityGraph = () => {
    if (entityPanelMode === 'graph') {
      setEntityPanelMode('list');
    } else {
      setEntityPanelMode('graph');
      if (location.pathname !== '/articles') navigate('/articles');
    }
  };

  return (
    <div className={styles.topbar}>
      <div className={styles.left}>
        <button
          className={styles.menuBtn}
          onClick={() => {
            // 桌面端缩进/展开侧边栏；移动端开关抽屉
            if (window.matchMedia('(max-width: 768px)').matches) toggleSidebar();
            else toggleSidebarCollapsed();
          }}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '缩进侧边栏'}
          title={sidebarCollapsed ? '展开侧边栏' : '缩进侧边栏'}
        >
          ☰
        </button>
        {/* 系统图标：纯展示，无任何功能 */}
        <div className={styles.brand}>
          <span className={styles.logo}>K</span>
          <span className={styles.brandName}>知识库</span>
        </div>
      </div>

      {/* ── 数据库即时搜索：靠左排列；Enter 查看全部 ── */}
      <div className={styles.searchWrap} ref={wrapRef}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder={advActive ? '高级搜索已启用' : '搜索文章…'}
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            disabled={isQa || advActive}
            aria-label="搜索知识库"
          />
          {/* 最右侧清除按钮：高级搜索激活时重置高级+普通搜索，否则清除普通搜索 */}
          {(query || advActive) && !isQa && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => {
                if (advActive) clearAdvSearch();
                else handleChange('');
              }}
              title={advActive ? '清除高级搜索与普通搜索' : '清除搜索'}
            >
              ✕
            </button>
          )}

          {/* 高级搜索开关（与搜索框融合，面板从下方弹出）：
              条件已设置时醒目标识（accent 底色） */}
          <button
            type="button"
            className={`${styles.advToggle} ${advOpen && !advActive ? styles.advToggleOpen : ''} ${advActive ? styles.advToggleActive : ''}`}
            onClick={toggleAdv}
            disabled={isQa}
            title="高级搜索（时间范围 / 人员 / 关键词，与或非组合）"
            aria-expanded={advOpen}
            aria-label="高级搜索"
          >
            ⚙️
          </button>

          {advOpen && (
            <div className={styles.advPanel} onClick={(e) => e.stopPropagation()}>
              <div className={styles.advPanelTitle}>
                <span>高级搜索</span>
                {advancedSearch && (
                  <button type="button" className={styles.advClearLink} onClick={clearAdvSearch}>
                    清除高级搜索
                  </button>
                )}
              </div>

              {advRows.length === 0 && (
                <div className={styles.advEmpty}>还没有条件，点击「＋ 添加条件」开始</div>
              )}

              {advRows.map((row, i) => (
                <div key={row.id} className={styles.advRow}>
                  <div className={styles.advRowTop}>
                    {i > 0 ? (
                      <select
                        className={styles.advConnector}
                        value={row.connector}
                        onChange={(e) => updateAdvRow(row.id, { connector: e.target.value as 'and' | 'or' })}
                        title="与上一条的关系"
                      >
                        <option value="and">与</option>
                        <option value="or">或</option>
                      </select>
                    ) : (
                      <span className={styles.advConnectorGhost} />
                    )}
                    <label className={styles.advNegate}>
                      <input
                        type="checkbox"
                        checked={row.negated}
                        onChange={(e) => updateAdvRow(row.id, { negated: e.target.checked })}
                      />
                      非
                    </label>
                    <select
                      className={styles.advField}
                      value={row.type}
                      onChange={(e) => updateAdvRow(row.id, { type: e.target.value as AdvRow['type'] })}
                    >
                      <option value="keyword">关键词</option>
                      <option value="person">人员</option>
                      <option value="time">时间范围</option>
                    </select>
                    <button
                      type="button"
                      className={styles.advRemove}
                      onClick={() => setAdvRows((prev) => prev.filter((r) => r.id !== row.id))}
                      title="删除该条件"
                    >
                      ✕
                    </button>
                  </div>
                  {row.type === 'time' ? (
                    <div className={styles.advTimeRow}>
                      <input
                        type="date"
                        className={styles.advDate}
                        value={row.start}
                        onChange={(e) => updateAdvRow(row.id, { start: e.target.value })}
                        aria-label="开始日期"
                      />
                      <span className={styles.advTimeSep}>至</span>
                      <input
                        type="date"
                        className={styles.advDate}
                        value={row.end}
                        onChange={(e) => updateAdvRow(row.id, { end: e.target.value })}
                        aria-label="结束日期"
                      />
                    </div>
                  ) : (
                    <input
                      type="text"
                      className={styles.advValue}
                      value={row.value}
                      onChange={(e) => updateAdvRow(row.id, { value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAdvSearch();
                      }}
                      placeholder={ADV_PLACEHOLDERS[row.type]}
                    />
                  )}
                </div>
              ))}

              <div className={styles.advActions}>
                <button
                  type="button"
                  className={styles.advAddBtn}
                  onClick={() => setAdvRows((prev) => [...prev, makeAdvRow()])}
                >
                  ＋ 添加条件
                </button>
                <button type="button" className={styles.advSearchBtn} onClick={handleAdvSearch}>
                  搜索
                </button>
              </div>
            </div>
          )}

          {open && query.trim() && (
            <div className={styles.searchDropdown}>
              {searching && results.length === 0 ? (
                <div className={styles.searchHint}>搜索中…</div>
              ) : results.length === 0 ? (
                <div className={styles.searchHint}>无匹配文章</div>
              ) : (
                <>
                  {results.map((a) => (
                    <NavLink
                      key={a.id}
                      to={`/articles?search=${encodeURIComponent(query.trim())}&view=${a.id}`}
                      className={styles.searchResultItem}
                      onClick={() => setOpen(false)}
                    >
                      <span className={styles.searchResultTitle}>📄 {a.title}</span>
                      {a.category && (
                        <span className={styles.searchResultCat} style={{ color: a.category.color }}>
                          {a.category.name}
                        </span>
                      )}
                    </NavLink>
                  ))}
                  <button type="button" className={styles.searchMoreBtn} onClick={goFullResults}>
                    查看全部结果（Enter）
                  </button>
                </>
              )}
            </div>
          )}
      </div>

      {/* ── 标签累加筛选 chips：点击文章标签逐个累加；✕ 移除单个标签 ── */}
      {activeTags.length > 0 && location.pathname === '/articles' && (
        <div className={styles.tagChips}>
          {activeTags.map((t) => (
            <div key={t} className={styles.tagChip} title={`标签筛选：「${t}」`}>
              <span className={styles.tagChipIcon}>🏷</span>
              <span className={styles.tagChipName}>{t}</span>
              <button
                type="button"
                className={styles.tagChipClose}
                onClick={() => {
                  const rest = activeTags.filter((x) => x !== t);
                  navigate(rest.length
                    ? `/articles?${rest.map((x) => `tag=${encodeURIComponent(x)}`).join('&')}`
                    : '/articles');
                }}
                title={`移除标签「${t}」筛选`}
                aria-label={`移除标签「${t}」筛选`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.right}>
        {/* 知识图谱按钮：切换实体面板 列表⇄图谱 视图（原实体面板内切换按钮上移至此） */}
        <button
          type="button"
          className={`${styles.toolBtn} ${entityPanelMode === 'graph' ? styles.toolBtnActive : ''}`}
          onClick={toggleEntityGraph}
          title={entityPanelMode === 'graph' ? '切换为列表视图' : '切换为图谱视图（实体面板显示知识图谱）'}
          aria-label="切换知识图谱视图"
        >
          🕸️ <span className={styles.toolLabel}>知识图谱</span>
        </button>
        {/* 智能问答按钮：开关最右侧问答面板（与文章/实体窗口并排） */}
        <button
          type="button"
          className={`${styles.toolBtn} ${qaActive ? styles.toolBtnActive : ''}`}
          onClick={() => setQaOpen(!qaOpen)}
          title={qaOpen ? '关闭智能问答面板' : '打开智能问答面板（最右侧并排显示）'}
          aria-label="切换智能问答面板"
        >
          🤖 <span className={styles.toolLabel}>智能问答</span>
        </button>
        {userName && (
          <span className={styles.userInfo} title={userIdNumber || undefined}>
            👤 {userName}
          </span>
        )}
      </div>
    </div>
  );
}
