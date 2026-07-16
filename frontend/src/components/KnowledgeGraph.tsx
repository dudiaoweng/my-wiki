import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import * as d3 from 'd3';
import { useGraphData } from '../hooks/useGraphData';
import { useArticles } from '../hooks/useArticles';
import { useCategories } from '../hooks/useCategories';
import { useApp } from '../context/AppProvider';
import styles from './KnowledgeGraph.module.css';

// Extended types for D3 simulation
interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  url: string;
  color: string | null;
  r?: number;
}

interface SimEdge extends d3.SimulationLinkDatum<SimNode> {
  label: string;
}

const NODE_RADIUS: Record<string, number> = {
  article: 22,
  category: 18,
  entity: 14,
};

const ENTITY_ICONS_KG: Record<string, string> = {
  person: '👤', people: '👤',
  organization: '🏢', org: '🏢', company: '🏢',
  location: '📍', place: '📍',
  event: '📅',
  product: '📦',
};
function kgEntityIcon(t: string | undefined): string {
  if (!t) return '◆';
  return ENTITY_ICONS_KG[t.toLowerCase()] ?? '◆';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function KnowledgeGraph() {
  const { data: graphData, loading: graphLoading, error: graphError } = useGraphData();
  const { categories } = useCategories();
  const { sidebarOpen, closeSidebar } = useApp();
  const navigate = useNavigate();

  // ── Selection state ──
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedArticleIds, setSelectedArticleIds] = useState<Set<string>>(new Set());

  // ── Fetch articles filtered by category ──
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

    // Use selected articles if any, otherwise use currently visible articles
    const activeArticleIds =
      selectedArticleIds.size > 0
        ? selectedArticleIds
        : new Set(articles.map((a) => a.id));

    if (activeArticleIds.size === 0) {
      // No articles at all — show empty graph
      return { nodes: [], edges: [] };
    }

    // Graph node IDs use prefixes: article:{id}, category:{id}, tag:{name}
    const prefixedIds = new Set(
      Array.from(activeArticleIds).map((id) => `article:${id}`)
    );

    // Collect all node IDs connected to selected articles
    const visibleNodeIds = new Set<string>(prefixedIds);

    // Build a quick lookup: nodeId → type
    const nodeTypeMap = new Map(graphData.nodes.map((n) => [n.id, n.type]));

    // Add connected category/tag nodes
    for (const edge of graphData.edges) {
      const sourceType = nodeTypeMap.get(edge.source);
      const targetType = nodeTypeMap.get(edge.target);

      if (sourceType === 'article' && prefixedIds.has(edge.source)) {
        // Selected article → connected category/tag
        if (targetType === 'category' || targetType === 'entity') {
          visibleNodeIds.add(edge.target);
        }
        // Selected article → connected article (keep both)
        if (targetType === 'article') {
          visibleNodeIds.add(edge.target);
        }
      }
      if (targetType === 'article' && prefixedIds.has(edge.target)) {
        if (sourceType === 'category' || sourceType === 'entity') {
          visibleNodeIds.add(edge.source);
        }
        if (sourceType === 'article') {
          visibleNodeIds.add(edge.source);
        }
      }
    }

    const nodes = graphData.nodes.filter((n) => visibleNodeIds.has(n.id));
    const edges = graphData.edges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );

    return { nodes, edges };
  }, [graphData, selectedArticleIds, articles]);

  // ── Article selection handlers ──
  const handleArticleToggle = useCallback((id: string, ctrl: boolean) => {
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

  const handleSelectAll = useCallback(() => {
    if (!articles) return;
    setSelectedArticleIds(new Set(articles.map((a) => a.id)));
  }, [articles]);

  const handleDeselectAll = useCallback(() => {
    setSelectedArticleIds(new Set());
  }, []);

  // ── D3 graph ──
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const showTooltip = useCallback((html: string, x: number, y: number) => {
    const el = tooltipRef.current;
    if (!el) return;
    el.innerHTML = html;
    el.className = `${styles.tooltip} ${styles.visible}`;
    el.style.left = `${x + 12}px`;
    el.style.top = `${y - 30}px`;
  }, []);

  const hideTooltip = useCallback(() => {
    const el = tooltipRef.current;
    if (!el) return;
    el.className = styles.tooltip;
  }, []);

  useEffect(() => {
    if (!filteredGraph || !svgRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return;

    const nodes: SimNode[] = filteredGraph.nodes.map((n) => ({
      ...n,
      r: NODE_RADIUS[n.type] ?? 12,
    }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const edges: SimEdge[] = filteredGraph.edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        label: e.label,
      }));

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(120),
      )
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius((d) => (d.r ?? 12) + 8));

    const g = svg.append('g');
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
      });
    svg.call(zoom);

    // Edges
    const linkGroup = g
      .append('g')
      .attr('class', 'edges')
      .selectAll('g')
      .data(edges)
      .join('g');

    linkGroup
      .append('line')
      .attr('stroke', 'var(--c-border)')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.7);

    linkGroup
      .append('text')
      .text((d) => d.label)
      .attr('font-size', 9)
      .attr('fill', 'var(--c-text-muted)')
      .attr('text-anchor', 'middle')
      .attr('dy', -4);

    // Nodes
    const nodeGroup: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g') as any;

    nodeGroup.attr('cursor', 'pointer');

    const dragBehavior = d3.drag<SVGGElement, SimNode>()
      .on('start', (_event, d: SimNode) => {
        if (!_event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d: SimNode) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (_event, d: SimNode) => {
        if (!_event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeGroup.call(dragBehavior as any);

    nodeGroup
      .on('mouseenter', function (event, d) {
        const typeLabels: Record<string, string> = { article: '文章', category: '分类', entity: '实体' };
        const rect = container.getBoundingClientRect();
        showTooltip(
          `<strong>${typeLabels[d.type] ?? d.type}</strong><br>${d.label}`,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        d3.select(this).select('rect,circle').attr('filter', 'brightness(1.15)');
      })
      .on('mouseleave', function () {
        hideTooltip();
        d3.select(this).select('rect,circle').attr('filter', null);
      })
      .on('click', (_event, d) => {
        navigate(d.url);
      });

    // Article nodes: rounded rects
    nodeGroup
      .filter((d) => d.type === 'article')
      .append('rect')
      .attr('width', 140)
      .attr('height', 32)
      .attr('x', -70)
      .attr('y', -16)
      .attr('rx', 8)
      .attr('ry', 8)
      .attr('fill', (d) => d.color ?? '#1E5C8A')
      .attr('stroke', 'white')
      .attr('stroke-width', 2)
      .attr('opacity', 0.92);

    nodeGroup
      .filter((d) => d.type === 'article')
      .append('text')
      .text((d) => d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', 5)
      .attr('fill', 'white')
      .attr('font-size', 11)
      .attr('font-family', 'var(--font-body)')
      .attr('font-weight', 500);

    // Category nodes: circles
    nodeGroup
      .filter((d) => d.type === 'category')
      .append('circle')
      .attr('r', (d) => d.r ?? 18)
      .attr('fill', (d) => d.color ?? '#1E5C8A')
      .attr('stroke', 'white')
      .attr('stroke-width', 2.5);

    nodeGroup
      .filter((d) => d.type === 'category')
      .append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', 28)
      .attr('fill', 'var(--c-text-soft)')
      .attr('font-size', 11)
      .attr('font-family', 'var(--font-body)')
      .attr('font-weight', 500);

    // Entity nodes: medium circles with type icon inside
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('circle')
      .attr('r', (d) => d.r ?? 14)
      .attr('fill', '#E8DEF8')
      .attr('stroke', '#8B6BAE')
      .attr('stroke-width', 1.2);

    // Icon inside circle
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => kgEntityIcon(entityTypeMap.get(d.label)))
      .attr('text-anchor', 'middle')
      .attr('dy', 5)
      .attr('font-size', 13)
      .attr('font-family', 'var(--font-body)');

    // Label below circle
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', 24)
      .attr('fill', '#7D5DA9')
      .attr('font-size', 10)
      .attr('font-family', 'var(--font-body)');

    // Tick
    simulation.on('tick', () => {
      linkGroup.selectAll<SVGLineElement, SimEdge>('line').each(function (d: SimEdge) {
        const src = d.source as SimNode;
        const tgt = d.target as SimNode;
        const dx = tgt.x! - src.x!;
        const dy = tgt.y! - src.y!;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sr = (src.r ?? 12) + 4;
        const tr = (tgt.r ?? 12) + 4;
        const x1 = src.x! + (dx / dist) * sr;
        const y1 = src.y! + (dy / dist) * sr;
        const x2 = tgt.x! - (dx / dist) * tr;
        const y2 = tgt.y! - (dy / dist) * tr;
        d3.select(this).attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2);
      });

      linkGroup.selectAll<SVGTextElement, SimEdge>('text').each(function (d: SimEdge) {
        const src = d.source as SimNode;
        const tgt = d.target as SimNode;
        d3.select(this).attr('x', (src.x! + tgt.x!) / 2).attr('y', (src.y! + tgt.y!) / 2);
      });

      nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    // Initial zoom
    const bounds = (svg.node() as SVGSVGElement)?.getBoundingClientRect();
    if (bounds && width > 0) {
      svg.call(
        zoom.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(0.7).translate(-width / 2, -height / 2),
      );
    }

    return () => {
      simulation.stop();
    };
  }, [filteredGraph, navigate, showTooltip, hideTooltip]);

  // ── Stats ──
  const stats = useMemo(() => {
    if (!filteredGraph) return null;
    return {
      articles: filteredGraph.nodes.filter((n) => n.type === 'article').length,
      categories: filteredGraph.nodes.filter((n) => n.type === 'category').length,

      edges: filteredGraph.edges.length,
    };
  }, [filteredGraph]);

  // ── Loading state ──
  if (graphLoading) {
    return <div className={styles.loading}>加载图谱数据…</div>;
  }

  if (graphError) {
    return <div className={styles.loading}>加载失败: {graphError}</div>;
  }

  return (
    <div className={styles.wrap}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className={styles.overlay} onClick={closeSidebar} />
      )}

      {/* ── Left: Categories ── */}
      <aside className={`${styles.leftCol} ${sidebarOpen ? styles.leftColOpen : ''}`}>
        <div className={styles.colHeader}>分类</div>
        <div className={styles.catList}>
          <button
            className={`${styles.catItem} ${!selectedCategoryId ? styles.catActive : ''}`}
            onClick={() => { setSelectedCategoryId(null); closeSidebar(); }}
          >
            <span className={styles.catDot} style={{ background: 'var(--c-text-muted)' }} />
            全部
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`${styles.catItem} ${selectedCategoryId === cat.id ? styles.catActive : ''}`}
              onClick={() => { setSelectedCategoryId(cat.id); closeSidebar(); }}
            >
              <span className={styles.catDot} style={{ background: cat.color }} />
              {cat.name}
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
          <button className={styles.selectBtn} onClick={handleDeselectAll}>取消</button>
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
                    background: selectedArticleIds.has(article.id)
                      ? 'var(--c-accent)'
                      : 'transparent',
                    borderColor: selectedArticleIds.has(article.id)
                      ? 'var(--c-accent)'
                      : 'var(--c-border)',
                  }}
                />
                <div className={styles.articleInfo}>
                  <div className={styles.articleTitle}>{article.title}</div>
                  <div className={styles.articleMeta}>
                    {article.category && (
                      <span style={{ color: article.category.color }}>
                        {article.category.name}
                      </span>
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
          <div className={styles.legendItem}>
            <div className={styles.legendDot} style={{ background: '#1E5C8A', borderRadius: 3 }} /> 文章
          </div>
          <div className={styles.legendItem}>
            <div className={styles.legendDot} style={{ background: '#3D7B4F' }} /> 分类
          </div>
          <div className={styles.legendItem}>
            <div className={styles.legendDot} style={{ background: '#E8DEF8', border: '1.5px solid #8B6BAE' }} /> 实体
          </div>
        </div>
        <div className={styles.container} ref={containerRef}>
          <svg ref={svgRef} className={styles.svg} />
          <div ref={tooltipRef} className={styles.tooltip} />
        </div>
      </div>
    </div>
  );
}
