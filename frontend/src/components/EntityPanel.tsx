import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { api, type EntityInfoItem } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useApp } from '../context/AppProvider';
import { useGraphData } from '../hooks/useGraphData';
import { useD3ForceGraph } from '../hooks/useD3ForceGraph';
import { entityIcon, ENTITY_TYPE_OPTIONS } from '../utils/entityIcons';
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
  const { requestConfirm, articleVersion } = useApp();
  const [adding, setAdding] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityType, setNewEntityType] = useState('人物');
  const [entitySearch, setEntitySearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (selectedEntityName && !entities.some(e => e.name === selectedEntityName)) {
      setSelectedEntityName(null);
      setEntityInfos([]);
    }
  }, [entities, selectedEntityName]);

  // Auto-focus inputs
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
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

  // ── D3 graph via shared hook ──
  useD3ForceGraph(graphContainerRef, graphSvgRef, graphTooltipRef, 'inline', {
    graph: filteredGraph,
    entityTypeMap,
    onNodeClick: (id, type, label, ctrl) => onGraphNodeClick?.(id, type, label, ctrl),
    selectedNodeIds: selectedGraphNodeIds,
    showArrows: true,
    initialScale: 1.0,
  });


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
                <div className={`${styles.item} ${selectedEntityName === ent.name ? styles.itemSelected : ''}`}>
                  <button
                    className={styles.itemClickArea}
                    onClick={(e) => handleEntitySelect(ent.name, e.ctrlKey || e.metaKey)}
                    title={selectedEntityName === ent.name ? '点击取消选择' : '点击查看附加信息'}
                  >
                    <span style={{ fontSize: 14, flexShrink: 0 }} title={ent.type}>{entityIcon(ent.type)}</span>
                    <span className={styles.tagName} style={{ color: '#7D5DA9' }}>{ent.name}</span>
                  </button>
                  <span className={styles.tagCount}>{ent.count}</span>
                </div>

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
                <div ref={graphTooltipRef} />
              </>
            )}
          </div>
        </>
      )}

    </div>
  );
}
