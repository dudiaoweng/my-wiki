import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { api, type EntityInfoItem } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useApp } from '../context/AppProvider';
import { useGraphData } from '../hooks/useGraphData';
import type { Article } from '../types/article';
import styles from './EntityPanel.module.css';

// ── D3 types ──
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

interface EntityInfo {
  name: string;
  count: number;
  type?: string;  // entity type from LLM extraction
}

export type ViewMode = 'list' | 'graph';

const ENTITY_ICONS: Record<string, string> = {
  person: '👤', people: '👤', 人物: '👤',
  organization: '🏢', org: '🏢', 组织: '🏢', company: '🏢', 公司: '🏢',
  location: '📍', place: '📍', 地点: '📍',
  event: '📅', 事件: '📅',
  product: '📦', 产品: '📦',
};
function entityIcon(t: string | undefined): string {
  if (!t) return '◆';
  return ENTITY_ICONS[t.toLowerCase()] ?? '◆';
}

interface Props {
  entities: EntityInfo[];          // tags (manual, for statistics only)
  llmEntities: EntityInfo[];       // entities (LLM-extracted, read-only display)
  selectedArticleIds: string[];
  articles?: Article[];
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onRefresh?: () => void;
  onGraphNodeClick?: (nodeId: string, nodeType: string, label: string, multi?: boolean) => void;
  selectedGraphNodeIds?: Set<string>;
  onEntitySelect?: (entityName: string, ctrl: boolean) => void;
}

export function EntityPanel({
  entities,
  llmEntities,
  selectedArticleIds,
  articles = [],
  mode,
  onModeChange,
  onRefresh,
  onGraphNodeClick,
  selectedGraphNodeIds,
  onEntitySelect,
}: Props) {
  // ── Entity editing state ──
  const { showToast } = useToast();
  const { requestConfirm } = useApp();
  const [adding, setAdding] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityType, setNewEntityType] = useState('人物');
  const [editingEntity, setEditingEntity] = useState<string | null>(null);
  const [editEntityValue, setEditEntityValue] = useState('');
  const [editEntityType, setEditEntityType] = useState('');
  const [entitySearch, setEntitySearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const editTypeRef = useRef<HTMLInputElement>(null);

  // Filter entities by search query
  const filteredLlmEntities = useMemo(() => {
    const q = entitySearch.trim().toLowerCase();
    if (!q) return llmEntities;
    return llmEntities.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.type ?? '').toLowerCase().includes(q),
    );
  }, [llmEntities, entitySearch]);

  const handleAddEntity = async () => {
    const name = newEntityName.trim();
    if (!name || selectedArticleIds.length === 0) return;
    try {
      await api.addEntity(name, newEntityType || '其他', selectedArticleIds);
      showToast(`实体「${name}」已添加`, 'success');
      setNewEntityName('');
      setAdding(false);
      onRefresh?.();
    } catch {
      showToast('添加失败', 'error');
    }
  };

  const handleUpdateEntity = async () => {
    if (!editingEntity || !editEntityValue.trim()) return;
    try {
      await api.updateEntity(
        editingEntity,
        editEntityValue.trim() !== editingEntity ? editEntityValue.trim() : undefined,
        editEntityType.trim() || undefined,
      );
      showToast('实体已更新', 'success');
      setEditingEntity(null);
      onRefresh?.();
    } catch {
      showToast('更新失败', 'error');
    }
  };

  const handleDeleteEntity = (name: string) => {
    requestConfirm('删除实体', `确定要删除实体「${name}」吗？`, async () => {
      try {
        await api.removeEntity(name, selectedArticleIds.length > 0 ? selectedArticleIds : undefined);
        showToast(`实体「${name}」已删除`, 'success');
        onRefresh?.();
      } catch {
        showToast('删除失败', 'error');
      }
    });
  };

  // ── Entity info panel state (附加信息) ──
  const [selectedEntityName, setSelectedEntityName] = useState<string | null>(null);
  const [entityInfos, setEntityInfos] = useState<EntityInfoItem[]>([]);
  const [loadingInfos, setLoadingInfos] = useState(false);
  const [addingInfo, setAddingInfo] = useState(false);
  const [newInfoCategory, setNewInfoCategory] = useState('');
  const [newInfoContent, setNewInfoContent] = useState('');
  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [editInfoCategory, setEditInfoCategory] = useState('');
  const [editInfoContent, setEditInfoContent] = useState('');
  const newInfoCatRef = useRef<HTMLInputElement>(null);
  const newInfoContentRef = useRef<HTMLTextAreaElement>(null);

  // Load infos when entity is selected
  const loadEntityInfos = useCallback(async (entityName: string) => {
    setLoadingInfos(true);
    try {
      const infos = await api.getEntityInfos(entityName);
      setEntityInfos(infos);
    } catch {
      setEntityInfos([]);
    } finally {
      setLoadingInfos(false);
    }
  }, []);

  // Toggle entity selection — expand/collapse info panel
  const handleEntitySelect = useCallback(async (entityName: string, ctrl = false) => {
    // Notify parent (ArticleList) for article filtering
    onEntitySelect?.(entityName, ctrl);

    if (selectedEntityName === entityName) {
      // Deselect
      setSelectedEntityName(null);
      setEntityInfos([]);
      setAddingInfo(false);
      setEditingInfoId(null);
    } else {
      setSelectedEntityName(entityName);
      setAddingInfo(false);
      setEditingInfoId(null);
      await loadEntityInfos(entityName);
    }
  }, [selectedEntityName, loadEntityInfos, onEntitySelect]);

  // Refresh infos after mutation
  const refreshInfos = useCallback(async () => {
    if (selectedEntityName) {
      await loadEntityInfos(selectedEntityName);
    }
  }, [selectedEntityName, loadEntityInfos]);

  // Info CRUD handlers
  const handleAddInfo = async () => {
    if (!selectedEntityName || !newInfoCategory.trim() || !newInfoContent.trim()) return;
    try {
      await api.createEntityInfo(selectedEntityName, newInfoCategory.trim(), newInfoContent.trim());
      showToast('附加信息已添加', 'success');
      setNewInfoCategory('');
      setNewInfoContent('');
      setAddingInfo(false);
      await refreshInfos();
    } catch {
      showToast('添加失败', 'error');
    }
  };

  const handleUpdateInfo = async (infoId: string) => {
    if (!selectedEntityName || !editInfoCategory.trim() || !editInfoContent.trim()) return;
    try {
      await api.updateEntityInfo(selectedEntityName, infoId, {
        category: editInfoCategory.trim(),
        content: editInfoContent.trim(),
      });
      showToast('附加信息已更新', 'success');
      setEditingInfoId(null);
      await refreshInfos();
    } catch {
      showToast('更新失败', 'error');
    }
  };

  const handleDeleteInfo = (infoId: string, category: string) => {
    if (!selectedEntityName) return;
    requestConfirm('删除附加信息', `确定要删除「${category}」吗？`, async () => {
      try {
        await api.deleteEntityInfo(selectedEntityName, infoId);
        showToast('附加信息已删除', 'success');
        await refreshInfos();
      } catch {
        showToast('删除失败', 'error');
      }
    });
  };

  // If selected entity disappeared (e.g. deleted), deselect
  useEffect(() => {
    if (selectedEntityName && !llmEntities.some(e => e.name === selectedEntityName)) {
      setSelectedEntityName(null);
      setEntityInfos([]);
    }
  }, [llmEntities, selectedEntityName]);

  // Auto-focus inputs
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
  useEffect(() => { if (editingEntity) editRef.current?.focus(); }, [editingEntity]);
  useEffect(() => { if (addingInfo) newInfoCatRef.current?.focus(); }, [addingInfo]);

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

  // ── Knowledge graph ──
  const { data: graphData, loading: graphLoading } = useGraphData();
  // Ref to avoid restarting simulation on selection change
  const selectedNodesRef = useRef(selectedGraphNodeIds);
  selectedNodesRef.current = selectedGraphNodeIds;
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // ── Filtered graph based on selection ──
  const filteredGraph = useMemo(() => {
    if (!graphData) return null;
    const activeArticleIds =
      selectedArticleIds.length > 0
        ? new Set(selectedArticleIds)
        : new Set(articles.map((a) => a.id));
    if (activeArticleIds.size === 0) return { nodes: [], edges: [] };

    const prefixedIds = new Set(
      Array.from(activeArticleIds).map((id) => `article:${id}`)
    );
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
      edges: graphData.edges.filter(
        (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
      ),
    };
  }, [graphData, selectedArticleIds, articles]);

  // ── Tooltip helpers ──
  const showTooltip = useCallback((html: string, x: number, y: number) => {
    const el = tooltipRef.current;
    if (!el) return;
    el.innerHTML = html;
    el.style.cssText = `left:${x + 12}px;top:${y - 30}px;position:absolute;padding:8px 14px;background:var(--c-text);color:#fff;border-radius:6px;font-size:13px;font-weight:500;pointer-events:none;opacity:1;z-index:10;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  }, []);

  const hideTooltip = useCallback(() => {
    const el = tooltipRef.current;
    if (!el) return;
    el.style.opacity = '0';
  }, []);

  // ── D3 knowledge graph ──
  useEffect(() => {
    if (mode !== 'graph' || !graphContainerRef.current || !graphSvgRef.current) return;
    if (!filteredGraph || filteredGraph.nodes.length === 0) return;

    const container = graphContainerRef.current;
    const svg = d3.select(graphSvgRef.current);
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
      .map((e) => ({ source: e.source, target: e.target, label: e.label }));

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .force(
        'link',
        d3.forceLink<SimNode, SimEdge>(edges).id((d) => d.id).distance(120),
      )
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<SimNode>().radius((d) => (d.r ?? 12) + 8));

    const g = svg.append('g');
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
      .attr('stroke-opacity', 0.7);
    linkGroup
      .append('text')
      .text((d) => d.label)
      .attr('font-size', 9)
      .attr('fill', 'var(--c-text-muted)')
      .attr('text-anchor', 'middle')
      .attr('dy', -4);

    // ── Nodes ──
    const nodeGroup = g.append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer') as d3.Selection<SVGGElement, SimNode, SVGGElement, unknown>;

    // Drag
    const dragBehavior = d3.drag<SVGGElement, SimNode>()
      .on('start', (_event, d) => {
        if (!_event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (_event, d) => {
        if (!_event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
    nodeGroup.call(dragBehavior as any);

    // Hover / click
    const typeLabels: Record<string, string> = { article: '文章', category: '分类', entity: '实体' };
    nodeGroup
      .on('mouseenter', function (event, d) {
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
      .on('click', (event, d) => {
        onGraphNodeClick?.(d.id, d.type, d.label, event.ctrlKey || event.metaKey);
      });

    // Article nodes → rounded rects
    const isSelected = (id: string) => selectedNodesRef.current?.has(id);
    nodeGroup
      .filter((d) => d.type === 'article')
      .append('rect')
      .attr('width', 140).attr('height', 32).attr('x', -70).attr('y', -16)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', (d) => d.color ?? '#1E5C8A')
      .attr('stroke', (d) => isSelected(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSelected(d.id) ? 3 : 2)
      .attr('opacity', (d) => isSelected(d.id) ? 1 : 0.92)
      .style('filter', (d) => isSelected(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
    nodeGroup
      .filter((d) => d.type === 'article')
      .append('text')
      .text((d) => d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label)
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('fill', 'white').attr('font-size', 11)
      .attr('font-family', 'var(--font-body)').attr('font-weight', 500);

    // Category nodes → circles
    nodeGroup
      .filter((d) => d.type === 'category')
      .append('circle')
      .attr('r', (d) => d.r ?? 18)
      .attr('fill', (d) => d.color ?? '#3D7B4F')
      .attr('stroke', (d) => isSelected(d.id) ? 'var(--c-accent)' : 'white')
      .attr('stroke-width', (d) => isSelected(d.id) ? 3 : 2.5)
      .style('filter', (d) => isSelected(d.id) ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
    nodeGroup
      .filter((d) => d.type === 'category')
      .append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle').attr('dy', 28)
      .attr('fill', 'var(--c-text-soft)').attr('font-size', 11)
      .attr('font-family', 'var(--font-body)').attr('font-weight', 500);

    // Entity nodes → medium circles with type icon inside
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('circle')
      .attr('r', (d) => d.r ?? 14)
      .attr('fill', (d) => isSelected(d.id) ? 'var(--c-accent)' : '#E8DEF8')
      .attr('stroke', (d) => isSelected(d.id) ? 'var(--c-accent)' : '#8B6BAE')
      .attr('stroke-width', (d) => isSelected(d.id) ? 2 : 1.2)
      .style('filter', (d) => isSelected(d.id) ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
    // Icon inside circle
    nodeGroup
      .filter((d) => d.type === 'entity')
      .append('text')
      .text((d) => entityIcon(entityTypeMap.get(d.label)))
      .attr('text-anchor', 'middle').attr('dy', 5)
      .attr('font-size', 13)
      .attr('font-family', 'var(--font-body)');
    // Label below circle
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

    // Initial zoom
    svg.call(zoom.transform,
      d3.zoomIdentity.translate(width / 2, height / 2).scale(1.0).translate(-width / 2, -height / 2),
    );

    return () => { simulation.stop(); };
  }, [mode, filteredGraph, onGraphNodeClick, showTooltip, hideTooltip]);

  // ── Update selection visuals without restarting simulation ──
  useEffect(() => {
    if (mode !== 'graph' || !graphSvgRef.current) return;
    const svg = d3.select(graphSvgRef.current);
    const isSel = (id: string) => selectedGraphNodeIds?.has(id);

    svg.selectAll<SVGGElement, SimNode>('g.nodes g').each(function (d) {
      const g = d3.select(this);
      const s = isSel(d.id);

      if (d.type === 'article') {
        g.select('rect')
          .attr('stroke', s ? 'var(--c-accent)' : 'white')
          .attr('stroke-width', s ? 3 : 2)
          .attr('opacity', s ? 1 : 0.92)
          .style('filter', s ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
      } else if (d.type === 'category') {
        g.select('circle')
          .attr('stroke', s ? 'var(--c-accent)' : 'white')
          .attr('stroke-width', s ? 3 : 2.5)
          .style('filter', s ? 'drop-shadow(0 0 6px var(--c-accent))' : 'none');
      } else if (d.type === 'entity') {
        g.select('circle')
          .attr('fill', s ? 'var(--c-accent)' : '#E8DEF8')
          .attr('stroke', s ? 'var(--c-accent)' : '#8B6BAE')
          .attr('stroke-width', s ? 2 : 1.2)
          .style('filter', s ? 'drop-shadow(0 0 4px var(--c-accent))' : 'none');
      }
    });
  }, [selectedGraphNodeIds, mode]);

  // ── Render ──
  return (
    <div className={`${styles.panel} ${mode === 'graph' ? styles.panelGraph : ''}`}>
      <div className={styles.header}>
        <h4>{mode === 'list' ? '实体列表' : '知识图谱'}</h4>
        {mode === 'list' && (
          <button
            className={styles.headerAddBtn}
            disabled={selectedArticleIds.length === 0}
            onClick={() => setAdding(true)}
            title={selectedArticleIds.length === 0 ? '请先选择文章' : '新增实体'}
          >
            + 新增
          </button>
        )}
        <div className={styles.headerRight}>
          <span className={styles.count}>
            {mode === 'graph' && filteredGraph
              ? `${filteredGraph.nodes.filter(n => n.type === 'article').length}文 · ${filteredGraph.nodes.filter(n => n.type === 'entity').length}实体`
              : entitySearch
                ? `${filteredLlmEntities.length}/${llmEntities.length} 个`
                : `${llmEntities.length} 个`}
          </span>
          <button
            className={styles.modeBtn}
            onClick={() => onModeChange(mode === 'list' ? 'graph' : 'list')}
            title={mode === 'list' ? '切换为图谱视图' : '切换为列表视图'}
          >
            {mode === 'list' ? '🔗' : '📋'}
          </button>
        </div>
      </div>

      {mode === 'list' ? (
        <>
          <div className={styles.entitySearchWrap}>
            <span className={styles.entitySearchIcon}>🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              className={styles.entitySearchInput}
              value={entitySearch}
              onChange={(e) => setEntitySearch(e.target.value)}
              placeholder="搜索实体…"
              autoComplete="off"
            />
            {entitySearch && (
              <button
                className={styles.entitySearchClear}
                onClick={() => { setEntitySearch(''); searchInputRef.current?.focus(); }}
              >✕</button>
            )}
          </div>

          {adding && (
            <div className={styles.editRow} style={{ marginBottom: 8 }}>
              <select
                className={styles.editInput}
                value={newEntityType}
                onChange={(e) => setNewEntityType(e.target.value)}
                style={{ flex: '0 0 80px', cursor: 'pointer', minWidth: 0 }}
              >
                <option value="人物">👤 人物</option>
                <option value="组织">🏢 组织</option>
                <option value="地点">📍 地点</option>
                <option value="事件">📅 事件</option>
                <option value="产品">📦 产品</option>
                <option value="其他">◆ 其他</option>
              </select>
              <input
                ref={inputRef}
                className={styles.editInput}
                value={newEntityName}
                onChange={(e) => setNewEntityName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddEntity();
                  if (e.key === 'Escape') { setAdding(false); setNewEntityName(''); setNewEntityType('人物'); }
                }}
                placeholder="输入实体名称…"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleAddEntity}>✓</button>
              <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => { setAdding(false); setNewEntityName(''); setNewEntityType('人物'); }}>✕</button>
            </div>
          )}

          <div className={styles.list}>
            {filteredLlmEntities.map((ent) => (
              <div key={ent.name}>
                {editingEntity === ent.name ? (
                  <div className={styles.editRow}>
                    <select
                      ref={editTypeRef as any}
                      className={styles.editInput}
                      value={editEntityType}
                      onChange={(e) => setEditEntityType(e.target.value)}
                      style={{ flex: '0 0 85px', cursor: 'pointer', minWidth: 0 }}
                    >
                      <option value="">类型</option>
                      <option value="人物">👤 人物</option>
                      <option value="组织">🏢 组织</option>
                      <option value="地点">📍 地点</option>
                      <option value="事件">📅 事件</option>
                      <option value="产品">📦 产品</option>
                      <option value="其他">◆ 其他</option>
                    </select>
                    <input
                      ref={editRef}
                      className={styles.editInput}
                      value={editEntityValue}
                      onChange={(e) => setEditEntityValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleUpdateEntity();
                        if (e.key === 'Escape') setEditingEntity(null);
                      }}
                      placeholder="名称"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleUpdateEntity}>✓</button>
                    <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => setEditingEntity(null)}>✕</button>
                  </div>
                ) : (
                  <div className={`${styles.item} ${selectedEntityName === ent.name ? styles.itemSelected : ''}`}>
                    <button
                      className={styles.itemClickArea}
                      onClick={(e) => handleEntitySelect(ent.name, e.ctrlKey || e.metaKey)}
                      title={selectedEntityName === ent.name ? '点击取消选择' : '点击查看附加信息'}
                    >
                      <span style={{ fontSize: 14, flexShrink: 0 }} title={ent.type}>{entityIcon(ent.type)}</span>
                      <span className={styles.tagName} style={{ color: '#7D5DA9' }}>{ent.name}</span>
                    </button>
                    <button
                      className={styles.itemAction}
                      onClick={() => { setEditingEntity(ent.name); setEditEntityValue(ent.name); setEditEntityType(ent.type || ''); }}
                      title="编辑"
                    >✎</button>
                    <button
                      className={`${styles.itemAction} ${styles.itemActionDanger}`}
                      onClick={() => handleDeleteEntity(ent.name)}
                      title="删除"
                    >✕</button>
                    <span className={styles.tagCount}>{ent.count}</span>
                  </div>
                )}

                {/* ── Additional Info Panel ── */}
                {selectedEntityName === ent.name && (
                  <div className={styles.infoPanel}>
                    {loadingInfos ? (
                      <div className={styles.infoLoading}>加载中…</div>
                    ) : (
                      <div className={styles.infoList}>
                        {entityInfos.map((info) => (
                          <div key={info.id} className={styles.infoItem}>
                            {editingInfoId === info.id ? (
                              /* ── Edit mode (single line) ── */
                              <div className={styles.infoEditRow}>
                                <input
                                  className={styles.infoEditCat}
                                  value={editInfoCategory}
                                  onChange={(e) => setEditInfoCategory(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleUpdateInfo(info.id);
                                    if (e.key === 'Escape') setEditingInfoId(null);
                                  }}
                                  placeholder="类别"
                                />
                                <input
                                  className={styles.infoEditContent}
                                  value={editInfoContent}
                                  onChange={(e) => setEditInfoContent(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleUpdateInfo(info.id);
                                    if (e.key === 'Escape') setEditingInfoId(null);
                                  }}
                                  placeholder="内容"
                                />
                                <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={() => handleUpdateInfo(info.id)}>✓</button>
                                <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => setEditingInfoId(null)}>✕</button>
                              </div>
                            ) : (
                              /* ── Read-only mode (single line) ── */
                              <div className={styles.infoReadRow}>
                                <span className={styles.infoCat}>{info.category}</span>
                                <span className={styles.infoContent}>{info.content}</span>
                                <button
                                  className={styles.itemAction}
                                  onClick={() => {
                                    setEditingInfoId(info.id);
                                    setEditInfoCategory(info.category);
                                    setEditInfoContent(info.content);
                                  }}
                                  title="编辑"
                                >✎</button>
                                <button
                                  className={`${styles.itemAction} ${styles.itemActionDanger}`}
                                  onClick={() => handleDeleteInfo(info.id, info.category)}
                                  title="删除"
                                >✕</button>
                              </div>
                            )}
                          </div>
                        ))}
                        {entityInfos.length === 0 && !addingInfo && (
                          <div className={styles.infoEmpty}>暂无附加信息</div>
                        )}
                      </div>
                    )}

                    {/* ── Add new info ── */}
                    {addingInfo ? (
                      <div className={styles.infoEditRow}>
                        <input
                          ref={newInfoCatRef}
                          className={styles.infoEditCat}
                          value={newInfoCategory}
                          onChange={(e) => setNewInfoCategory(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddInfo();
                            if (e.key === 'Escape') { setAddingInfo(false); setNewInfoCategory(''); setNewInfoContent(''); }
                          }}
                          placeholder="类别"
                        />
                        <input
                          className={styles.infoEditContent}
                          value={newInfoContent}
                          onChange={(e) => setNewInfoContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddInfo();
                            if (e.key === 'Escape') { setAddingInfo(false); setNewInfoCategory(''); setNewInfoContent(''); }
                          }}
                          placeholder="内容"
                        />
                        <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleAddInfo}>✓</button>
                        <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => { setAddingInfo(false); setNewInfoCategory(''); setNewInfoContent(''); }}>✕</button>
                      </div>
                    ) : (
                      <button className={styles.infoAddBtn} onClick={() => setAddingInfo(true)}>
                        + 添加信息
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {llmEntities.length === 0 ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>暂无实体</div>
            ) : filteredLlmEntities.length === 0 ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>无匹配实体</div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, padding: '6px 16px', flexShrink: 0, fontSize: 11, color: 'var(--c-text-soft)' }}>
            <span>◫ 文章</span>
            <span>● 分类</span>
            <span>◆ 实体</span>
            {filteredGraph && (
              <span style={{ marginLeft: 'auto' }}>
                {filteredGraph.edges.length} 关联
              </span>
            )}
          </div>
          <div className={styles.graphContainer} ref={graphContainerRef}>
            {graphLoading ? (
              <div className={styles.graphEmpty}>加载图谱数据…</div>
            ) : !filteredGraph || filteredGraph.nodes.length === 0 ? (
              <div className={styles.graphEmpty}>
                {articles.length === 0 ? '暂无文章' : '选择文章以查看知识图谱'}
              </div>
            ) : (
              <>
                <svg ref={graphSvgRef} className={styles.graphSvg} />
                <div ref={tooltipRef} />
              </>
            )}
          </div>
        </>
      )}

    </div>
  );
}
