import { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGraphData } from '../hooks/useGraphData';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import { useD3ForceGraph } from '../hooks/useD3ForceGraph';
import styles from './KnowledgeGraph.module.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function KnowledgeGraph() {
  const { data: graphData, loading: graphLoading, error: graphError } = useGraphData();
  const { categories } = useCategories();
  const { sidebarOpen, closeSidebar } = useApp();
  const navigate = useNavigate();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(new Set());

  const { articles, loading: articlesLoading } = useArticles(
    selectedCategoryId ? { category_id: selectedCategoryId } : undefined
  );

  // Entity name → type map for graph icons
  const entityTypeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of articles) {
      for (const e of a.entities?.entities ?? []) {
        if (!m.has(e.name)) m.set(e.name, e.type);
      }
    }
    return m;
  }, [articles]);

  // ── Filtered graph data ──
  const filteredGraph = useMemo(() => {
    if (!graphData) return null;
    const activeArticleIds =
      selectedArticleIds.size > 0
        ? selectedArticleIds
        : new Set(articles.map((a) => a.id));
    if (activeArticleIds.size === 0) return { nodes: [], edges: [] };

    const prefixedIds = new Set(Array.from(activeArticleIds).map((id) => `article:${id}`));
    const visibleNodeIds = new Set<string>(prefixedIds);
    const nodeTypeMap = new Map(graphData.nodes.map((n) => [n.id, n.type]));

    for (const edge of graphData.edges) {
      const st = nodeTypeMap.get(edge.source);
      const tt = nodeTypeMap.get(edge.target);
      if (st === 'article' && prefixedIds.has(edge.source)) {
        if (tt === 'category' || tt === 'entity') visibleNodeIds.add(edge.target);
        if (tt === 'article') visibleNodeIds.add(edge.target);
      }
      if (tt === 'article' && prefixedIds.has(edge.target)) {
        if (st === 'category' || st === 'entity') visibleNodeIds.add(edge.source);
        if (st === 'article') visibleNodeIds.add(edge.source);
      }
    }
    return {
      nodes: graphData.nodes.filter((n) => visibleNodeIds.has(n.id)),
      edges: graphData.edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)),
    };
  }, [graphData, selectedArticleIds, articles]);

  // Article selection
  const handleArticleToggle = useCallback((id: string, ctrl: boolean) => {
    setSelectedArticleIds((prev) => {
      const next = new Set(prev);
      if (ctrl) { if (next.has(id)) next.delete(id); else next.add(id); }
      else { if (next.has(id)) next.delete(id); else { next.clear(); next.add(id); } }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (!articles) return;
    setSelectedArticleIds(new Set(articles.map((a) => a.id)));
  }, [articles]);

  // ── D3 graph via shared hook ──
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleNodeClick = useCallback(
    (_id: string, _type: string, _label: string, _ctrl: boolean) => {
      // KnowledgeGraph: click navigates to the node's URL
      const node = filteredGraph?.nodes.find((n) => n.id === _id);
      if (node) navigate(node.url);
    },
    [filteredGraph, navigate],
  );

  useD3ForceGraph(containerRef, svgRef, tooltipRef, 'css', {
    graph: filteredGraph,
    entityTypeMap,
    onNodeClick: handleNodeClick,
    showArrows: false,
    initialScale: 0.7,
  });

  // ── Stats ──
  const stats = useMemo(() => {
    if (!filteredGraph) return null;
    return {
      articles: filteredGraph.nodes.filter((n) => n.type === 'article').length,
      categories: filteredGraph.nodes.filter((n) => n.type === 'category').length,
      edges: filteredGraph.edges.length,
    };
  }, [filteredGraph]);

  if (graphLoading) return <div className={styles.loading}>加载图谱数据…</div>;
  if (graphError) return <div className={styles.loading}>加载失败: {graphError}</div>;

  return (
    <div className={styles.wrap}>
      {sidebarOpen && <div className={styles.overlay} onClick={closeSidebar} />}

      {/* ── Left: Categories ── */}
      <aside className={`${styles.leftCol} ${sidebarOpen ? styles.leftColOpen : ''}`}>
        <div className={styles.colHeader}>分类</div>
        <div className={styles.catList}>
          <button
            className={`${styles.catItem} ${!selectedCategoryId ? styles.catActive : ''}`}
            onClick={() => { setSelectedCategoryId(null); closeSidebar(); }}
          >
            <span className={styles.catDot} style={{ background: 'var(--c-text-muted)' }} /> 全部
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`${styles.catItem} ${selectedCategoryId === cat.id ? styles.catActive : ''}`}
              onClick={() => { setSelectedCategoryId(cat.id); closeSidebar(); }}
            >
              <span className={styles.catDot} style={{ background: cat.color }} /> {cat.name}
            </button>
          ))}
        </div>
      </aside>

      {/* ── Middle: Article list ── */}
      <div className={styles.midCol}>
        <div className={styles.colHeader}>
          <span>文章</span>
          <span className={styles.colCount}>
            {selectedArticleIds.size > 0
              ? `已选 ${selectedArticleIds.size}/${articles.length}`
              : `${articles.length} 篇`}
          </span>
        </div>
        <div className={styles.selectBar}>
          <button className={styles.selectBtn} onClick={handleSelectAll}>全选</button>
          <button className={styles.selectBtn} onClick={() => setSelectedArticleIds(new Set())}>取消</button>
        </div>
        <div className={styles.articleList}>
          {articlesLoading ? (
            <div className={styles.listLoading}>加载中…</div>
          ) : articles.length === 0 ? (
            <div className={styles.listEmpty}>暂无文章</div>
          ) : (
            articles.map((article) => (
              <div
                key={article.id}
                className={`${styles.articleItem} ${selectedArticleIds.has(article.id) ? styles.articleSelected : ''}`}
                onClick={(e) => handleArticleToggle(article.id, e.ctrlKey || e.metaKey)}
              >
                <span
                  className={styles.checkDot}
                  style={{
                    background: selectedArticleIds.has(article.id) ? 'var(--c-accent)' : 'transparent',
                    borderColor: selectedArticleIds.has(article.id) ? 'var(--c-accent)' : 'var(--c-border)',
                  }}
                />
                <div className={styles.articleInfo}>
                  <div className={styles.articleTitle}>{article.title}</div>
                  <div className={styles.articleMeta}>
                    {article.category && (
                      <span style={{ color: article.category.color }}>{article.category.name}</span>
                    )}
                    <span>{formatDate(article.updated_at)}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right: Graph ── */}
      <div className={styles.rightCol}>
        <div className={styles.colHeader}>
          <span>知识图谱</span>
          {stats && (
            <span className={styles.colCount}>
              {stats.articles}文 · {stats.categories}类 · {stats.edges}关联
            </span>
          )}
        </div>
        <div className={styles.legend}>
          <div className={styles.legendItem}><div className={styles.legendDot} style={{ background: '#1E5C8A', borderRadius: 3 }} /> 文章</div>
          <div className={styles.legendItem}><div className={styles.legendDot} style={{ background: '#3D7B4F' }} /> 分类</div>
          <div className={styles.legendItem}><div className={styles.legendDot} style={{ background: '#E8DEF8', border: '1.5px solid #8B6BAE' }} /> 实体</div>
        </div>
        <div className={styles.container} ref={containerRef}>
          <svg ref={svgRef} className={styles.svg} />
          <div ref={tooltipRef} className={styles.tooltip} />
        </div>
      </div>
    </div>
  );
}
