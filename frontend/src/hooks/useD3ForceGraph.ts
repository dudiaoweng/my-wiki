import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { entityIcon } from '../utils/entityIcons';

// ── Shared D3 types ──
export interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  url: string;
  color: string | null;
  entity_type?: string | null;
  r?: number;
}

export interface SimEdge extends d3.SimulationLinkDatum<SimNode> {
  label: string;
  /** 平行边弧线偏移：同一对节点间多条关系时按出现顺序均布（>0 弯曲避让重叠） */
  curve?: number;
}

export const NODE_RADIUS: Record<string, number> = {
  article: 22,
  category: 18,
  entity: 14,
};

// HTML-escape helper for user-controlled labels (prevents XSS)
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

// ── Tooltip helpers ──
const TYPE_LABELS: Record<string, string> = { article: '文章', category: '目录' };

export function buildTooltipHtml(type: string, label: string, entityType?: string): string {
  const category = type === 'entity' ? (entityType || '实体') : (TYPE_LABELS[type] ?? type);
  return `<strong>${esc(category)}</strong><br>${esc(label)}`;
}

// ── Options ──
export interface UseD3ForceGraphOptions {
  /** Graph data { nodes, edges } — null/empty means nothing to render */
  graph: { nodes: { id: string; label: string; type: string; url: string; color: string | null; entity_type?: string | null }[]; edges: { source: string; target: string; label: string }[] } | null;
  /** Map of entity name → type — 仅作为节点缺失 entity_type 时的回退 */
  entityTypeMap?: Map<string, string>;
  /** Called when a node is clicked */
  onNodeClick?: (nodeId: string, nodeType: string, label: string, ctrlKey: boolean, clientX?: number, clientY?: number) => void;
  /** Set of selected node IDs for visual highlighting */
  selectedNodeIds?: Set<string> | null;
  /** Whether to include arrow markers on edges */
  showArrows?: boolean;
  /** Initial scale for zoom */
  initialScale?: number;
  /** Map of entity name → additional info entries (for tooltip display) */
  entityInfoMap?: Map<string, { name: string; content: string }[]>;
  /** 聚焦节点 id：钉在容器中心显示（实体列表选中 ↔ 图谱联动时传入） */
  focusNodeId?: string | null;
  /** 新增节点的锚点 id：新进入的节点在其附近生成（展开/聚焦联动用） */
  anchorNodeId?: string | null;
  /** 导出用：读取当前节点位置（id → 坐标）的函数引用 */
  getPositionsRef?: React.MutableRefObject<(() => Map<string, { x: number; y: number }>) | null>;
  /** 导出用：读取当前视口（缩放/平移）的函数引用 */
  getViewportRef?: React.MutableRefObject<(() => { x: number; y: number; k: number }) | null>;
  /** 载入用：一次性节点初始位置（新进入的节点钉在这些坐标上，还原导出布局） */
  initialPositions?: Map<string, { x: number; y: number }> | null;
  /** 载入用：一次性视口变换（恢复导出时的缩放/平移） */
  initialViewport?: { x: number; y: number; k: number } | null;
  /** Whether the graph container is currently visible (DOM mounted).
   *  When false, the effect skips rendering and waits for it to become true. */
  enabled?: boolean;
}

/** 持久化的 D3 状态：数据增量更新时复用（保留节点位置与缩放，不重绘图谱） */
interface GraphState {
  svgEl: SVGSVGElement;
  container: HTMLDivElement;
  showArrows: boolean;
  width: number;
  height: number;
  simulation: d3.Simulation<SimNode, SimEdge>;
  linksG: d3.Selection<SVGGElement, unknown, null, undefined>;
  nodesG: d3.Selection<SVGGElement, unknown, null, undefined>;
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown>;
  dragBehavior: d3.DragBehavior<SVGGElement, SimNode, unknown>;
  nodes: SimNode[];
  edges: SimEdge[];
  pinnedNodeId: string | null;
}

/**
 * Shared D3 force-directed knowledge graph hook.
 *
 * 首次渲染时初始化 SVG 结构/力模拟/缩放；后续 graph 变化走数据 join 增量更新：
 * 已有节点保留对象与位置、缩放保持不变，新节点在锚点（或缓存位置）附近进入 ——
 * 展开/清除/撤销不重绘图谱。
 */
export function useD3ForceGraph(
  containerRef: React.RefObject<HTMLDivElement | null>,
  svgRef: React.RefObject<SVGSVGElement | null>,
  tooltipRef: React.RefObject<HTMLDivElement | null>,
  tooltipStyle: 'css' | 'inline',
  options: UseD3ForceGraphOptions,
) {
  const {
    graph,
    entityTypeMap = new Map<string, string>(),
    entityInfoMap,
    onNodeClick,
    selectedNodeIds,
    showArrows = true,
    initialScale = 1.0,
    focusNodeId = null,
    anchorNodeId = null,
    getPositionsRef,
    getViewportRef,
    initialPositions = null,
    initialViewport = null,
    enabled = true,
  } = options;

  // Keep refs so D3 event handlers always read the latest value without re-creating the graph
  const selectedRef = useRef(selectedNodeIds);
  selectedRef.current = selectedNodeIds;

  const entityInfoMapRef = useRef(entityInfoMap);
  entityInfoMapRef.current = entityInfoMap;

  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  const stateRef = useRef<GraphState | null>(null);
  // 节点位置缓存（id → 坐标）：撤销恢复/重入节点回到原位置
  const posCacheRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // ── 载入文件（一次性消费）：新传入的位置/视口仅在下一次图数据更新时应用，之后清空 ──
  const pendingPositionsRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const lastInitialPositionsRef = useRef(initialPositions);
  if (lastInitialPositionsRef.current !== initialPositions) {
    lastInitialPositionsRef.current = initialPositions;
    pendingPositionsRef.current = initialPositions;
  }
  const pendingViewportRef = useRef<{ x: number; y: number; k: number } | null>(null);
  const lastInitialViewportRef = useRef(initialViewport);
  if (lastInitialViewportRef.current !== initialViewport) {
    lastInitialViewportRef.current = initialViewport;
    pendingViewportRef.current = initialViewport;
  }

  // ── Tooltip show/hide ──
  const showTooltip = (html: string, x: number, y: number) => {
    const el = tooltipRef.current;
    if (!el) return;
    el.innerHTML = html;
    if (tooltipStyle === 'inline') {
      el.style.cssText = `left:${x + 12}px;top:${y - 30}px;position:absolute;padding:8px 14px;background:var(--c-text);color:#fff;border-radius:6px;font-size:13px;font-weight:500;pointer-events:none;opacity:1;z-index:10;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    } else {
      el.className = el.className + ' visible';
      el.style.left = `${x + 12}px`;
      el.style.top = `${y - 30}px`;
    }
  };

  const hideTooltip = () => {
    const el = tooltipRef.current;
    if (!el) return;
    if (tooltipStyle === 'inline') {
      el.style.opacity = '0';
    } else {
      el.className = el.className.replace(/\bvisible\b/g, '').trim();
    }
  };

  // ── D3 effect ──
  useEffect(() => {
    if (!enabled) return;
    if (!graph || graph.nodes.length === 0) {
      // 空图：停止旧模拟（SVG 通常已卸载），导出按钮禁用，位置/视口读取函数置空
      stateRef.current?.simulation.stop();
      if (getPositionsRef) getPositionsRef.current = null;
      if (getViewportRef) getViewportRef.current = null;
      return;
    }
    if (!containerRef.current || !svgRef.current) {
      stateRef.current?.simulation.stop();
      return;
    }

    const container = containerRef.current;
    const svgEl = svgRef.current;

    // ── 方框节点（文章/目录）尺寸：宽度按内容自适应，最宽 200、最窄 80 ──
    const MAX_BOX_W = 200;
    const MIN_BOX_W = 80;
    const boxLabelOf = (d: SimNode) => (d.label.length > 16 ? d.label.slice(0, 15) + '…' : d.label);
    const boxWidthOf = (d: SimNode) => {
      // 文本宽度估算：CJK 按 10px/字、其余按 6px/字；
      // 48 = 左内边距 12 + 图标 16 + 图标文字间距 10 + 右内边距 10
      const textW = Array.from(boxLabelOf(d)).reduce(
        (w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 10 : 6),
        0,
      );
      return Math.min(MAX_BOX_W, Math.max(MIN_BOX_W, 48 + textW));
    };

    // ── 初始化（首次 / svg 重挂载 / 箭头开关变化）──
    if (!stateRef.current || stateRef.current.svgEl !== svgEl || stateRef.current.showArrows !== showArrows) {
      const svg = d3.select(svgEl);
      svg.selectAll('*').remove();

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;

      // 停掉旧模拟（svg 重挂载场景）
      stateRef.current?.simulation.stop();

      // ── Arrow marker ──
      if (showArrows) {
        svg.append('defs').append('marker')
          .attr('id', 'arrow-d3')
          .attr('viewBox', '0 0 10 10')
          .attr('refX', 10).attr('refY', 5)
          .attr('markerWidth', 6).attr('markerHeight', 6)
          .attr('orient', 'auto-start-reverse')
          .append('path')
          .attr('d', 'M 0 0 L 10 5 L 0 10 z')
          .attr('fill', 'var(--c-border)')
          .attr('opacity', 0.7);
      }

      const g = svg.append('g');
      const linksG = g.append('g');
      const nodesG = g.append('g').attr('class', 'd3-nodes');

      // ── Simulation ──
      const simulation = d3
        .forceSimulation<SimNode>([])
        .force('link', d3.forceLink<SimNode, SimEdge>([]).id((d) => d.id).distance(120))
        .force('charge', d3.forceManyBody().strength(-500))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide<SimNode>().radius((d) => (d.r ?? 12) + 8));

      // 弧线几何：平行边按 curve 偏移弯曲（单条边 curve=0 即直线）
      const arcGeometry = (d: SimEdge) => {
        const src = d.source as SimNode;
        const tgt = d.target as SimNode;
        const dx = tgt.x! - src.x!;
        const dy = tgt.y! - src.y!;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const px = -uy;   // 垂直方向
        const py = ux;
        const off = d.curve ?? 0;
        const sr = (src.r ?? 12) + 4;
        const tr = (tgt.r ?? 12) + 4;
        const sx = src.x! + ux * sr + px * off * 0.5;
        const sy = src.y! + uy * sr + py * off * 0.5;
        const tx = tgt.x! - ux * tr + px * off * 0.5;
        const ty = tgt.y! - uy * tr + py * off * 0.5;
        const mx = (src.x! + tgt.x!) / 2 + px * off;
        const my = (src.y! + tgt.y!) / 2 + py * off;
        return { sx, sy, tx, ty, mx, my };
      };

      simulation.on('tick', () => {
        linksG.selectAll<SVGPathElement, SimEdge>('path').each(function (d) {
          const g = arcGeometry(d);
          d3.select(this).attr('d', `M${g.sx},${g.sy}Q${g.mx},${g.my} ${g.tx},${g.ty}`);
        });
        linksG.selectAll<SVGTextElement, SimEdge>('text').each(function (d) {
          const g = arcGeometry(d);
          d3.select(this)
            .attr('x', (g.sx + 2 * g.mx + g.tx) / 4)
            .attr('y', (g.sy + 2 * g.my + g.ty) / 4);
        });
        nodesG.selectAll<SVGGElement, SimNode>('g').attr('transform', (d) => `translate(${d.x},${d.y})`);
      });

      // ── Zoom ──
      const zoom = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 3])
        .on('zoom', (event) => { g.attr('transform', event.transform.toString()); });
      svg.call(zoom);
      svg.call(
        zoom.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(initialScale).translate(-width / 2, -height / 2),
      );

      // ── Drag ──
      const dragBehavior = d3.drag<SVGGElement, SimNode>()
        .on('start', function (_event, d) {
          if (!_event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
          // 拖动时不呈现选中状态：样式保持原状，仅跟随指针
          //（end 时按真实选中态校正样式）
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', function (_event, d) {
          if (!_event.active) simulation.alphaTarget(0);
          // Restore node style based on current selection state
          const sel = selectedRef.current?.has(d.id) ?? false;
          d3.select(this).select('rect,circle')
            .attr('fill', sel ? 'var(--c-accent)' : '#E8DEF8')
            .attr('stroke', sel ? 'var(--c-accent)' : '#8B6BAE')
            .attr('stroke-width', sel ? 2 : 1.2)
            .style('filter', sel ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
          if (d.type === 'article' || d.type === 'category') {
            d3.select(this).selectAll('text')
              .filter((_, i) => i === 1)
              .attr('fill', sel ? 'white' : '#5B4A8C');
          }
          // Keep fx/fy at the final drag position so the node stays where the user dropped it
        });

      stateRef.current = {
        svgEl, container, showArrows, width, height,
        simulation, linksG, nodesG, zoom, dragBehavior,
        nodes: [], edges: [], pinnedNodeId: null,
      };
    }

    const st = stateRef.current;
    const { width, height } = st;
    const isSel = (id: string) => selectedRef.current?.has(id) ?? false;

    // 导出读取函数：实时快照当前节点位置与视口（供 JSON 导出）
    if (getPositionsRef) {
      getPositionsRef.current = () => {
        const m = new Map<string, { x: number; y: number }>();
        for (const n of st.nodes) {
          if (n.x !== undefined && n.y !== undefined) m.set(n.id, { x: n.x, y: n.y });
        }
        return m;
      };
    }
    if (getViewportRef) {
      getViewportRef.current = () => {
        const t = d3.zoomTransform(svgEl);
        return { x: t.x, y: t.y, k: t.k };
      };
    }

    // ── 数据增量更新：已有节点保留对象引用（位置不动），新节点在锚点附近进入 ──
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const prevMap = new Map(st.nodes.map((n) => [n.id, n]));
    // 位置快照（撤销恢复 / 重入节点回原位）
    for (const n of st.nodes) {
      if (n.x !== undefined && n.y !== undefined) posCacheRef.current.set(n.id, { x: n.x, y: n.y });
    }
    const anchor = anchorNodeId ? (prevMap.get(anchorNodeId) ?? null) : null;

    // 载入文件的新节点：钉在文件记录的位置（一次性消费，还原导出布局）
    const importedRunIds = new Set<string>();
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = prevMap.get(n.id);
      if (prev) {
        // 复用对象：位置保留；同步可变字段
        prev.label = n.label;
        prev.color = n.color;
        prev.entity_type = n.entity_type ?? null;
        // 载入文件：已存在节点也还原到文件记录的位置（覆盖当前布局）
        const loaded = pendingPositionsRef.current?.get(n.id);
        if (loaded) {
          prev.x = loaded.x;
          prev.y = loaded.y;
          prev.fx = loaded.x;
          prev.fy = loaded.y;
          importedRunIds.add(n.id);
        }
        return prev;
      }
      // 新节点：优先载入文件位置（钉住），其次缓存位置（撤销恢复），再次锚点附近，最后中心附近
      const loaded = pendingPositionsRef.current?.get(n.id);
      const cached = posCacheRef.current.get(n.id);
      const baseX = loaded ? loaded.x : cached ? cached.x : anchor ? anchor.x! : width / 2;
      const baseY = loaded ? loaded.y : cached ? cached.y : anchor ? anchor.y! : height / 2;
      const node: SimNode = {
        ...n,
        r: NODE_RADIUS[n.type] ?? 12,
        x: loaded ? baseX : baseX + (Math.random() - 0.5) * 60,
        y: loaded ? baseY : baseY + (Math.random() - 0.5) * 60,
      };
      if (loaded) {
        node.fx = loaded.x;
        node.fy = loaded.y;
        importedRunIds.add(n.id);
      }
      return node;
    });
    pendingPositionsRef.current = null;

    // 关系去重：按 (source, target, label) 去重（防御后端多 source 产生的重复提及边）
    const edges: SimEdge[] = [];
    const seenEdgeKeys = new Set<string>();
    for (const e of graph.edges) {
      if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
      const k = `${e.source}|${e.target}|${e.label}`;
      if (seenEdgeKeys.has(k)) continue;
      seenEdgeKeys.add(k);
      edges.push({ source: e.source, target: e.target, label: e.label });
    }

    // 同一对节点间存在多条关系 → 分配弧线偏移（按出现顺序均布），单条保持直线
    const CURVE_SPACING = 14;
    {
      const pairKey = (e: SimEdge) => {
        // 此时 source/target 尚未被 forceLink 替换，仍为节点 id 字符串
        const s = String(e.source);
        const t = String(e.target);
        return s < t ? `${s}|${t}` : `${t}|${s}`;
      };
      const pairCounts = new Map<string, number>();
      for (const e of edges) {
        const k = pairKey(e);
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
      const seen = new Map<string, number>();
      for (const e of edges) {
        const k = pairKey(e);
        const idx = seen.get(k) ?? 0;
        seen.set(k, idx + 1);
        const total = pairCounts.get(k) ?? 1;
        // 反向边的偏移取负：正反方向的弧线弯向相反一侧，避免重叠
        const dirSign = String(e.source) < String(e.target) ? 1 : -1;
        e.curve = total > 1 ? (idx - (total - 1) / 2) * CURVE_SPACING * dirSign : 0;
      }
    }

    // 边 key：forceLink 绑定后 source/target 会被替换为节点对象
    const edgeKey = (d: SimEdge) => {
      const s = typeof d.source === 'string' || typeof d.source === 'number' ? d.source : (d.source as SimNode).id;
      const t = typeof d.target === 'string' || typeof d.target === 'number' ? d.target : (d.target as SimNode).id;
      return `${s}|${t}|${d.label}`;
    };

    // ── 边 join ──
    const linkSel = st.linksG.selectAll<SVGGElement, SimEdge>('g').data(edges, edgeKey);
    const linkExit = linkSel.exit();
    linkExit.remove();
    const linkEnter = linkSel.enter().append('g');
    linkEnter
      .append('path')
      .attr('fill', 'none')
      .attr('stroke', 'var(--c-border)')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.7)
      .attr('marker-end', showArrows ? 'url(#arrow-d3)' : null);
    linkEnter
      .append('text')
      .text((d) => d.label)
      .attr('font-size', 9)
      .attr('fill', 'var(--c-text-muted)')
      .attr('text-anchor', 'middle')
      .attr('dy', -4);

    // ── 节点 join ──
    const nodeSel = st.nodesG.selectAll<SVGGElement, SimNode>('g').data(nodes, (d: SimNode) => d.id);
    const nodeExit = nodeSel.exit();
    nodeExit.remove();
    const nodeEnter = nodeSel.enter().append('g').attr('cursor', 'pointer');

    // 进入节点的形状（按类型）
    // 文章节点：方框样式，图标在前、标注在框内，宽度随内容自适应（最宽 200）
    nodeEnter
      .filter((d) => d.type === 'article')
      .append('rect')
      .attr('width', (d) => boxWidthOf(d)).attr('height', 32)
      .attr('x', (d) => -boxWidthOf(d) / 2).attr('y', -16)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    nodeEnter
      .filter((d) => d.type === 'article')
      .append('text')
      .text(() => '📄')
      .attr('x', (d) => -boxWidthOf(d) / 2 + 12).attr('dy', 6)
      .attr('font-size', 16);
    nodeEnter
      .filter((d) => d.type === 'article')
      .append('text')
      .text((d) => boxLabelOf(d))
      .attr('text-anchor', 'start').attr('x', (d) => -boxWidthOf(d) / 2 + 38).attr('dy', 5)
      .attr('fill', (d) => isSel(d.id) ? 'white' : '#5B4A8C').attr('font-size', 10)
      .attr('font-family', 'var(--font-body)');

    // 目录节点：方框样式与文章节点一致（图标在前、标注在框内，宽度自适应）
    nodeEnter
      .filter((d) => d.type === 'category')
      .append('rect')
      .attr('width', (d) => boxWidthOf(d)).attr('height', 32)
      .attr('x', (d) => -boxWidthOf(d) / 2).attr('y', -16)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    nodeEnter
      .filter((d) => d.type === 'category')
      .append('text')
      .text(() => '📁')
      .attr('x', (d) => -boxWidthOf(d) / 2 + 12).attr('dy', 6)
      .attr('font-size', 16);
    nodeEnter
      .filter((d) => d.type === 'category')
      .append('text')
      .text((d) => boxLabelOf(d))
      .attr('text-anchor', 'start').attr('x', (d) => -boxWidthOf(d) / 2 + 38).attr('dy', 5)
      .attr('fill', (d) => isSel(d.id) ? 'white' : '#5B4A8C').attr('font-size', 10)
      .attr('font-family', 'var(--font-body)');

    nodeEnter
      .filter((d) => d.type === 'entity')
      .append('circle')
      .attr('r', (d) => d.r ?? 14)
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    nodeEnter
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => entityIcon(d.entity_type || entityTypeMap.get(d.label)))
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('font-size', 13)
      .attr('font-family', 'var(--font-body)');
    nodeEnter
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label)
      .attr('text-anchor', 'middle').attr('dy', 24)
      .attr('fill', '#7D5DA9').attr('font-size', 10)
      .attr('font-family', 'var(--font-body)');

    // 进入节点的交互
    nodeEnter.call(st.dragBehavior as any);
    nodeEnter
      .on('mouseenter', function (event, d) {
        const rect = container.getBoundingClientRect();
        let tooltipHtml = buildTooltipHtml(d.type, d.label, d.entity_type || entityTypeMap.get(d.label));
        // Append entity additional info for entity nodes
        if (d.type === 'entity') {
          const infos = entityInfoMapRef.current?.get(d.label);
          if (infos && infos.length > 0) {
            tooltipHtml += '<div style="margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;opacity:0.9;max-height:120px;overflow-y:auto">';
            for (const info of infos.slice(0, 8)) {
              tooltipHtml += `<div style="margin:2px 0">• <b>${esc(info.name)}</b>: ${esc(info.content)}</div>`;
            }
            if (infos.length > 8) tooltipHtml += `<div style="opacity:0.6">…还有 ${infos.length - 8} 条</div>`;
            tooltipHtml += '</div>';
          }
        }
        showTooltip(
          tooltipHtml,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        d3.select(this).select('rect,circle').attr('filter', 'brightness(1.15)');
      })
      .on('mouseleave', function () {
        hideTooltip();
        d3.select(this).select('rect,circle').attr('filter', null);
      })
      .on('click', (event, d) => {
        event.stopPropagation();
        onNodeClickRef.current?.(d.id, d.type, d.label, event.ctrlKey || event.metaKey, event.clientX, event.clientY);
      });

    // 合并集上刷新动态样式与文本（改名/换色场景；文本按索引定位：0=图标 1=标签）
    const merged = nodeSel.merge(nodeEnter);
    // 方框节点（文章/目录）：刷新宽度/文本/位置（改名场景自适应重排）
    merged.filter((d) => d.type === 'article').each(function (d) {
      const g = d3.select(this);
      const sel = isSel(d.id);
      g.select('rect')
        .attr('fill', sel ? 'var(--c-accent)' : '#E8DEF8')
        .attr('width', boxWidthOf(d))
        .attr('x', -boxWidthOf(d) / 2);
      const ts = g.selectAll('text');
      ts.filter((_, i) => i === 0).text('📄').attr('x', -boxWidthOf(d) / 2 + 12);
      ts.filter((_, i) => i === 1)
        .text(boxLabelOf(d))
        .attr('x', -boxWidthOf(d) / 2 + 38)
        .attr('fill', sel ? 'white' : '#5B4A8C');
    });
    merged.filter((d) => d.type === 'category').each(function (d) {
      const g = d3.select(this);
      const sel = isSel(d.id);
      g.select('rect')
        .attr('fill', sel ? 'var(--c-accent)' : '#E8DEF8')
        .attr('width', boxWidthOf(d))
        .attr('x', -boxWidthOf(d) / 2);
      const ts = g.selectAll('text');
      ts.filter((_, i) => i === 0).text('📁').attr('x', -boxWidthOf(d) / 2 + 12);
      ts.filter((_, i) => i === 1)
        .text(boxLabelOf(d))
        .attr('x', -boxWidthOf(d) / 2 + 38)
        .attr('fill', sel ? 'white' : '#5B4A8C');
    });
    merged.filter((d) => d.type === 'entity').each(function (d) {
      const ts = d3.select(this).selectAll('text');
      ts.filter((_, i) => i === 0)
        .text(entityIcon(d.entity_type || entityTypeMap.get(d.label)));
      ts.filter((_, i) => i === 1)
        .text(d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label);
    });

    // ── 聚焦节点：钉在容器中心（切换时释放旧钉）──
    // 位置保持：释放旧钉/重复更新时保持节点当前位置 —— 用户拖动调整过的
    // 源实体位置不回弹到中心（如选中其他实体后旧源实体不恢复原位置）
    const newNodeMap = new Map(nodes.map((n) => [n.id, n]));
    if (st.pinnedNodeId && st.pinnedNodeId !== focusNodeId) {
      const old = newNodeMap.get(st.pinnedNodeId);
      if (old) {
        // 释放旧钉但保持在当前位置（含用户拖动后的位置）
        old.fx = old.x;
        old.fy = old.y;
      }
    }
    const pinTargetChanged = st.pinnedNodeId !== focusNodeId;
    st.pinnedNodeId = focusNodeId;
    let pinChanged = false;
    if (focusNodeId && !importedRunIds.has(focusNodeId)) {
      const focus = newNodeMap.get(focusNodeId);
      if (focus) {
        // 新聚焦或节点尚无钉 → 钉到中心；已有钉（用户拖动过/载入文件位置）→ 保持
        if (pinTargetChanged || focus.fx == null || focus.fy == null) {
          focus.fx = width / 2;
          focus.fy = height / 2;
          pinChanged = true;
        }
      }
    }

    // ── 绑定数据到模拟：已有节点对象保留位置，新节点融入 ──
    st.simulation.nodes(nodes);
    (st.simulation.force('link') as d3.ForceLink<SimNode, SimEdge>).links(edges);
    st.nodes = nodes;
    st.edges = edges;

    // 温和重启布局（节点增减、连线增减或聚焦钉变化；单纯选中高亮不触发）。
    // 新增/删除关系时节点不变，但新 path 的 d 属性只在 tick 中写入——
    // 不重启模拟会导致新边不显示、标签停在原点。
    const nodeChanged = !nodeEnter.empty() || !nodeExit.empty();
    const edgeChanged = !linkEnter.empty() || !linkExit.empty();
    if (nodeChanged || pinChanged) {
      st.simulation.alpha(0.6).restart();
    } else if (edgeChanged) {
      st.simulation.alpha(0.2).restart();
    }

    // 载入文件视口（一次性消费）：恢复导出时的缩放/平移
    if (pendingViewportRef.current) {
      const v = pendingViewportRef.current;
      d3.select(svgEl).call(
        st.zoom.transform,
        d3.zoomIdentity
          .translate(v.x, v.y)
          .scale(Math.max(0.3, Math.min(3, v.k))),
      );
      pendingViewportRef.current = null;
    }

    // ── 容器尺寸变化（移动端旋转 / 分栏切换）：更新力导向中心，避免图偏向一侧 ──
    let lastW = container.clientWidth;
    let lastH = container.clientHeight;
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (w === 0 || h === 0) return;
      const cur = stateRef.current;
      if (!cur || cur.svgEl !== svgEl) return;
      cur.simulation.force('center', d3.forceCenter(w / 2, h / 2));
      cur.simulation.alpha(0.3).restart();
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [enabled, graph, entityTypeMap, showArrows, initialScale, focusNodeId, anchorNodeId, containerRef, svgRef, tooltipRef, tooltipStyle]);
  // NOTE: onNodeClick intentionally omitted — we use onNodeClickRef to avoid recreating the graph on every render
  // initialPositions/initialViewport/getters 同样刻意不在依赖中：经 pending ref 一次性消费，避免重复应用

  // 视图隐藏时停止力模拟（切到列表/关闭图谱窗口），避免后台定时器继续跑
  useEffect(() => {
    if (!enabled) stateRef.current?.simulation.stop();
  }, [enabled]);

  // 组件卸载时停止力模拟，避免在已分离的 SVG 上继续 tick
  useEffect(() => () => {
    stateRef.current?.simulation.stop();
  }, []);

  // ── Update node selection visuals WITHOUT recreating the graph ──
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const nodeGroups = svg.selectAll<SVGGElement, SimNode>('.d3-nodes > g');

    if (nodeGroups.empty()) return;

    const isSel = (id: string) => selectedNodeIds?.has(id) ?? false;

    // 三种节点（文章方框/目录圆形/实体圆形）样式统一：选中 = accent 填充 + 描边 + 发光
    nodeGroups
      .select('rect,circle')
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    // 文章/目录框内标注：选中时改白色（accent 底色上可读）
    nodeGroups
      .filter((d) => d.type === 'article' || d.type === 'category')
      .each(function (d) {
        d3.select(this).selectAll('text')
          .filter((_, i) => i === 1)
          .attr('fill', isSel(d.id) ? 'white' : '#5B4A8C');
      });
  }, [selectedNodeIds, svgRef]);
}
