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
  r?: number;
}

export interface SimEdge extends d3.SimulationLinkDatum<SimNode> {
  label: string;
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
const TYPE_LABELS: Record<string, string> = { article: '文章', category: '分类' };

export function buildTooltipHtml(type: string, label: string, entityType?: string): string {
  const category = type === 'entity' ? (entityType || '实体') : (TYPE_LABELS[type] ?? type);
  return `<strong>${esc(category)}</strong><br>${esc(label)}`;
}

// ── Options ──
export interface UseD3ForceGraphOptions {
  /** Graph data { nodes, edges } — null/empty means nothing to render */
  graph: { nodes: { id: string; label: string; type: string; url: string; color: string | null }[]; edges: { source: string; target: string; label: string }[] } | null;
  /** Map of entity name → type (for rendering entity icons) */
  entityTypeMap: Map<string, string>;
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
  /** Whether the graph container is currently visible (DOM mounted).
   *  When false, the effect skips rendering and waits for it to become true. */
  enabled?: boolean;
}

/**
 * Shared D3 force-directed knowledge graph hook.
 * Manages simulation lifecycle, rendering, zoom, drag, and tooltips.
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
    entityTypeMap,
    entityInfoMap,
    onNodeClick,
    selectedNodeIds,
    showArrows = true,
    initialScale = 1.0,
    enabled = true,
  } = options;

  // Keep refs so D3 event handlers always read the latest value without re-creating the graph
  const selectedRef = useRef(selectedNodeIds);
  selectedRef.current = selectedNodeIds;

  const entityInfoMapRef = useRef(entityInfoMap);
  entityInfoMapRef.current = entityInfoMap;

  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

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
    if (!graph || graph.nodes.length === 0) return;
    if (!containerRef.current || !svgRef.current) return;

    const container = containerRef.current;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    // ── Prepare data ──
    const nodes: SimNode[] = graph.nodes.map((n) => ({
      ...n,
      r: NODE_RADIUS[n.type] ?? 12,
    }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const edges: SimEdge[] = graph.edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, label: e.label }));

    // ── Simulation ──
    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimEdge>(edges).id((d) => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius((d) => (d.r ?? 12) + 8));

    const g = svg.append('g');

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

    // ── Zoom ──
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => { g.attr('transform', event.transform.toString()); });
    svg.call(zoom);

    // ── Edges ──
    const linkGroup = g.append('g').selectAll('g').data(edges).join('g');
    linkGroup
      .append('line')
      .attr('stroke', 'var(--c-border)')
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.7)
      .attr('marker-end', showArrows ? 'url(#arrow-d3)' : null);
    linkGroup
      .append('text')
      .text((d) => d.label)
      .attr('font-size', 9)
      .attr('fill', 'var(--c-text-muted)')
      .attr('text-anchor', 'middle')
      .attr('dy', -4);

    // ── Nodes ──
    const nodeGroup = g.append('g')
      .attr('class', 'd3-nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer');

    // Drag
    const dragBehavior = d3.drag<SVGGElement, SimNode>()
      .on('start', function (_event, d) {
        if (!_event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
        // Highlight entity nodes during drag
        if (d.type === 'entity') {
          d3.select(this).select('circle')
            .attr('fill', 'var(--c-accent)')
            .attr('stroke', 'var(--c-accent)')
            .attr('stroke-width', 2.5)
            .style('filter', 'drop-shadow(0 0 8px var(--c-accent))');
        }
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', function (_event, d) {
        if (!_event.active) simulation.alphaTarget(0);
        // Restore entity node style based on current selection state
        if (d.type === 'entity') {
          const sel = selectedRef.current?.has(d.id) ?? false;
          d3.select(this).select('circle')
            .attr('fill', sel ? 'var(--c-accent)' : '#E8DEF8')
            .attr('stroke', sel ? 'var(--c-accent)' : '#8B6BAE')
            .attr('stroke-width', sel ? 2 : 1.2)
            .style('filter', sel ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
        }
        // Keep fx/fy at the final drag position so the node stays where the user dropped it
      });
    nodeGroup.call(dragBehavior as any);

    // Helper: check if a node is selected
    const isSel = (id: string) => selectedRef.current?.has(id) ?? false;

    // Hover / click
    nodeGroup
      .on('mouseenter', function (event, d) {
        const rect = container.getBoundingClientRect();
        let tooltipHtml = buildTooltipHtml(d.type, d.label, entityTypeMap.get(d.label));
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

    // ── Article nodes: rounded rects ──
    nodeGroup
      .filter((d) => d.type === 'article')
      .append('rect')
      .attr('width', 140).attr('height', 32).attr('x', -70).attr('y', -16)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', (d) => d.color ?? '#1E5C8A')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSel(d.id) ? 3 : 2)
      .attr('opacity', (d) => isSel(d.id) ? 1 : 0.92)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
    nodeGroup
      .filter((d) => d.type === 'article')
      .append('text')
      .text((d) => d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label)
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('fill', 'white').attr('font-size', 11)
      .attr('font-family', 'var(--font-body)').attr('font-weight', 500);

    // ── Category nodes: circles ──
    nodeGroup
      .filter((d) => d.type === 'category')
      .append('circle')
      .attr('r', (d) => d.r ?? 18)
      .attr('fill', (d) => d.color ?? '#3D7B4F')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSel(d.id) ? 3 : 2.5)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
    nodeGroup
      .filter((d) => d.type === 'category')
      .append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle').attr('dy', 28)
      .attr('fill', 'var(--c-text-soft)').attr('font-size', 11)
      .attr('font-family', 'var(--font-body)').attr('font-weight', 500);

    // ── Entity nodes: circles with type icon ──
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('circle')
      .attr('r', (d) => d.r ?? 14)
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => entityIcon(entityTypeMap.get(d.label)))
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('font-size', 13)
      .attr('font-family', 'var(--font-body)');
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label)
      .attr('text-anchor', 'middle').attr('dy', 24)
      .attr('fill', '#7D5DA9').attr('font-size', 10)
      .attr('font-family', 'var(--font-body)');

    // ── Tick ──
    simulation.on('tick', () => {
      linkGroup.selectAll<SVGLineElement, SimEdge>('line').each(function (d) {
        const src = d.source as SimNode;
        const tgt = d.target as SimNode;
        const dx = tgt.x! - src.x!;
        const dy = tgt.y! - src.y!;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sr = (src.r ?? 12) + 4;
        const tr = (tgt.r ?? 12) + 4;
        d3.select(this)
          .attr('x1', src.x! + (dx / dist) * sr)
          .attr('y1', src.y! + (dy / dist) * sr)
          .attr('x2', tgt.x! - (dx / dist) * tr)
          .attr('y2', tgt.y! - (dy / dist) * tr);
      });
      linkGroup.selectAll<SVGTextElement, SimEdge>('text').each(function (d) {
        const src = d.source as SimNode;
        const tgt = d.target as SimNode;
        d3.select(this).attr('x', (src.x! + tgt.x!) / 2).attr('y', (src.y! + tgt.y!) / 2);
      });
      nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    // ── Initial zoom ──
    svg.call(
      zoom.transform,
      d3.zoomIdentity.translate(width / 2, height / 2).scale(initialScale).translate(-width / 2, -height / 2),
    );

    return () => { simulation.stop(); };
  }, [enabled, graph, entityTypeMap, showArrows, initialScale, containerRef, svgRef, tooltipRef, tooltipStyle]);
  // NOTE: onNodeClick intentionally omitted — we use onNodeClickRef to avoid recreating the graph on every render

  // ── Update node selection visuals WITHOUT recreating the graph ──
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const nodeGroups = svg.selectAll<SVGGElement, SimNode>('.d3-nodes > g');

    if (nodeGroups.empty()) return;

    const isSel = (id: string) => selectedNodeIds?.has(id) ?? false;

    // Article nodes: update rect stroke/filter/opacity
    nodeGroups
      .filter((d) => d.type === 'article')
      .select('rect')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSel(d.id) ? 3 : 2)
      .attr('opacity', (d) => isSel(d.id) ? 1 : 0.92)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');

    // Category nodes
    nodeGroups
      .filter((d) => d.type === 'category')
      .select('circle')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSel(d.id) ? 3 : 2.5)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');

    // Entity nodes
    nodeGroups
      .filter((d) => d.type === 'entity')
      .select('circle')
      .attr('fill', (d) => isSel(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSel(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSel(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSel(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
  }, [selectedNodeIds, svgRef]);
}
