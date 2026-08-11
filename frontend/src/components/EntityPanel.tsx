import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { api, type EntityInfoItem } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useApp } from '../context/AppProvider';
import { useGraphData } from '../hooks/useGraphData';
import { useD3ForceGraph } from '../hooks/useD3ForceGraph';
import { entityIcon, ENTITY_TYPE_OPTIONS } from '../utils/entityIcons';
import { EntityGraphPopover } from './EntityGraphPopover';
import type { Article } from '../types/article';
import styles from './EntityPanel.module.css';

interface EntityInfo {
  name: string;
  count: number;
  type?: string;
}

export type ViewMode = 'list' | 'graph';

interface Props {
  entities: EntityInfo[];          // entities (LLM-extracted)
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
  const { requestConfirm, articleVersion, userIdNumber } = useApp();

  /** Check if current user can modify this entity (by ID number).
   *  If entity has created_by → match its ID.
   *  If not → check if user created any article containing this entity (requires name). */
  const canModifyEntity = (ent: { created_by?: string | null; name?: string }) => {
    if (!userIdNumber) return true;
    if (ent.created_by) {
      const idMatch = ent.created_by.match(/\d{18}/);
      return idMatch ? idMatch[0] === userIdNumber : false;
    }
    // Legacy entity — check article creators
    if (!ent.name) return false;
    return articles.some((a) => {
      const hasEntity = a.entities?.entities?.some((e: any) => e.name === ent.name);
      if (!hasEntity || !a.created_by) return false;
      const articleIdMatch = a.created_by.match(/\d{18}/);
      return articleIdMatch ? articleIdMatch[0] === userIdNumber : false;
    });
  };
  const [adding, setAdding] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityType, setNewEntityType] = useState('人物');
  const [editingEntityName, setEditingEntityName] = useState<string | null>(null);
  const [editEntityName, setEditEntityName] = useState('');
  const [editEntityType, setEditEntityType] = useState('人物');
  const [entitySearch, setEntitySearch] = useState('');
  const [graphPopover, setGraphPopover] = useState<{
    entityName: string;
    entityType: string;
    x: number;
    y: number;
    createdBy?: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editNameInputRef = useRef<HTMLInputElement>(null);

  // Filter entities by search query
  const filteredEntities = useMemo(() => {
    const q = entitySearch.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.type ?? '').toLowerCase().includes(q),
    );
  }, [entities, entitySearch]);

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

  // ── Entity edit/delete handlers ──
  const handleStartEdit = (entity: EntityInfo) => {
    setEditingEntityName(entity.name);
    setEditEntityName(entity.name);
    setEditEntityType(entity.type || '其他');
  };

  const handleSaveEdit = async () => {
    const name = editEntityName.trim();
    if (!name || !editingEntityName) return;
    try {
      await api.updateEntity(editingEntityName, name !== editingEntityName ? name : undefined, editEntityType);
      showToast(`实体「${editingEntityName}」已更新`, 'success');
      setEditingEntityName(null);
      refetchGraph();
      onRefresh?.();
    } catch (e: unknown) {
      const msg = (e instanceof Error && e.message) ? e.message : '更新失败';
      showToast(msg, 'error');
    }
  };

  const handleDeleteEntity = (entityName: string) => {
    requestConfirm('删除实体', `确定要删除实体「${entityName}」吗？这将从所有文章中移除该实体。`, async () => {
      try {
        await api.removeEntity(entityName);
        showToast(`实体「${entityName}」已删除`, 'success');
        refetchGraph();
        onRefresh?.();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '删除失败';
        showToast(msg, 'error');
      }
    });
  };

  // ── Entity info panel state (附加信息) ──
  const [selectedEntityName, setSelectedEntityName] = useState<string | null>(null);
  const [entityInfos, setEntityInfos] = useState<EntityInfoItem[]>([]);
  const [loadingInfos, setLoadingInfos] = useState(false);
  const [addingInfo, setAddingInfo] = useState(false);
  const [newInfoName, setNewInfoName] = useState('');
  const [newInfoContent, setNewInfoContent] = useState('');
  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [editInfoName, setEditInfoName] = useState('');
  const [editInfoContent, setEditInfoContent] = useState('');
  const newInfoNameRef = useRef<HTMLInputElement>(null);

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
    if (!selectedEntityName || !newInfoName.trim() || !newInfoContent.trim()) return;
    try {
      await api.createEntityInfo(selectedEntityName, newInfoName.trim(), newInfoContent.trim());
      showToast('附加信息已添加', 'success');
      setNewInfoName('');
      setNewInfoContent('');
      setAddingInfo(false);
      await refreshInfos();
    } catch {
      showToast('添加失败', 'error');
    }
  };

  const handleUpdateInfo = async (infoId: string) => {
    if (!selectedEntityName || !editInfoName.trim() || !editInfoContent.trim()) return;
    try {
      await api.updateEntityInfo(selectedEntityName, infoId, {
        name: editInfoName.trim(),
        content: editInfoContent.trim(),
      });
      showToast('附加信息已更新', 'success');
      setEditingInfoId(null);
      await refreshInfos();
    } catch {
      showToast('更新失败', 'error');
    }
  };

  const handleDeleteInfo = (infoId: string, infoName: string) => {
    if (!selectedEntityName) return;
    requestConfirm('删除附加信息', `确定要删除「${infoName}」吗？`, async () => {
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
    if (selectedEntityName && !entities.some(e => e.name === selectedEntityName)) {
      setSelectedEntityName(null);
      setEntityInfos([]);
    }
  }, [entities, selectedEntityName]);

  // Close graph popover when switching to list mode
  useEffect(() => {
    if (mode === 'list') setGraphPopover(null);
  }, [mode]);

  // Auto-focus inputs
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
  useEffect(() => { if (editingEntityName) editNameInputRef.current?.focus(); }, [editingEntityName]);
  useEffect(() => { if (addingInfo) newInfoNameRef.current?.focus(); }, [addingInfo]);

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
  const { data: graphData, loading: graphLoading, refetch: refetchGraph } = useGraphData();

  // Refetch graph data when articles change (e.g. after file upload)
  useEffect(() => {
    if (articleVersion > 0) {
      refetchGraph();
    }
  }, [articleVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── D3 graph refs ──
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);
  const graphTooltipRef = useRef<HTMLDivElement>(null);

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

  // Merge popover entity into selected node IDs for visual highlighting
  const mergedSelectedNodeIds = useMemo(() => {
    const base = new Set(selectedGraphNodeIds ?? []);
    if (graphPopover) {
      base.add(`entity:${graphPopover.entityName}`);
    }
    return base;
  }, [selectedGraphNodeIds, graphPopover]);

  // ── Entity info cache for tooltip display ──
  const entityInfoMapRef = useRef<Map<string, { name: string; content: string }[]>>(new Map());

  // Pre-fetch entity infos for entity nodes visible in the graph
  useEffect(() => {
    if (mode !== 'graph' || !filteredGraph) return;
    const entityNodes = filteredGraph.nodes.filter((n) => n.type === 'entity');
    const cache = entityInfoMapRef.current;

    let cancelled = false;
    const fetchMissing = async () => {
      for (const node of entityNodes) {
        if (cancelled) break;
        if (!cache.has(node.label)) {
          try {
            const infos = await api.getEntityInfos(node.label);
            if (!cancelled) {
              cache.set(node.label, infos.map((i) => ({ name: i.name, content: i.content })));
            }
          } catch {
            // Ignore fetch errors; tooltip will just show basic info
          }
        }
      }
    };
    fetchMissing();
    return () => { cancelled = true; };
  }, [filteredGraph, mode]);

  // ── D3 graph via shared hook ──
  useD3ForceGraph(graphContainerRef, graphSvgRef, graphTooltipRef, 'inline', {
    graph: filteredGraph,
    entityTypeMap,
    entityInfoMap: entityInfoMapRef.current,
    onNodeClick: (id, type, label, ctrl, clientX, clientY) => {
      // Entity node click without Ctrl → show popover
      if (type === 'entity' && !ctrl && clientX !== undefined && clientY !== undefined) {
        const rect = graphContainerRef.current?.getBoundingClientRect();
        if (rect) {
          const found = entities.find((e: any) => e.name === label);
          setGraphPopover({
            entityName: label,
            entityType: entityTypeMap.get(label) || '其他',
            x: clientX - rect.left,
            y: clientY - rect.top,
            createdBy: found?.created_by || undefined,
          });
        }
        return;
      }
      // Ctrl+click or non-entity node → propagate to parent
      setGraphPopover(null);
      onGraphNodeClick?.(id, type, label, ctrl);
    },
    selectedNodeIds: mergedSelectedNodeIds,
    showArrows: true,
    initialScale: 1.0,
    enabled: mode === 'graph',
  });

  // ── Export graph as PNG ──
  const handleExportGraph = useCallback(async () => {
    const svgEl = graphSvgRef.current;
    if (!svgEl) return;

    // 1. Deep clone the SVG
    const clone = svgEl.cloneNode(true) as SVGSVGElement;

    // 2. Resolve CSS custom properties from the document
    const bodyStyle = getComputedStyle(document.body);
    const varNames = [
      '--c-border', '--c-text-muted', '--c-accent', '--c-text',
      '--c-text-soft', '--c-page', '--c-card', '--c-surface',
      '--c-accent-wash', '--c-danger', '--c-danger-wash',
      '--font-body', '--font-display',
    ];
    let css = '';
    for (const v of varNames) {
      const val = bodyStyle.getPropertyValue(v).trim();
      if (val) css += `  ${v}: ${val};\n`;
    }
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `:root {\n${css}}`;
    clone.insertBefore(style, clone.firstChild);

    // 3. Set explicit dimensions and background
    const rect = svgEl.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const bgColor = bodyStyle.getPropertyValue('--c-page').trim() || '#f5f5f5';
    clone.style.backgroundColor = bgColor;

    // 4. Serialize to data URL
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clone);
    const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

    // 5. Draw on canvas at 2x resolution, then download PNG
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `知识图谱_${new Date().toISOString().slice(0, 10)}.png`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('图谱已导出', 'success');
      }, 'image/png');
    };
    img.onerror = () => {
      showToast('导出失败', 'error');
    };
    img.src = svgDataUrl;
  }, [showToast]);


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
                ? `${filteredEntities.length}/${entities.length} 个实体`
                : `${entities.length} 个`}
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
                {ENTITY_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
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
            {filteredEntities.map((ent) => (
              <div key={ent.name}>
                {editingEntityName === ent.name ? (
                  /* ── Edit mode ── */
                  <div className={styles.editRow} style={{ marginBottom: 2 }}>
                    <select
                      className={styles.editInput}
                      value={editEntityType}
                      onChange={(e) => setEditEntityType(e.target.value)}
                      style={{ flex: '0 0 80px', cursor: 'pointer', minWidth: 0 }}
                    >
                      {ENTITY_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <input
                      ref={editNameInputRef}
                      className={styles.editInput}
                      value={editEntityName}
                      onChange={(e) => setEditEntityName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit();
                        if (e.key === 'Escape') setEditingEntityName(null);
                      }}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleSaveEdit}>✓</button>
                    <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => setEditingEntityName(null)}>✕</button>
                  </div>
                ) : (
                  /* ── Read-only mode ── */
                  <div className={`${styles.item} ${selectedEntityName === ent.name ? styles.itemSelected : ''}`}>
                    <button
                      className={styles.itemClickArea}
                      onClick={(e) => handleEntitySelect(ent.name, e.ctrlKey || e.metaKey)}
                      title={(ent as any).created_by
                        ? `类型：${ent.type}\n创建人：${(ent as any).created_by?.replace(/\s+\d{18}$/, '') ?? '未知'}`
                        : `类型：${ent.type}`}
                    >
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{entityIcon(ent.type)}</span>
                      <span className={styles.tagName} style={{ color: '#7D5DA9' }}>{ent.name}</span>
                    </button>
                    {canModifyEntity(ent) && (
                      <button
                        className={styles.itemAction}
                        onClick={(e) => { e.stopPropagation(); handleStartEdit(ent); }}
                        title="编辑实体"
                      >✎</button>
                    )}
                    {canModifyEntity(ent) && (
                      <button
                        className={`${styles.itemAction} ${styles.itemActionDanger}`}
                        onClick={(e) => { e.stopPropagation(); handleDeleteEntity(ent.name); }}
                        title="删除实体"
                      >✕</button>
                    )}
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
                                  value={editInfoName}
                                  onChange={(e) => setEditInfoName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleUpdateInfo(info.id);
                                    if (e.key === 'Escape') setEditingInfoId(null);
                                  }}
                                  placeholder="名称"
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
                                <span className={styles.infoCat}>{info.name}</span>
                                <span
                                  className={styles.infoContent}
                                  title={info.created_by ? `创建人：${info.created_by.replace(/\s+\d{18}$/, '')}` : undefined}
                                >{info.content}</span>
                                {canModifyEntity({ created_by: info.created_by }) && (
                                  <button
                                    className={styles.itemAction}
                                    onClick={() => {
                                      setEditingInfoId(info.id);
                                      setEditInfoName(info.name);
                                      setEditInfoContent(info.content);
                                    }}
                                    title="编辑"
                                  >✎</button>
                                )}
                                {canModifyEntity({ created_by: info.created_by }) && (
                                  <button
                                    className={`${styles.itemAction} ${styles.itemActionDanger}`}
                                    onClick={() => handleDeleteInfo(info.id, info.name)}
                                    title="删除"
                                  >✕</button>
                                )}
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
                          ref={newInfoNameRef}
                          className={styles.infoEditCat}
                          value={newInfoName}
                          onChange={(e) => setNewInfoName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddInfo();
                            if (e.key === 'Escape') { setAddingInfo(false); setNewInfoName(''); setNewInfoContent(''); }
                          }}
                          placeholder="名称"
                        />
                        <input
                          className={styles.infoEditContent}
                          value={newInfoContent}
                          onChange={(e) => setNewInfoContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddInfo();
                            if (e.key === 'Escape') { setAddingInfo(false); setNewInfoName(''); setNewInfoContent(''); }
                          }}
                          placeholder="内容"
                        />
                        <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleAddInfo}>✓</button>
                        <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => { setAddingInfo(false); setNewInfoName(''); setNewInfoContent(''); }}>✕</button>
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
            {entities.length === 0 ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>暂无实体</div>
            ) : filteredEntities.length === 0 ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>无匹配实体</div>
            ) : null}
          </div>

        </>
      ) : (
        <>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, padding: '6px 16px', flexShrink: 0, fontSize: 11, color: 'var(--c-text-soft)', alignItems: 'center' }}>
            <span>◫ 文章</span>
            <span>● 分类</span>
            <span>◆ 实体</span>
            {filteredGraph && (
              <span style={{ marginLeft: 'auto' }}>
                {filteredGraph.edges.length} 关联
              </span>
            )}
            <button
              onClick={handleExportGraph}
              disabled={!filteredGraph || filteredGraph.nodes.length === 0}
              title="导出为 PNG 图片"
              style={{
                padding: '2px 10px',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--c-card)',
                fontSize: 11,
                color: 'var(--c-text-soft)',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                whiteSpace: 'nowrap',
                opacity: filteredGraph && filteredGraph.nodes.length > 0 ? 1 : 0.35,
              }}
            >📥 导出</button>
          </div>
          <div className={styles.graphContainer} ref={graphContainerRef} onClick={() => setGraphPopover(null)}>
            {graphLoading ? (
              <div className={styles.graphEmpty}>加载图谱数据…</div>
            ) : !filteredGraph || filteredGraph.nodes.length === 0 ? (
              <div className={styles.graphEmpty}>
                {articles.length === 0 ? '暂无文章' : '选择文章以查看知识图谱'}
              </div>
            ) : (
              <>
                <svg ref={graphSvgRef} className={styles.graphSvg} />
                <div ref={graphTooltipRef} />
                {graphPopover && (
                  <EntityGraphPopover
                    entityName={graphPopover.entityName}
                    entityType={graphPopover.entityType}
                    x={graphPopover.x}
                    y={graphPopover.y}
                    createdBy={graphPopover.createdBy}
                    canModify={canModifyEntity({ created_by: graphPopover.createdBy, name: graphPopover.entityName })}
                    containerRef={graphContainerRef}
                    onClose={() => setGraphPopover(null)}
                    onRefresh={() => { refetchGraph(); onRefresh?.(); }}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}

    </div>
  );
}
