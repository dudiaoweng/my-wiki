import { useRef, useState, useEffect, useMemo, useCallback, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type EntityInfoItem, type EntityRelation } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useApp } from '../context/AppProvider';
import { useGraphData } from '../hooks/useGraphData';
import { useD3ForceGraph } from '../hooks/useD3ForceGraph';
import { entityIcon, ENTITY_TYPE_OPTIONS } from '../utils/entityIcons';
import type { Article } from '../types/article';
import type { GraphData, GraphNode, GraphEdge } from '../types/graph';
import styles from './EntityPanel.module.css';

interface EntityInfo {
  name: string;
  count: number;
  type?: string;
  created_by?: string;
}

/** 关联行视图：方向相对当前选中实体（→ 出边 / ← 入边） */
interface RelationRowView {
  key: string;
  rel: EntityRelation;
  outgoing: boolean;
  otherName: string;
  otherType: string;
  otherKey: string;
}

interface RelationTargetOption {
  key: string;
  name: string;
  type: string;
}

// ── File System Access API（TS lib.dom 未内置 showOpenFilePicker）──
// 用于「载入图谱」时获取可写文件句柄，保存时原地覆盖载入的文件。
interface GraphWritableStream {
  write: (data: string | Blob) => Promise<void>;
  close: () => Promise<void>;
}
interface GraphFileHandle {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<GraphWritableStream>;
}
type ShowOpenFilePicker = (options?: {
  multiple?: boolean;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<GraphFileHandle[]>;
type ShowSaveFilePicker = (options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<GraphFileHandle>;

/**
 * 关联对端选择器：带图标 + 可输入筛选的下拉。
 * 因为信息面板位于滚动容器内，下拉菜单用 portal + fixed 定位，避免被 overflow 裁剪。
 */
function RelationTargetPicker({
  options,
  value,
  onChange,
  placeholder,
  extraOption,
}: {
  options: RelationTargetOption[];
  value: string;
  onChange: (key: string) => void;
  placeholder: string;
  /** 当前值不在候选列表中（编辑既有关系时）仍需显示 */
  extraOption?: RelationTargetOption | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const allOptions = useMemo(() => {
    const list = [...options];
    if (extraOption && !list.some((o) => o.key === extraOption.key)) list.unshift(extraOption);
    return list;
  }, [options, extraOption]);

  const selected = allOptions.find((o) => o.key === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter(
      (o) => o.name.toLowerCase().includes(q) || o.type.toLowerCase().includes(q),
    );
  }, [allOptions, query]);

  // 打开时按触发按钮位置计算固定定位；空间不足时向上弹出
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(240, Math.max(190, rect.width + 80));
    const menuH = 196;
    const top = rect.bottom + 2 + menuH > window.innerHeight && rect.top > menuH + 8
      ? rect.top - menuH - 2
      : rect.bottom + 2;
    const left = Math.min(
      window.innerWidth - width - 8,
      Math.max(8, rect.right - width),
    );
    setMenuPos({ top, left, width });
    setQuery('');
    setOpen(true);
  };

  // 点击外部 / 滚动 / 窗口尺寸变化时关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 只在「菜单外部」滚动时关闭：菜单内部列表的滚轮/滚动条滚动不能关闭下拉框
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const choose = (opt: RelationTargetOption) => {
    onChange(opt.key);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className={styles.relationPicker}>
      <button
        ref={btnRef}
        type="button"
        className={styles.relationPickerBtn}
        title={selected ? `${selected.name}（${selected.type || '其他'}）` : placeholder}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        {selected ? (
          <>
            <span className={styles.relationPickerIcon}>{entityIcon(selected.type)}</span>
            <span className={styles.relationPickerLabel}>{selected.name}</span>
          </>
        ) : (
          <span className={styles.relationPickerPlaceholder}>{placeholder}</span>
        )}
        <span className={styles.relationPickerCaret}>▾</span>
      </button>
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className={styles.relationPickerMenu}
          style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
        >
          <input
            className={styles.relationPickerSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && filtered.length > 0) choose(filtered[0]);
            }}
            placeholder="筛选对端实体…"
            autoFocus
          />
          <div className={styles.relationPickerList}>
            {filtered.length === 0 ? (
              <div className={styles.relationPickerEmpty}>无匹配实体</div>
            ) : (
              filtered.map((opt) => (
                <button
                  type="button"
                  key={opt.key}
                  className={`${styles.relationPickerOption} ${opt.key === value ? styles.relationPickerOptionActive : ''}`}
                  onClick={() => choose(opt)}
                >
                  <span className={styles.relationPickerIcon}>{entityIcon(opt.type)}</span>
                  <span className={styles.relationPickerOptionName}>{opt.name}</span>
                  <span className={styles.relationPickerOptionType}>{opt.type || '其他'}</span>
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export type ViewMode = 'list' | 'graph';

interface Props {
  entities: EntityInfo[];          // entities (LLM-extracted)
  selectedArticleIds: string[];
  articles?: Article[];
  mode: ViewMode;
  onRefresh?: () => void;
  onGraphNodeClick?: (nodeId: string, nodeType: string, label: string, multi?: boolean) => void;
  /** 点击图谱空白区域 → 取消全部选中（父级清空多选集；源实体保留） */
  onClearAllSelections?: () => void;
  selectedGraphNodeIds?: Set<string>;
  onEntitySelect?: (entityName: string, entityType: string, ctrl: boolean) => void;
}

export function EntityPanel({
  entities,
  selectedArticleIds,
  articles = [],
  mode,
  onRefresh,
  onGraphNodeClick,
  onClearAllSelections,
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
  // 同名不同类型视为不同实体，编辑态按 (name, type) 区分
  const [editingEntityType, setEditingEntityType] = useState<string | null>(null);
  const [editEntityName, setEditEntityName] = useState('');
  const [editEntityType, setEditEntityType] = useState('人物');
  const [entitySearch, setEntitySearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editNameInputRef = useRef<HTMLInputElement>(null);
  // 图谱空白点击守卫：mousedown 位置（拖拽平移不算空白点击）
  const graphMouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  // 实体行 DOM 引用（图谱实体点击联动滚动定位）；图谱点击联动标志（跳过分批重置一次）
  const entityRowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const selectFromGraphRef = useRef(false);

  // 动态加载：实体列表分批展示，每批不超过 20 条；数据/筛选变化时回到第一批
  const ENTITY_BATCH = 20;
  // 动态加载：关联信息分批展示，每批不超过 10 条；切换选中实体时回到第一批
  const RELATION_BATCH = 10;
  const [visibleCount, setVisibleCount] = useState(ENTITY_BATCH);
  useEffect(() => {
    // 图谱点击联动实体列表时跳过重置：保留展开的分批以显示选中行
    if (selectFromGraphRef.current) return;
    // 编辑中/已选中的实体可能因清除筛选或数据刷新落到第一批之外：
    // 保证其行（以及行内编辑表单）仍被渲染，避免点击「修改」后看似没反应。
    const activeName = editingEntityName ?? selectedEntityName;
    const activeType = editingEntityName ? editingEntityType : selectedEntityType;
    if (activeName) {
      const key = `${activeName}::${activeType ?? null}`;
      const idx = filteredEntities.findIndex(
        (e) => `${e.name}::${e.type ?? null}` === key,
      );
      if (idx >= ENTITY_BATCH) {
        // 只增不减：避免已点过「加载更多」后被重置回 idx+1
        setVisibleCount((c) => Math.max(c, idx + 1));
        requestAnimationFrame(() => {
          entityRowElsRef.current.get(key)?.scrollIntoView({ block: 'nearest' });
        });
        return;
      }
    }
    setVisibleCount(ENTITY_BATCH);
  }, [entities, entitySearch]);

  const handleAddEntity = async () => {
    const name = newEntityName.trim();
    if (!name) return;

    // 单独浏览模式：只向内存中的载入图添加实体节点（不写数据库、不做权限校验）
    if (isolatedMode) {
      const type = newEntityType || '其他';
      const graph = workingGraph ?? { nodes: [], edges: [] };
      if (graph.nodes.some(
        (n) => n.type === 'entity' && n.label === name && (n.entity_type ?? '') === type,
      )) {
        showToast('同名同类型实体已存在', 'error');
        return;
      }
      let id = `entity:${name}::${type}`;
      let suffix = 1;
      while (graph.nodes.some((n) => n.id === id)) {
        id = `entity:${name}::${type}#${suffix++}`;
      }
      setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
      setWorkingGraph({
        nodes: [
          ...graph.nodes,
          { id, label: name, type: 'entity', url: '', color: null, entity_type: type },
        ],
        edges: graph.edges,
      });
      showToast(`实体「${name}」已添加到当前图谱`, 'success');
      setNewEntityName('');
      setAdding(false);
      return;
    }

    if (selectedArticleIds.length === 0) return;
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
    setEditingEntityType(entity.type ?? null);
    setEditEntityName(entity.name);
    setEditEntityType(entity.type || '其他');
  };

  const handleSaveEdit = async () => {
    const name = editEntityName.trim();
    if (!name || !editingEntityName) return;

    // 单独浏览模式：只改内存中载入图的节点标签/类型（不写数据库、不做权限校验）
    if (isolatedMode) {
      const graph = workingGraph ?? { nodes: [], edges: [] };
      const target = graph.nodes.find(
        (n) => n.type === 'entity' && n.label === editingEntityName
          && (n.entity_type ?? '') === (editingEntityType ?? ''),
      );
      if (!target) {
        showToast('实体不在当前载入图谱中', 'error');
        return;
      }
      const newType = editEntityType || '其他';
      if (graph.nodes.some(
        (n) => n.id !== target.id && n.type === 'entity'
          && n.label === name && (n.entity_type ?? '') === newType,
      )) {
        showToast('同名同类型实体已存在', 'error');
        return;
      }
      setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
      setWorkingGraph({
        nodes: graph.nodes.map(
          (n) => (n.id === target.id ? { ...n, label: name, entity_type: newType } : n),
        ),
        edges: graph.edges,
      });
      showToast(`实体「${editingEntityName}」已更新（仅当前图谱）`, 'success');
      if (selectedEntityName === editingEntityName
        && (selectedEntityType ?? '') === (editingEntityType ?? '')) {
        setSelectedEntityName(name);
        setSelectedEntityType(newType);
      }
      setEditingEntityName(null);
      setEditingEntityType(null);
      return;
    }

    try {
      const nameChanged = name !== editingEntityName;
      // 改名走 /rename（级联 EntityInfo 附加信息与 chunk 标签行）；只改类型走 /update。
      // old_type 限定 (name, type)，避免同名其他类型的节点被一起改掉。
      if (nameChanged) {
        await api.renameEntity(editingEntityName, name, editingEntityType);
      }
      if (editEntityType) {
        await api.updateEntity(
          nameChanged ? name : editingEntityName,
          undefined,
          editEntityType,
          editingEntityType,
        );
      }
      showToast(`实体「${editingEntityName}」已更新`, 'success');
      setEditingEntityName(null);
      setEditingEntityType(null);
      refetchGraph();
      onRefresh?.();
      if (nameChanged) {
        // 被改名的实体若处于选中状态 → 清除选中（旧名称节点已不存在）
        if (selectedEntityName === editingEntityName) {
          clearEntitySelection();
          const goneIds = [
            `entity:${editingEntityName}::${selectedEntityType ?? ''}`,
            `entity:${editingEntityName}::`,
            `entity:${editingEntityName}`,
          ];
          setSelectedGraphNodeId((curId) => (curId && goneIds.includes(curId) ? null : curId));
        }
      } else {
        // 仅改类型：选中态/聚焦态的 (name, type) 同步到新类型，
        // 否则 selectedEntity 解析不到（同名旧类型行消失）且聚焦子图找不到节点
        const oldType = editingEntityType ?? '';
        if (selectedEntityName === editingEntityName
          && (selectedEntityType ?? '') === oldType) {
          setSelectedEntityType(editEntityType);
        }
        if (editEntityType !== oldType
          && focusEntity && focusEntity.name === editingEntityName
          && (focusEntity.type ?? '') === oldType) {
          setFocusEntity({ name: editingEntityName, type: editEntityType });
        }
        setSelectedGraphNodeId((curId) => {
          if (!curId) return curId;
          return curId === `entity:${editingEntityName}::${oldType}`
            ? `entity:${editingEntityName}::${editEntityType}`
            : curId;
        });
      }
    } catch (e: unknown) {
      const msg = (e instanceof Error && e.message) ? e.message : '更新失败';
      showToast(msg, 'error');
    }
  };

  const handleDeleteEntity = (entityName: string, entityType?: string | null) => {
    // 单独浏览模式：只从内存中的载入图移除节点及其边（不写数据库、不做权限校验）
    if (isolatedMode) {
      requestConfirm('删除实体', `确定要从当前载入图谱中删除实体「${entityName}」吗？`, () => {
        const graph = workingGraph;
        if (!graph) return;
        const targets = graph.nodes.filter(
          (n) => n.type === 'entity' && n.label === entityName
            && (entityType == null || (n.entity_type ?? '') === entityType),
        );
        if (targets.length === 0) return;
        const ids = new Set(targets.map((n) => n.id));
        setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
        setWorkingGraph({
          nodes: graph.nodes.filter((n) => !ids.has(n.id)),
          edges: graph.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
        });
        showToast(`实体「${entityName}」已从当前图谱删除`, 'success');
        if (selectedEntityName === entityName
          && (entityType == null || (selectedEntityType ?? '') === entityType)) {
          setSelectedEntityName(null);
          setSelectedEntityType(null);
          setEntityInfos([]);
          setAddingInfo(false);
          setEditingInfoId(null);
          setSelectedGraphNodeId(null);
          // 同步清空父级的图谱多选集，避免残留已删除节点 id
          onClearAllSelections?.();
        }
      });
      return;
    }

    const typeLabel = entityType ? `（${entityType}）` : '';
    requestConfirm('删除实体', `确定要删除实体「${entityName}${typeLabel}」吗？这将从所有文章中移除该实体。`, async () => {
      try {
        await api.removeEntity(entityName, undefined, entityType ?? null);
        showToast(`实体「${entityName}」已删除`, 'success');
        refetchGraph();
        onRefresh?.();
        // 被删除的实体若处于选中状态 → 清除选中与对应节点高亮
        if (selectedEntityName === entityName) {
          clearEntitySelection();
          const goneIds = [
            `entity:${entityName}::${selectedEntityType ?? ''}`,
            `entity:${entityName}::`,
            `entity:${entityName}`,
          ];
          setSelectedGraphNodeId((curId) => (curId && goneIds.includes(curId) ? null : curId));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '删除失败';
        showToast(msg, 'error');
      }
    });
  };

  // ── Entity info panel state (附加信息) ──
  const [selectedEntityName, setSelectedEntityName] = useState<string | null>(null);
  // 同名不同类型视为不同实体，选中状态按 (name, type) 区分
  const [selectedEntityType, setSelectedEntityType] = useState<string | null>(null);
  // 图谱聚焦实体：仅由实体列表点击驱动；图谱内点击节点不改变聚焦（不重绘图谱）
  const [focusEntity, setFocusEntity] = useState<{ name: string; type: string | null } | null>(null);

  // ── 图操作（展开/清除/撤销）──
  // 工作图：在基准图（聚焦子图/按文章过滤）之上叠加展开/清除结果；历史栈供撤销
  const [workingGraph, setWorkingGraph] = useState<GraphData | null>(null);
  // 历史栈：每步记录操作前的图与载入图谱名称（撤销时一并还原）
  const [graphHistory, setGraphHistory] = useState<{ graph: GraphData; graphName: string | null }[]>([]);
  // 载入图谱文件名称（标签形式显示在「知识图谱」标题右侧）
  const [loadedGraphName, setLoadedGraphName] = useState<string | null>(null);
  // 单独浏览模式：图谱视图下载入文件后，实体列表与图谱组成独立窗格，仅相互联动。
  // 该模式下的实体/关联编辑只改内存中的载入图，不写数据库、不做权限校验。
  const isolatedMode = mode === 'graph' && loadedGraphName !== null;
  const [expandDepth, setExpandDepth] = useState(1);
  const [expanding, setExpanding] = useState(false);
  // 图谱内最后点击的节点（展开/清除的操作对象）
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  // 载入图谱文件：一次性节点位置/视口（传给 D3 hook 消费，还原导出布局）
  const [loadedPositions, setLoadedPositions] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [loadedViewport, setLoadedViewport] = useState<{ x: number; y: number; k: number } | null>(null);

  // 聚焦实体变化（列表点击）→ 重置工作图、历史、载入图谱名称与选中节点。
  // 已载入图谱时必须由关闭标签显式退出：切换窗口/在列表模式选中实体不能
  // 清空载入图，否则回到图谱模式会显示数据库图却仍标着载入文件名。
  useEffect(() => {
    if (loadedGraphName !== null) return;
    setWorkingGraph(null);
    setGraphHistory([]);
    setLoadedGraphName(null);
    graphFileHandleRef.current = null;
    setSelectedGraphNodeId(null);
  }, [focusEntity]); // loadedGraphName 刻意不入依赖：载入/关闭由各自 handler 处理

  // 当前选中实体（展开信息面板的实体）—— 顶部「修改/删除」按钮的操作对象
  // 单独浏览模式下实体来自载入图谱（可能不在文章实体列表中），按选中名称/类型兜底
  const selectedEntity = useMemo<EntityInfo | null>(() => {
    const found = entities.find(
      (e) => e.name === selectedEntityName && (e.type ?? null) === selectedEntityType,
    );
    if (found) return found;
    if (isolatedMode && selectedEntityName) {
      return { name: selectedEntityName, type: selectedEntityType ?? undefined, count: 0 };
    }
    return null;
  }, [entities, selectedEntityName, selectedEntityType, isolatedMode]);

  // 清除实体选中（信息面板收起；图谱聚焦/源实体同时退出）
  const clearEntitySelection = useCallback(() => {
    setSelectedEntityName(null);
    setSelectedEntityType(null);
    setFocusEntity(null);
    setEntityInfos([]);
    setAddingInfo(false);
    setEditingInfoId(null);
  }, []);

  // 点击图谱空白区域 → 取消全部选中：
  // 图谱节点选中（当前节点 + 父级多选集）+ 实体列表行选中/信息面板；
  // 源实体（focusEntity/聚焦）保留 —— 存在源实体时不重载全部实体
  const handleGraphBackgroundClick = () => {
    setSelectedGraphNodeId(null);
    setSelectedEntityName(null);
    setSelectedEntityType(null);
    setEntityInfos([]);
    setAddingInfo(false);
    setEditingInfoId(null);
    onClearAllSelections?.();
  };

  // 图谱实体点击联动 → 滚动实体列表使对应行可见
  useEffect(() => {
    if (!selectFromGraphRef.current) return;
    selectFromGraphRef.current = false;
    const key = `${selectedEntityName}::${selectedEntityType}`;
    entityRowElsRef.current.get(key)?.scrollIntoView({ block: 'nearest' });
  }, [selectedEntityName, selectedEntityType]);

  // 顶部按钮：修改选中实体（清除筛选，保证编辑行可见）
  const handleEditSelected = () => {
    if (!selectedEntity) return;
    setAdding(false);
    setEntitySearch('');
    handleStartEdit(selectedEntity);
  };

  const handleDeleteSelected = () => {
    if (!selectedEntity) return;
    handleDeleteEntity(selectedEntity.name, selectedEntity.type ?? null);
  };
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

  // Refresh infos after mutation
  const refreshInfos = useCallback(async () => {
    if (selectedEntityName) {
      await loadEntityInfos(selectedEntityName);
    }
  }, [selectedEntityName, loadEntityInfos]);

  // Info CRUD handlers（附加信息存 SQLite，单独浏览模式下禁止写入载入图以外的数据）
  const handleAddInfo = async () => {
    if (isolatedMode) return;
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
    if (isolatedMode) return;
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
    if (isolatedMode) return;
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
  // 注：选中实体消失时不再用 effect 自动清除 —— 该判断曾在展开/分页场景误伤
  // 「再次点击取消选中」（展开引入的实体不在全量 graphData 截断集/实体池中）。
  // 删除/改名路径已在对应 handler 中显式清除选中。
  const { data: graphData, loading: graphLoading, refetch: refetchGraph } = useGraphData();

  // Refetch graph data when articles change (e.g. after file upload)
  useEffect(() => {
    if (articleVersion > 0) {
      refetchGraph();
    }
  }, [articleVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 选中实体的关联信息（Neo4j RELATES 边：实体 ⇄ 实体，含方向与关系名）──
  // 实体信息面板中显示在附加信息之后；按当前文章范围从 Neo4j 查询，可增删改
  const [entityRelations, setEntityRelations] = useState<EntityRelation[]>([]);
  const [loadingRelations, setLoadingRelations] = useState(false);
  // 关联编辑表单（单行：方向切换 + 关系名 + 对端 + 保存/取消）
  const [addingRelation, setAddingRelation] = useState(false);
  const [newRelationLabel, setNewRelationLabel] = useState('');
  const [newRelationTargetKey, setNewRelationTargetKey] = useState('');
  const [newRelationOutgoing, setNewRelationOutgoing] = useState(true);
  const [editingRelationKey, setEditingRelationKey] = useState<string | null>(null);
  const [editRelationLabel, setEditRelationLabel] = useState('');
  const [editRelationTargetKey, setEditRelationTargetKey] = useState('');
  const [editRelationOutgoing, setEditRelationOutgoing] = useState(true);
  const [savingRelation, setSavingRelation] = useState(false);

  // 当前文章范围（关联查询/写入的上下文；空 = 全部文章）
  const articleScopeKey = selectedArticleIds.join(',');
  const articleScopeIds = useMemo(
    () => (articleScopeKey ? articleScopeKey.split(',') : null),
    [articleScopeKey],
  );

  // 请求序号：快速切换实体时丢弃过期响应，避免关联显示串位
  const relationReqRef = useRef(0);
  const loadEntityRelations = useCallback(async () => {
    const reqId = ++relationReqRef.current;
    if (!selectedEntityName) {
      setEntityRelations([]);
      setLoadingRelations(false);
      return;
    }
    setLoadingRelations(true);
    try {
      const rels = await api.queryEntityRelations({
        entity_name: selectedEntityName,
        entity_type: selectedEntityType,
        article_ids: articleScopeIds,
      });
      if (reqId !== relationReqRef.current) return;
      setEntityRelations(rels);
    } catch {
      if (reqId !== relationReqRef.current) return;
      setEntityRelations([]);
    } finally {
      if (reqId === relationReqRef.current) setLoadingRelations(false);
    }
  }, [selectedEntityName, selectedEntityType, articleScopeIds]);

  // 选中实体/文章范围变化（或文章数据刷新）时重新载入关联；
  // 单独浏览模式下来自载入图本身，不查询数据库
  useEffect(() => {
    if (isolatedMode) {
      setLoadingRelations(false);
      setEntityRelations([]);
      return;
    }
    void loadEntityRelations();
  }, [loadEntityRelations, articleVersion, isolatedMode]);

  // 切换选中实体时收起关联编辑表单并复位方向
  useEffect(() => {
    setAddingRelation(false);
    setEditingRelationKey(null);
    setNewRelationOutgoing(true);
    setEditRelationOutgoing(true);
  }, [selectedEntityName, selectedEntityType]);

  // 单独浏览模式的关联：直接从载入图的关系边派生（两端须为实体节点）
  const isolatedRelations = useMemo<EntityRelation[]>(() => {
    if (!isolatedMode || !workingGraph || !selectedEntityName) return [];
    const selType = selectedEntityType ?? '';
    const nodeById = new Map(workingGraph.nodes.map((n) => [n.id, n]));
    const selIds = new Set(
      workingGraph.nodes
        .filter((n) => n.type === 'entity' && n.label === selectedEntityName
          && (selType === '' || (n.entity_type ?? '') === selType))
        .map((n) => n.id),
    );
    if (selIds.size === 0) return [];
    const agg = new Map<string, EntityRelation>();
    for (const e of workingGraph.edges) {
      const sIsSel = selIds.has(e.source);
      const tIsSel = selIds.has(e.target);
      if (sIsSel === tIsSel) continue;
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (!s || !t || s.type !== 'entity' || t.type !== 'entity') continue;
      const key = `${s.label}::${s.entity_type ?? ''}|${t.label}::${t.entity_type ?? ''}|${e.label}`;
      if (!agg.has(key)) {
        agg.set(key, {
          source_name: s.label,
          source_type: s.entity_type ?? '',
          target_name: t.label,
          target_type: t.entity_type ?? '',
          label: e.label,
          article_ids: [],
        });
      }
    }
    return Array.from(agg.values());
  }, [isolatedMode, workingGraph, selectedEntityName, selectedEntityType]);

  // 关联数据源：单独浏览模式下来自载入图，否则来自数据库查询
  const relationList = isolatedMode ? isolatedRelations : entityRelations;

  // 关联行视图：方向相对当前选中实体（→ 出边 / ← 入边）
  const relationRows = useMemo<RelationRowView[]>(() => {
    const selName = selectedEntityName ?? '';
    const selType = selectedEntityType ?? '';
    return relationList.map((rel) => {
      const srcType = rel.source_type ?? '';
      const tgtType = rel.target_type ?? '';
      const srcIsSel = rel.source_name === selName && (selType === '' || srcType === selType);
      const tgtIsSel = rel.target_name === selName && (selType === '' || tgtType === selType);
      const outgoing = srcIsSel || (!tgtIsSel && rel.source_name === selName);
      const otherName = outgoing ? rel.target_name : rel.source_name;
      const otherType = outgoing ? tgtType : srcType;
      return {
        key: `${rel.source_name}::${srcType}|${rel.target_name}::${tgtType}|${rel.label}`,
        rel,
        outgoing,
        otherName,
        otherType,
        otherKey: `${otherName}::${otherType}`,
      };
    });
  }, [relationList, selectedEntityName, selectedEntityType]);

  // 对端候选来源：单独浏览模式下来自载入图的实体节点，否则来自当前文章的实体列表
  const relationPickerEntities = useMemo<EntityInfo[]>(() => {
    if (!isolatedMode) return entities;
    if (!workingGraph) return [];
    const seen = new Set<string>();
    const out: EntityInfo[] = [];
    for (const n of workingGraph.nodes) {
      if (n.type !== 'entity') continue;
      const type = n.entity_type ?? '';
      const key = `${n.label}::${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: n.label, type, count: 0 });
    }
    return out;
  }, [isolatedMode, workingGraph, entities]);

  // 对端候选：仅当前范围（文章实体 / 载入图谱实体）中的实体，排除自身
  const relationTargetOptions = useMemo<RelationTargetOption[]>(
    () => relationPickerEntities
      .filter((e) => !(e.name === selectedEntityName && (e.type ?? '') === (selectedEntityType ?? '')))
      .map((e) => ({ key: `${e.name}::${e.type ?? ''}`, name: e.name, type: e.type ?? '' })),
    [relationPickerEntities, selectedEntityName, selectedEntityType],
  );

  // 关联按文章存储：必须先有文章上下文（查看/选择文章）才允许增删改，
  // 避免在"全部文章"视图下误把关系写入所有共同提及的文章。
  // 单独浏览模式例外：只编辑内存中的载入图，不做权限/文章范围校验。
  const hasArticleScope = selectedArticleIds.length > 0;
  const canEditRelations = isolatedMode
    ? !!selectedEntityName
    : !!selectedEntity && canModifyEntity(selectedEntity) && hasArticleScope;

  const resetRelationForm = () => {
    setAddingRelation(false);
    setNewRelationLabel('');
    setNewRelationTargetKey('');
    setNewRelationOutgoing(true);
    setEditingRelationKey(null);
    setEditRelationLabel('');
    setEditRelationTargetKey('');
    setEditRelationOutgoing(true);
  };

  const startEditRelation = (row: RelationRowView) => {
    setAddingRelation(false);
    setEditingRelationKey(row.key);
    setEditRelationLabel(row.rel.label);
    setEditRelationTargetKey(row.otherKey);
    setEditRelationOutgoing(row.outgoing);
  };

  const findRelationTarget = (key: string) =>
    relationPickerEntities.find((e) => `${e.name}::${e.type ?? ''}` === key) ?? null;

  const handleAddRelation = async () => {
    if (!selectedEntityName || savingRelation) return;
    const target = findRelationTarget(newRelationTargetKey);
    if (!target) {
      showToast('请选择对端实体', 'error');
      return;
    }
    // 方向可选：→ 本实体指向对端；← 对端指向本实体
    const source = newRelationOutgoing
      ? { name: selectedEntityName, type: selectedEntityType }
      : { name: target.name, type: target.type ?? null };
    const targetEnd = newRelationOutgoing
      ? { name: target.name, type: target.type ?? null }
      : { name: selectedEntityName, type: selectedEntityType };
    if (source.name === targetEnd.name && (source.type ?? '') === (targetEnd.type ?? '')) {
      showToast('对端实体不能是自身', 'error');
      return;
    }

    // 单独浏览模式：只修改内存中的载入图（不写数据库、不做权限校验）
    if (isolatedMode) {
      const graph = workingGraph ?? { nodes: [], edges: [] };
      const findNode = (nm: string, tp: string | null | undefined) =>
        graph.nodes.find(
          (n) => n.type === 'entity' && n.label === nm && (n.entity_type ?? '') === (tp ?? ''),
        );
      const srcNode = findNode(source.name, source.type);
      const tgtNode = findNode(targetEnd.name, targetEnd.type);
      if (!srcNode || !tgtNode) {
        showToast('实体不在当前载入图谱中', 'error');
        return;
      }
      const label = newRelationLabel.trim() || '关联';
      if (graph.edges.some(
        (e) => e.source === srcNode.id && e.target === tgtNode.id && e.label === label,
      )) {
        showToast('该关联已存在', 'error');
        return;
      }
      setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
      setWorkingGraph({
        nodes: graph.nodes,
        edges: [...graph.edges, { source: srcNode.id, target: tgtNode.id, label }],
      });
      showToast('关联已添加', 'success');
      resetRelationForm();
      return;
    }

    setSavingRelation(true);
    try {
      await api.createEntityRelation({
        owner_name: selectedEntityName,
        owner_type: selectedEntityType ?? '',
        source_name: source.name,
        source_type: source.type ?? '',
        target_name: targetEnd.name,
        target_type: targetEnd.type ?? '',
        label: newRelationLabel.trim() || '关联',
        article_ids: articleScopeIds,
      });
      showToast('关联已添加', 'success');
      resetRelationForm();
      await loadEntityRelations();
      refetchGraph();
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : '添加关联失败', 'error');
    } finally {
      setSavingRelation(false);
    }
  };

  const handleSaveRelation = async (row: RelationRowView) => {
    if (!selectedEntityName || savingRelation) return;
    // 对端可能不在当前文章实体候选集中（自动抽取的带类型端点）：
    // 编辑表单通过 extraOption 显示了它，保存时也要能解析到，否则只改关系名/
    // 方向都会报“请选择对端实体”。
    const target = findRelationTarget(editRelationTargetKey)
      ?? (row.otherKey === editRelationTargetKey
        ? { name: row.otherName, type: row.otherType, count: 0 }
        : null);
    if (!target) {
      showToast('请选择对端实体', 'error');
      return;
    }
    const rel = row.rel;
    const newLabel = editRelationLabel.trim() || '关联';
    // 方向可切换：→ 本实体指向对端；← 对端指向本实体
    const newSource = editRelationOutgoing
      ? { name: selectedEntityName, type: selectedEntityType }
      : { name: target.name, type: target.type ?? null };
    const newTarget = editRelationOutgoing
      ? { name: target.name, type: target.type ?? null }
      : { name: selectedEntityName, type: selectedEntityType };
    if (newSource.name === newTarget.name && (newSource.type ?? '') === (newTarget.type ?? '')) {
      showToast('对端实体不能是自身', 'error');
      return;
    }
    // 未变化：直接收起表单
    if (
      newSource.name === rel.source_name && (newSource.type ?? '') === (rel.source_type ?? '') &&
      newTarget.name === rel.target_name && (newTarget.type ?? '') === (rel.target_type ?? '') &&
      newLabel === rel.label
    ) {
      setEditingRelationKey(null);
      return;
    }

    // 单独浏览模式：只修改内存中的载入图（不写数据库、不做权限校验）
    if (isolatedMode) {
      const graph = workingGraph ?? { nodes: [], edges: [] };
      const findNode = (nm: string, tp: string | null | undefined) =>
        graph.nodes.find(
          (n) => n.type === 'entity' && n.label === nm && (n.entity_type ?? '') === (tp ?? ''),
        );
      const oldSrc = findNode(rel.source_name, rel.source_type);
      const oldTgt = findNode(rel.target_name, rel.target_type);
      const newSrc = findNode(newSource.name, newSource.type);
      const newTgt = findNode(newTarget.name, newTarget.type);
      if (!oldSrc || !oldTgt || !newSrc || !newTgt) {
        showToast('实体不在当前载入图谱中', 'error');
        return;
      }
      const edges = graph.edges.filter(
        (e) => !(e.source === oldSrc.id && e.target === oldTgt.id && e.label === rel.label),
      );
      if (edges.some(
        (e) => e.source === newSrc.id && e.target === newTgt.id && e.label === newLabel,
      )) {
        showToast('该关联已存在', 'error');
        return;
      }
      setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
      setWorkingGraph({
        nodes: graph.nodes,
        edges: [...edges, { source: newSrc.id, target: newTgt.id, label: newLabel }],
      });
      showToast('关联已更新', 'success');
      resetRelationForm();
      return;
    }

    setSavingRelation(true);
    try {
      const result = await api.updateEntityRelation({
        owner_name: selectedEntityName,
        owner_type: selectedEntityType ?? '',
        source_name: rel.source_name,
        source_type: rel.source_type ?? '',
        target_name: rel.target_name,
        target_type: rel.target_type ?? '',
        old_label: rel.label,
        new_source_name: newSource.name,
        new_source_type: newSource.type ?? '',
        new_target_name: newTarget.name,
        new_target_type: newTarget.type ?? '',
        new_label: newLabel,
        article_ids: articleScopeIds,
      });
      if (result.skipped) {
        showToast(
          `关联已更新（${result.updated} 篇；${result.skipped} 篇保留原关联）`,
          'info',
        );
      } else {
        showToast('关联已更新', 'success');
      }
      resetRelationForm();
      await loadEntityRelations();
      refetchGraph();
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : '修改关联失败', 'error');
    } finally {
      setSavingRelation(false);
    }
  };

  const handleDeleteRelation = async (row: RelationRowView) => {
    if (!selectedEntityName || savingRelation) return;

    // 单独浏览模式：只修改内存中的载入图（不写数据库、不做权限校验）
    if (isolatedMode) {
      const graph = workingGraph ?? { nodes: [], edges: [] };
      const findNode = (nm: string, tp: string | null | undefined) =>
        graph.nodes.find(
          (n) => n.type === 'entity' && n.label === nm && (n.entity_type ?? '') === (tp ?? ''),
        );
      const srcNode = findNode(row.rel.source_name, row.rel.source_type);
      const tgtNode = findNode(row.rel.target_name, row.rel.target_type);
      if (!srcNode || !tgtNode) {
        showToast('关联不在当前载入图谱中', 'error');
        return;
      }
      const edges = graph.edges.filter(
        (e) => !(e.source === srcNode.id && e.target === tgtNode.id && e.label === row.rel.label),
      );
      if (edges.length === graph.edges.length) {
        showToast('关联不在当前载入图谱中', 'error');
        return;
      }
      setGraphHistory((h) => [...h, { graph, graphName: loadedGraphName }]);
      setWorkingGraph({ nodes: graph.nodes, edges });
      showToast('关联已删除', 'success');
      if (editingRelationKey === row.key) resetRelationForm();
      return;
    }

    setSavingRelation(true);
    try {
      await api.deleteEntityRelation({
        owner_name: selectedEntityName,
        owner_type: selectedEntityType ?? '',
        source_name: row.rel.source_name,
        source_type: row.rel.source_type ?? '',
        target_name: row.rel.target_name,
        target_type: row.rel.target_type ?? '',
        label: row.rel.label,
        article_ids: articleScopeIds,
      });
      showToast('关联已删除', 'success');
      if (editingRelationKey === row.key) resetRelationForm();
      await loadEntityRelations();
      refetchGraph();
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : '删除关联失败', 'error');
    } finally {
      setSavingRelation(false);
    }
  };

  // 关联信息动态加载：每次展示 10 条，点击「加载更多」再追加 10 条。
  // 用 key（name+type）同步重置批次，避免切换实体时先闪现上一实体已展开的条数。
  const relationKey = `${selectedEntityName ?? ''}::${selectedEntityType ?? ''}`;
  const [relationLoad, setRelationLoad] = useState({ key: relationKey, count: RELATION_BATCH });
  const relationVisibleCount =
    relationLoad.key === relationKey ? relationLoad.count : RELATION_BATCH;
  const loadMoreRelations = () => {
    setRelationLoad({ key: relationKey, count: relationVisibleCount + RELATION_BATCH });
  };

  // ── D3 graph refs ──
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const graphSvgRef = useRef<SVGSVGElement>(null);
  const graphTooltipRef = useRef<HTMLDivElement>(null);
  // 导出/载入：D3 状态读取函数引用 + 隐藏的 JSON 文件选择器
  const getGraphPositionsRef = useRef<(() => Map<string, { x: number; y: number }>) | null>(null);
  const getGraphViewportRef = useRef<(() => { x: number; y: number; k: number }) | null>(null);
  const graphFileInputRef = useRef<HTMLInputElement>(null);
  // 载入文件的句柄（仅通过 showOpenFilePicker 载入时可写）：保存时原地更新该文件
  const graphFileHandleRef = useRef<GraphFileHandle | null>(null);

  // 图谱右上角文件菜单（载入 / 保存 / 截图）
  const [graphMenuOpen, setGraphMenuOpen] = useState(false);
  const [graphMenuPos, setGraphMenuPos] = useState<{ top: number; left: number } | null>(null);
  const graphMenuBtnRef = useRef<HTMLButtonElement>(null);
  const graphMenuRef = useRef<HTMLDivElement>(null);
  // 本次会话使用过的图谱名称（新建时避免重名，按导出命名追加序号）
  const graphNamesRef = useRef<Set<string>>(new Set());
  const closeGraphMenu = () => setGraphMenuOpen(false);

  const toggleGraphMenu = () => {
    if (graphMenuOpen) {
      setGraphMenuOpen(false);
      return;
    }
    const rect = graphMenuBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 168;
      const left = Math.min(
        Math.max(8, rect.right - width),
        window.innerWidth - width - 8,
      );
      setGraphMenuPos({ top: rect.bottom + 4, left });
    }
    setGraphMenuOpen(true);
  };

  // 点击外部 / 滚动 / 尺寸变化时关闭菜单
  useEffect(() => {
    if (!graphMenuOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (graphMenuBtnRef.current?.contains(t) || graphMenuRef.current?.contains(t)) return;
      setGraphMenuOpen(false);
    };
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && graphMenuRef.current?.contains(t)) return;
      setGraphMenuOpen(false);
    };
    const onResize = () => setGraphMenuOpen(false);
    // 捕获阶段监听：图谱 SVG 的 d3 zoom 会在 mousedown 时 stopImmediatePropagation，
    // 冒泡阶段监听收不到事件，导致点击图区域菜单不关闭
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, { passive: true, capture: true });
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [graphMenuOpen]);

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

  // ── 列表⇄图谱联动 ──
  // 聚焦实体 = 图谱聚焦中心：以其为中心的一层关系子图（BFS 深度 1，力导向居中显示）
  const focusSubgraph = useMemo(() => {
    if (!focusEntity || !graphData) return null;
    const { name, type } = focusEntity;
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));
    // 起始节点匹配：精确 id 优先，兼容旧数据（entity:{name}:: / entity:{name}）
    let startId: string | null = null;
    for (const id of [`entity:${name}::${type ?? ''}`, `entity:${name}::`, `entity:${name}`]) {
      if (nodeMap.has(id)) { startId = id; break; }
    }
    if (!startId) return null;
    const adj = new Map<string, string[]>();
    const addAdj = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push(b);
    };
    for (const e of graphData.edges) {
      addAdj(e.source, e.target);
      addAdj(e.target, e.source);
    }
    // BFS 一层关系
    const visible = new Set<string>([startId]);
    let frontier = [startId];
    for (let depth = 0; depth < 1 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!visible.has(nb)) { visible.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return {
      focusNodeId: startId,
      nodes: graphData.nodes.filter((n) => visible.has(n.id)),
      edges: graphData.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
    };
  }, [graphData, focusEntity]);

  // 图谱显示数据：工作图（展开/清除/撤销结果）优先，否则聚焦子图 / 按选中文章过滤
  const baseGraph = focusEntity ? focusSubgraph : filteredGraph;
  const displayGraph = workingGraph ?? baseGraph;
  // 异步操作（展开）恢复时用于判断视图是否已被切换/载入/撤销，避免用旧图覆盖新状态
  const displayGraphRef = useRef(displayGraph);
  displayGraphRef.current = displayGraph;

  // 基准图签名（与顺序无关）：切换文章范围/实体聚焦、或图谱数据刷新后，
  // 丢弃旧的工作图快照与历史，避免展开后的 workingGraph 长期遮蔽新的基准数据
  // （例如删除关联后画布仍显示旧边、切换文章后仍显示上一篇文章的图）。
  // 单独浏览模式的 workingGraph 是载入文件本身，不能因文章/图谱数据变化被清掉。
  const baseGraphKey = useMemo(() => {
    if (!baseGraph) return '';
    const nodePart = baseGraph.nodes
      .map((n) => `${n.id}\u0001${n.label}\u0001${n.entity_type ?? ''}`)
      .sort()
      .join('\u0002');
    const edgePart = baseGraph.edges
      .map((e) => `${e.source}\u0001${e.target}\u0001${e.label}`)
      .sort()
      .join('\u0002');
    return `${nodePart}\u0003${edgePart}`;
  }, [baseGraph]);
  const baseGraphKeyRef = useRef(baseGraphKey);
  useEffect(() => {
    // 以 loadedGraphName（而非仅当前视图模式）为准：切到列表模式时载入图仍应保留
    if (loadedGraphName !== null) return;
    if (baseGraphKeyRef.current === baseGraphKey) return;
    baseGraphKeyRef.current = baseGraphKey;
    setWorkingGraph(null);
    setGraphHistory([]);
  }, [baseGraphKey, loadedGraphName]);

  // ── 单独浏览模式的实体列表：直接取自载入的图谱（不依赖当前文章）──
  const isolatedEntities = useMemo<EntityInfo[]>(() => {
    if (!isolatedMode || !displayGraph) return [];
    const degree = new Map<string, number>();
    for (const e of displayGraph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const byKey = new Map<string, EntityInfo>();
    for (const n of displayGraph.nodes) {
      if (n.type !== 'entity') continue;
      const type = n.entity_type ?? '';
      const key = `${n.label}::${type}`;
      if (!byKey.has(key)) {
        byKey.set(key, { name: n.label, type, count: degree.get(n.id) ?? 0 });
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.type ?? '').localeCompare(b.type ?? ''),
    );
  }, [isolatedMode, displayGraph]);

  // 实体列表数据源：单独浏览模式下来自载入图谱，否则来自当前筛选文章的实体
  const listEntities = isolatedMode ? isolatedEntities : entities;
  const filteredEntities = useMemo(() => {
    const q = entitySearch.trim().toLowerCase();
    if (!q) return listEntities;
    return listEntities.filter(
      (e) => e.name.toLowerCase().includes(q) || (e.type ?? '').toLowerCase().includes(q),
    );
  }, [listEntities, entitySearch]);
  const visibleEntities = filteredEntities.slice(0, visibleCount);

  // 图谱点击可能选中不在文章实体列表中的实体（展开引入的邻居节点）。
  // 列表里没有对应行时追加一个虚拟行，保证信息面板/关联区域仍能显示。
  const graphSelectedEntity = useMemo<EntityInfo | null>(() => {
    if (!selectedEntityName) return null;
    const inList = listEntities.some(
      (e) => e.name === selectedEntityName && (e.type ?? null) === selectedEntityType,
    );
    if (inList) return null;
    return { name: selectedEntityName, type: selectedEntityType ?? undefined, count: 0 };
  }, [selectedEntityName, selectedEntityType, listEntities]);
  const listRows = graphSelectedEntity
    ? [...visibleEntities, graphSelectedEntity]
    : visibleEntities;

  // Toggle entity selection — expand/collapse info panel
  // 同名不同类型视为不同实体：按 (name, type) 区分选中行；附加信息按名字加载（后端以名字为键）
  const handleEntitySelect = useCallback(async (ent: EntityInfo, ctrl = false) => {
    const isSelected = selectedEntityName === ent.name && selectedEntityType === (ent.type ?? null);

    // 单独浏览模式：实体列表仅与图谱联动 —— 不通知父级筛选文章、不改变源实体/聚焦
    if (isolatedMode) {
      const nodeId = displayGraph?.nodes.find(
        (n) => n.type === 'entity' && n.label === ent.name && (n.entity_type ?? '') === (ent.type ?? ''),
      )?.id;
      if (nodeId) {
        // 与图谱节点点击一致：普通点击切换该节点选中
        onGraphNodeClick?.(nodeId, 'entity', ent.name, false);
        setSelectedGraphNodeId(isSelected ? null : nodeId);
      }
      if (isSelected) {
        setSelectedEntityName(null);
        setSelectedEntityType(null);
        setEntityInfos([]);
        setAddingInfo(false);
        setEditingInfoId(null);
        return;
      }
      setSelectedEntityName(ent.name);
      setSelectedEntityType(ent.type ?? null);
      setAddingInfo(false);
      setEditingInfoId(null);
      // 单独浏览模式只读载入图：附加信息在数据库中，与载入文件无关，不加载也不编辑
      setEntityInfos([]);
      return;
    }

    // Notify parent (ArticleList) for article filtering — 传递 (name, type)
    onEntitySelect?.(ent.name, ent.type ?? '其他', ctrl);

    if (isSelected) {
      // 取消选中：若图谱当前节点正是该实体节点，一并清除其高亮
      const entNodeIds = [
        `entity:${ent.name}::${ent.type ?? ''}`,
        `entity:${ent.name}::`,
        `entity:${ent.name}`,
      ];
      setSelectedGraphNodeId((curId) => (curId && entNodeIds.includes(curId) ? null : curId));
      clearEntitySelection();
    } else {
      setSelectedEntityName(ent.name);
      setSelectedEntityType(ent.type ?? null);
      // 列表点击选中 → 图谱聚焦该实体（图谱内点击不改变聚焦）
      setFocusEntity({ name: ent.name, type: ent.type ?? null });
      setAddingInfo(false);
      setEditingInfoId(null);
      await loadEntityInfos(ent.name);
    }
  }, [
    isolatedMode,
    displayGraph,
    selectedEntityName,
    selectedEntityType,
    onGraphNodeClick,
    loadEntityInfos,
    onEntitySelect,
    clearEntitySelection,
  ]);

  // 图操作的目标：图谱内选中的节点集（普通点击单选、Ctrl+点击多选）
  // 无节点选中时展开/移除灰显
  const selectedNodeIds = selectedGraphNodeIds ?? new Set<string>();
  const hasNodeSelection = selectedNodeIds.size > 0;

  // ── 展开：选中节点集 n 层关系（Neo4j 直查全量），并入当前视图 ──
  const handleExpand = async () => {
    const targets = Array.from(selectedNodeIds);
    if (targets.length === 0) return;
    // 实体节点按当前标签/类型解析 id：单独浏览模式下实体可改名/改类型，节点 id 可能仍是旧值
    const nodeById = new Map((displayGraph?.nodes ?? []).map((n) => [n.id, n]));
    const resolved = new Set<string>();
    for (const id of targets) {
      const n = nodeById.get(id);
      resolved.add(n && n.type === 'entity' ? `entity:${n.label}::${n.entity_type ?? ''}` : id);
    }
    setExpanding(true);
    // 请求期间用户可能切换聚焦实体/载入文件/撤销：以发起时的图为基准并在
    // 恢复时校验视图身份，避免旧结果覆盖新视图和写入过期历史快照。
    const requestBase = displayGraph;
    try {
      const results = await Promise.all(
        Array.from(resolved).map((nodeId) => api.expandGraph(nodeId, expandDepth).catch(() => null)),
      );
      if (displayGraphRef.current !== requestBase) {
        showToast('图谱已切换，已取消本次展开', 'info');
        return;
      }
      // 全部无结果 → 提示后返回
      if (results.every((d) => !d || d.nodes.length === 0)) {
        showToast('所选节点没有可展开的关联（Neo4j 中无数据）', 'info');
        return;
      }
      const base = requestBase ?? { nodes: [], edges: [] };
      const nodeMap = new Map(base.nodes.map((n) => [n.id, n]));
      const edgeKeys = new Set(base.edges.map((e) => `${e.source}|${e.target}|${e.label}`));
      const nodes = [...base.nodes];
      const edges = [...base.edges];
      let addedNodes = 0;
      let addedEdges = 0;
      for (const data of results) {
        if (!data) continue;
        for (const n of data.nodes) {
          if (!nodeMap.has(n.id)) {
            nodeMap.set(n.id, n);
            nodes.push(n);
            addedNodes++;
          }
        }
        for (const e of data.edges) {
          const key = `${e.source}|${e.target}|${e.label}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push(e);
            addedEdges++;
          }
        }
      }
      setGraphHistory((h) => [...h, { graph: base, graphName: loadedGraphName }]);
      setWorkingGraph({ nodes, edges });
      showToast(`已展开 ${addedNodes} 个节点 / ${addedEdges} 条边`, 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : '展开失败', 'error');
    } finally {
      setExpanding(false);
    }
  };

  // ── 移除：从图中移除选中的多个节点及其关系（仅视图操作，不动数据库）──
  const handleRemoveNodes = () => {
    const targets = new Set(selectedNodeIds);
    if (targets.size === 0) return;
    const base = displayGraph;
    if (!base || !base.nodes.some((n) => targets.has(n.id))) return;
    setGraphHistory((h) => [...h, { graph: base, graphName: loadedGraphName }]);
    setWorkingGraph({
      nodes: base.nodes.filter((n) => !targets.has(n.id)),
      edges: base.edges.filter((e) => !targets.has(e.source) && !targets.has(e.target)),
    });
    // 被移除的节点已不在图中 → 清空选中（按钮随之灰显）
    setSelectedGraphNodeId(null);
    onClearAllSelections?.();
    showToast(`已移除 ${targets.size} 个节点及其关系`, 'success');
  };

  // ── 撤销：恢复上一步图状态（历史清空后回到基准图）──
  const handleUndo = () => {
    if (graphHistory.length === 0) return;
    const prev = graphHistory[graphHistory.length - 1];
    setGraphHistory((h) => h.slice(0, -1));
    // 总是还原到上一步快照及其载入图谱名称：
    // 单独浏览模式下最后一步是载入图内的编辑，撤销后仍应停留在该模式
    setWorkingGraph(prev.graph);
    setLoadedGraphName(prev.graphName);
    showToast('已撤销上一步操作', 'info');
  };

  // Merge selection into selected node IDs for visual highlighting
  // 源实体只以顶部标签方式记录，不参与选中高亮 —— 取消全部选中后不恢复源实体选中
  const mergedSelectedNodeIds = useMemo(() => {
    const base = new Set(selectedGraphNodeIds ?? []);
    // 图谱内最后点击的节点高亮（展开/移除的操作对象）
    if (selectedGraphNodeId) {
      base.add(selectedGraphNodeId);
    }
    return base;
  }, [selectedGraphNodeIds, selectedGraphNodeId]);

  // ── Entity info cache for tooltip display ──
  const entityInfoMapRef = useRef<Map<string, { name: string; content: string }[]>>(new Map());

  // Pre-fetch entity infos for entity nodes visible in the graph
  // 单独浏览模式不查询数据库：载入图实体可能只是文件里的同名实体
  useEffect(() => {
    if (mode !== 'graph' || !displayGraph || isolatedMode) return;
    const entityNodes = displayGraph.nodes.filter((n) => n.type === 'entity');
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
  }, [displayGraph, mode, isolatedMode]);

  // ── D3 graph via shared hook ──
  useD3ForceGraph(graphContainerRef, graphSvgRef, graphTooltipRef, 'inline', {
    graph: displayGraph,
    entityTypeMap,
    entityInfoMap: entityInfoMapRef.current,
    focusNodeId: focusSubgraph?.focusNodeId,
    // 新节点在最后点击的节点附近进入，而非全部从中心冒出
    anchorNodeId: selectedGraphNodeId,
    // 导出/载入：位置/视口读取与一次性恢复
    getPositionsRef: getGraphPositionsRef,
    getViewportRef: getGraphViewportRef,
    initialPositions: loadedPositions,
    initialViewport: loadedViewport,
    onNodeClick: (id, type, label, ctrl) => {
      // 目录/文章/实体节点统一处理：点击切换选中状态，Ctrl+点击多选
      // 源实体（实体列表选中实体）只由列表点击驱动，图谱点击不改变源实体/聚焦
      const cur = selectedGraphNodeIds ?? new Set<string>();
      const staysSelected = !cur.has(id);
      setSelectedGraphNodeId(staysSelected ? id : null);
      onGraphNodeClick?.(id, type, label, ctrl);

      // 实体节点普通点击 → 联动实体列表（行选中 + 信息面板；不改变源实体，图谱不重载）
      if (type === 'entity' && !ctrl) {
        // 类型优先取节点数据：单独浏览模式改名/改类型后节点 id 仍是旧值，
        // 从 id 解析会得到旧类型，导致列表行/信息面板匹配不上。
        const node = displayGraph?.nodes.find((n) => n.id === id);
        const etype = node?.type === 'entity'
          ? (node.entity_type ?? '')
          : (id.startsWith('entity:') ? id.slice('entity:'.length).split('::')[1] || '' : '');
        if (staysSelected) {
          if (selectedEntityName === label && (selectedEntityType ?? '') === etype) return;
          selectFromGraphRef.current = true;
          setEntitySearch('');   // 清除筛选，保证选中行可见
          setAddingInfo(false);
          setEditingInfoId(null);
          setSelectedEntityName(label);
          setSelectedEntityType(etype);
          if (!isolatedMode) loadEntityInfos(label);
          // 展开分批到该实体所在位置（跳过分批重置见 visibleCount effect）；
          // 同名不同类型是不同实体，必须同时比较类型
          const idx = listEntities.findIndex(
            (e) => e.name === label && (e.type ?? '') === etype,
          );
          if (idx >= 0) setVisibleCount((c) => Math.max(c, idx + 1));
        } else if (selectedEntityName === label && (selectedEntityType ?? '') === etype) {
          // 取消选中：仅清除列表选中（源实体/聚焦保留，图谱不重载）
          setSelectedEntityName(null);
          setSelectedEntityType(null);
          setEntityInfos([]);
          setAddingInfo(false);
          setEditingInfoId(null);
        }
      }
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

  // ── 保存 / 载入图谱数据（JSON：结构 + 节点位置 + 视口，可再次载入还原布局）──
  const buildGraphDataPayload = useCallback(() => {
    if (!displayGraph || displayGraph.nodes.length === 0) return null;
    const positions = getGraphPositionsRef.current?.() ?? new Map<string, { x: number; y: number }>();
    const viewport = getGraphViewportRef.current?.();
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      viewport,
      nodes: displayGraph.nodes.map((n) => {
        const p = positions.get(n.id);
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          url: n.url,
          color: n.color ?? null,
          entity_type: n.entity_type ?? null,
          ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}),
        };
      }),
      edges: displayGraph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
    };
  }, [displayGraph]);

  // 保存：打开保存对话框，配置位置与文件名后写入（保存/另存为已归并为一项）。
  // 支持文件句柄的浏览器可直接选择覆盖原文件；其他浏览器回退为下载。
  const handleSaveGraphData = useCallback(async () => {
    const payload = buildGraphDataPayload();
    if (!payload) return;

    let handle: GraphFileHandle | null = null;
    const savePicker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
    if (typeof savePicker === 'function') {
      const baseName = loadedGraphName ?? `知识图谱_${new Date().toISOString().slice(0, 10)}`;
      try {
        handle = await savePicker({
          suggestedName: `${baseName}.json`,
          types: [{ description: '知识图谱 JSON', accept: { 'application/json': ['.json'] } }],
        });
        graphFileHandleRef.current = handle;
      } catch (err) {
        // 用户取消保存 → 不动作；其他错误回退为下载
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }

    let writeFailed = false;
    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
        // 保存/另存为时若文件名有变，图谱名称同步（顶部标签、后续保存提示随之更新）
        const savedName = handle.name.replace(/\.json$/i, '');
        if (isolatedMode && savedName && savedName !== loadedGraphName) {
          graphNamesRef.current.add(savedName);
          setLoadedGraphName(savedName);
        }
        showToast(`已保存文件「${handle.name}」`, 'success');
        return;
      } catch {
        writeFailed = true;
      }
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const fallbackName = `知识图谱_${new Date().toISOString().slice(0, 10)}`;
    // 有图谱名称（载入/新建）时沿用该名称，否则使用导出默认命名
    a.download = `${loadedGraphName ?? fallbackName}.json`;
    a.click();
    URL.revokeObjectURL(url);
    if (writeFailed) {
      showToast('更新打开的文件失败，已改为下载副本', 'error');
    } else {
      showToast('图谱数据已保存', 'success');
    }
  }, [buildGraphDataPayload, isolatedMode, loadedGraphName, showToast]);

  // 新建空白图谱：名称沿用导出命名（知识图谱_日期），重名追加序号；
  // 创建后进入单独浏览模式，可自由添加实体与关联。
  const handleCreateNewGraph = () => {
    closeGraphMenu();
    const base = `知识图谱_${new Date().toISOString().slice(0, 10)}`;
    let name = base;
    let seq = 2;
    while (graphNamesRef.current.has(name)) {
      name = `${base}_${seq++}`;
    }
    graphNamesRef.current.add(name);
    // 新图谱尚未保存为文件：清空可写句柄与撤销历史
    graphFileHandleRef.current = null;
    // 单独浏览模式不展示数据库中的实体附加信息，清空工具提示缓存
    entityInfoMapRef.current.clear();
    setGraphHistory([]);
    setWorkingGraph({ nodes: [], edges: [] });
    setLoadedGraphName(name);
    setLoadedPositions(null);
    setLoadedViewport(null);
    setSelectedGraphNodeId(null);
    setSelectedEntityName(null);
    setSelectedEntityType(null);
    setEntityInfos([]);
    setAddingInfo(false);
    setEditingInfoId(null);
    onClearAllSelections?.();
    showToast(`已新建图谱「${name}」`, 'success');
  };

  // 载入：优先用文件选择器获取可写句柄（Chrome/Edge），使「保存」能原地更新文件；
  // 不支持时回退到普通 file input（保存只能下载副本）
  const handleLoadGraphClick = async () => {
    const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
    if (typeof picker === 'function') {
      try {
        const handles = await picker({
          multiple: false,
          types: [{ description: '知识图谱 JSON', accept: { 'application/json': ['.json'] } }],
        });
        const handle = handles[0];
        if (handle) {
          const file = await handle.getFile();
          await applyGraphFile(file, handle);
        }
        return;
      } catch (err) {
        // 用户取消选择 → 不处理；其他错误回退到 input 选择
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    graphFileInputRef.current?.click();
  };

  const handleGraphFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许再次选择同一文件
    if (!file) return;
    await applyGraphFile(file, null);
  };

  const applyGraphFile = async (file: File, handle: GraphFileHandle | null) => {
    try {
      const data = JSON.parse(await file.text()) as {
        version?: unknown;
        nodes?: unknown;
        edges?: unknown;
        viewport?: unknown;
      };
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('文件格式无效（缺少 nodes/edges 数组）');
      }
      const validTypes = new Set(['article', 'category', 'entity']);
      const nodes: GraphNode[] = [];
      const seenNodeIds = new Set<string>();
      for (const raw of data.nodes) {
        const n = raw as Record<string, unknown> | null;
        if (!n || typeof n.id !== 'string' || typeof n.label !== 'string' || typeof n.type !== 'string') continue;
        if (!validTypes.has(n.type) || seenNodeIds.has(n.id)) continue;
        seenNodeIds.add(n.id);
        nodes.push({
          id: n.id,
          label: n.label,
          type: n.type as GraphNode['type'],
          url: typeof n.url === 'string' ? n.url : '',
          color: typeof n.color === 'string' ? n.color : null,
          entity_type: typeof n.entity_type === 'string' ? n.entity_type : null,
        });
      }
      if (nodes.length === 0) throw new Error('文件中没有有效节点');

      const edgeKeys = new Set<string>();
      const edges: GraphEdge[] = [];
      for (const raw of data.edges) {
        const e = raw as Record<string, unknown> | null;
        if (!e || typeof e.source !== 'string' || typeof e.target !== 'string' || typeof e.label !== 'string') continue;
        // 端点必须存在于文件节点中，否则丢弃
        if (!seenNodeIds.has(e.source) || !seenNodeIds.has(e.target)) continue;
        const key = `${e.source}|${e.target}|${e.label}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ source: e.source, target: e.target, label: e.label });
      }

      // 节点位置：载入后钉在导出位置，还原布局
      const posMap = new Map<string, { x: number; y: number }>();
      for (const raw of data.nodes) {
        const n = raw as Record<string, unknown> | null;
        if (!n || typeof n.id !== 'string' || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        posMap.set(n.id, { x: n.x, y: n.y });
      }

      // 视口（缩放/平移）：载入后还原
      let viewport: { x: number; y: number; k: number } | null = null;
      const v = data.viewport as Record<string, unknown> | null;
      if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.k === 'number'
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.k) && v.k > 0) {
        viewport = { x: v.x, y: v.y, k: v.k };
      }

      // 单独浏览模式：进入时重置撤销历史——撤销只回退载入图内的编辑，不会退回载入前的图
      setGraphHistory([]);
      // 记录可写文件句柄（文件选择器载入时）：保存按钮原地更新该文件
      graphFileHandleRef.current = handle;
      // 单独浏览模式不展示数据库中的实体附加信息，清空工具提示缓存
      entityInfoMapRef.current.clear();
      setWorkingGraph({ nodes, edges });
      const loadedName = file.name.replace(/\.json$/i, '');
      graphNamesRef.current.add(loadedName);
      setLoadedGraphName(loadedName);
      setLoadedPositions(posMap.size > 0 ? posMap : null);
      setLoadedViewport(viewport);
      // 清除旧选中（图谱节点/实体列表选中/信息面板）；源实体（focusEntity）保留
      setSelectedGraphNodeId(null);
      setSelectedEntityName(null);
      setSelectedEntityType(null);
      setEntityInfos([]);
      setAddingInfo(false);
      setEditingInfoId(null);
      onClearAllSelections?.();
      showToast(`已打开图谱（${nodes.length} 节点 / ${edges.length} 边）`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? `打开失败：${err.message}` : '打开失败', 'error');
    }
  };

  // 关闭载入图谱标签 → 退出单独浏览模式，回到当前文章的图谱
  const handleExitIsolatedMode = () => {
    setWorkingGraph(null);
    setLoadedGraphName(null);
    setGraphHistory([]);
    graphFileHandleRef.current = null;
    setLoadedPositions(null);
    setLoadedViewport(null);
    setSelectedGraphNodeId(null);
    setSelectedEntityName(null);
    setSelectedEntityType(null);
    setEntityInfos([]);
    setAddingInfo(false);
    setEditingInfoId(null);
    onClearAllSelections?.();
    showToast('已退出单独浏览模式', 'info');
  };


  // ── Render ──
  // 列表标题行：新增/修改/删除按钮 + 实体计数（列表与图谱模式共用）
  const renderListHeader = () => (
    <div className={styles.header}>
      <h4>实体列表</h4>
      <div className={styles.headerActions}>
        <button
          className={styles.headerAddBtn}
          disabled={!isolatedMode && selectedArticleIds.length === 0}
          onClick={() => setAdding(true)}
          title={isolatedMode
            ? '添加实体到当前载入图谱'
            : selectedArticleIds.length === 0 ? '请先选择文章' : '新增实体'}
          aria-label="新增实体"
        >
          +
        </button>
        {/* 修改 / 删除作用于选中实体（信息面板展开的实体），替代原每行的操作按钮。
            单独浏览模式下仅改载入图，不做权限校验。 */}
        <button
          className={styles.headerAddBtn}
          disabled={!selectedEntity || (!isolatedMode && !canModifyEntity(selectedEntity))}
          onClick={handleEditSelected}
          title={isolatedMode
            ? (selectedEntity ? `修改实体「${selectedEntity.name}」（仅当前载入图谱）` : '请先在列表中选中一个实体')
            : selectedEntity
              ? (canModifyEntity(selectedEntity) ? `修改实体「${selectedEntity.name}」` : '无权限修改该实体')
              : '请先在列表中选中一个实体'}
          aria-label="修改实体"
        >
          ✎
        </button>
        <button
          className={`${styles.headerAddBtn} ${styles.headerDeleteBtn}`}
          disabled={!selectedEntity || (!isolatedMode && !canModifyEntity(selectedEntity))}
          onClick={handleDeleteSelected}
          title={isolatedMode
            ? (selectedEntity ? `删除实体「${selectedEntity.name}」（仅当前载入图谱）` : '请先在列表中选中一个实体')
            : selectedEntity
              ? (canModifyEntity(selectedEntity) ? `删除实体「${selectedEntity.name}」` : '无权限删除该实体')
              : '请先在列表中选中一个实体'}
          aria-label="删除实体"
        >
          ✕
        </button>
      </div>
      <div className={styles.headerRight}>
        <span className={styles.count}>
          {entitySearch
            ? `${filteredEntities.length}/${listEntities.length} 个实体`
            : `${listEntities.length} 个`}
        </span>
      </div>
    </div>
  );

  // 知识图谱标题行：源实体文本 + 载入图谱标签（可关闭）+ 统计右上角
  const renderGraphHeader = () => (
    <div className={styles.header}>
      <h4>知识图谱</h4>
      {/* 单独浏览模式不显示源实体（载入图谱与当前文章无关） */}
      {focusEntity && !isolatedMode && (
        <span className={styles.sourceText} title={`源实体：${focusEntity.name}`}>
          🎯 {focusEntity.name}
        </span>
      )}
      {loadedGraphName && (
        <span className={styles.loadedGraphTag} title={`单独浏览：${loadedGraphName}`}>
          <span className={styles.loadedGraphName}>🗺️ {loadedGraphName}</span>
          <button
            type="button"
            className={styles.loadedGraphTagClose}
            onClick={handleExitIsolatedMode}
            title="关闭标签并退出单独浏览模式"
            aria-label="退出单独浏览模式"
          >✕</button>
        </span>
      )}
      <div className={styles.headerRight}>
        {displayGraph && (
          <span className={styles.count}>
            {displayGraph.nodes.filter(n => n.type === 'article').length}文 · {displayGraph.nodes.filter(n => n.type === 'entity').length}实体 · {displayGraph.edges.length}关系
          </span>
        )}
        {/* 右上角文件操作菜单：载入 / 保存 / 截图 */}
        <button
          ref={graphMenuBtnRef}
          type="button"
          className={styles.graphMenuBtn}
          onClick={toggleGraphMenu}
          title="图谱文件操作（打开 / 保存 / 截图）"
          aria-label="图谱文件操作"
          aria-expanded={graphMenuOpen}
        >
          ⋯
        </button>
      </div>
      {graphMenuOpen && graphMenuPos && createPortal(
        <div
          ref={graphMenuRef}
          className={styles.graphMenu}
          style={{ top: graphMenuPos.top, left: graphMenuPos.left }}
        >
          <button
            type="button"
            className={styles.graphMenuItem}
            title="新建空白图谱（名称按导出命名追加序号），并进入单独浏览模式"
            onClick={handleCreateNewGraph}
          >
            <span className={styles.graphMenuItemIcon}>🆕</span> 新建图谱
          </button>
          <button
            type="button"
            className={styles.graphMenuItem}
            title="从 JSON 文件打开图谱（恢复节点与布局位置）"
            onClick={() => { closeGraphMenu(); void handleLoadGraphClick(); }}
          >
            <span className={styles.graphMenuItemIcon}>📂</span> 打开图谱
          </button>
          <button
            type="button"
            className={styles.graphMenuItem}
            disabled={!displayGraph || displayGraph.nodes.length === 0}
            title="保存图谱：选择保存位置和文件名（含节点位置与视口，可再次打开）"
            onClick={() => { closeGraphMenu(); void handleSaveGraphData(); }}
          >
            <span className={styles.graphMenuItemIcon}>💾</span> 保存图谱
          </button>
          <button
            type="button"
            className={styles.graphMenuItem}
            disabled={!displayGraph || displayGraph.nodes.length === 0}
            title="截图导出为 PNG 图片"
            onClick={() => { closeGraphMenu(); void handleExportGraph(); }}
          >
            <span className={styles.graphMenuItemIcon}>🖼</span> 截图
          </button>
        </div>,
        document.body,
      )}
    </div>
  );

  // 实体列表内容（搜索 + 新增行 + 列表；图谱模式下作为左栏保持可见）
  const renderEntityListContent = () => (
    <>
      <div className={styles.entitySearchWrap}>
            <span className={styles.entitySearchIcon}>
              {/* 筛选漏斗图标 */}
              <svg
                width="13"
                height="13"
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
              className={styles.entitySearchInput}
              value={entitySearch}
              onChange={(e) => setEntitySearch(e.target.value)}
              placeholder="实体筛选…"
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
            {listRows.map((ent) => (
              <div key={`${ent.name}::${ent.type}`}>
                {editingEntityName === ent.name && editingEntityType === (ent.type ?? null) ? (
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
                    <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => { setEditingEntityName(null); setEditingEntityType(null); }}>✕</button>
                  </div>
                ) : (
                  /* ── Read-only mode ── */
                  <div
                    className={`${styles.item} ${selectedEntityName === ent.name && selectedEntityType === (ent.type ?? null) ? styles.itemSelected : ''}`}
                    ref={(el) => {
                      const key = `${ent.name}::${ent.type ?? null}`;
                      if (el) entityRowElsRef.current.set(key, el);
                      else entityRowElsRef.current.delete(key);
                    }}
                  >
                    <button
                      className={styles.itemClickArea}
                      onClick={(e) => handleEntitySelect(ent, e.ctrlKey || e.metaKey)}
                      title={(ent as any).created_by
                        ? `类型：${ent.type}\n创建人：${(ent as any).created_by?.replace(/\s+\d{18}$/, '') ?? '未知'}`
                        : `类型：${ent.type}`}
                    >
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{entityIcon(ent.type)}</span>
                      <span
                        className={styles.tagName}
                        style={{ color: '#7D5DA9' }}
                        title={`名称：${ent.name}\n类型：${ent.type}${(ent as any).created_by
                          ? `\n创建人：${(ent as any).created_by?.replace(/\s+\d{18}$/, '') ?? '未知'}`
                          : ''}`}
                      >
                        {ent.name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--c-text-muted)', marginLeft: 4, flexShrink: 0 }}>{ent.type}</span>
                    </button>
                    {/* 每行的修改/删除按钮已上移至顶部（作用于选中实体） */}
                    <span className={styles.tagCount}>{ent.count}</span>
                  </div>
                )}

                {/* ── Additional Info Panel ── */}
                {selectedEntityName === ent.name && selectedEntityType === (ent.type ?? null) && (
                  <div className={styles.infoPanel}>
                    {/* 附加信息存 SQLite：单独浏览模式只读载入图，不显示也不编辑 */}
                    {!isolatedMode && (loadingInfos ? (
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
                    ))}

                    {/* ── Add new info ── */}
                    {!isolatedMode && (addingInfo ? (
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
                    ))}

                    {/* ── 关联信息：该实体与其他实体的关系（Neo4j RELATES 边，可增删改）── */}
                    <div className={styles.relationsBlock}>
                      <div className={styles.relationsHeader}>
                        <span className={styles.relationsTitle}>关联信息</span>
                        {canEditRelations ? (
                          <button
                            type="button"
                            className={styles.relationsAddBtn}
                            title={addingRelation ? '取消添加' : '添加关联'}
                            onClick={() => {
                              if (addingRelation) resetRelationForm();
                              else {
                                setEditingRelationKey(null);
                                setAddingRelation(true);
                              }
                            }}
                          >
                            {addingRelation ? '取消' : '＋ 添加关联'}
                          </button>
                        ) : (
                          !hasArticleScope && (
                            <span className={styles.relationsHint}>选择文章后可编辑</span>
                          )
                        )}
                      </div>
                      {loadingRelations ? (
                        <div className={styles.relationsEmpty}>加载中…</div>
                      ) : relationRows.length === 0 ? (
                        <div className={styles.relationsEmpty}>暂无关联</div>
                      ) : (
                        <>
                          {relationRows.slice(0, relationVisibleCount).map((row) =>
                            editingRelationKey === row.key ? (
                              <div key={row.key} className={styles.relationEditForm}>
                                <button
                                  type="button"
                                  className={styles.relationDirBtn}
                                  title="切换方向"
                                  onClick={() => setEditRelationOutgoing((v) => !v)}
                                >{editRelationOutgoing ? '→' : '←'}</button>
                                <input
                                  className={styles.relationEditInput}
                                  value={editRelationLabel}
                                  onChange={(e) => setEditRelationLabel(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveRelation(row);
                                    if (e.key === 'Escape') resetRelationForm();
                                  }}
                                  placeholder="关系名称"
                                />
                                <RelationTargetPicker
                                  options={relationTargetOptions}
                                  value={editRelationTargetKey}
                                  onChange={setEditRelationTargetKey}
                                  placeholder="选择对端…"
                                  extraOption={row.otherKey
                                    ? { key: row.otherKey, name: row.otherName, type: row.otherType }
                                    : null}
                                />
                                <button
                                  className={`${styles.editBtn} ${styles.editBtnSave}`}
                                  onClick={() => handleSaveRelation(row)}
                                  disabled={savingRelation}
                                >✓</button>
                                <button
                                  className={`${styles.editBtn} ${styles.editBtnCancel}`}
                                  onClick={resetRelationForm}
                                >✕</button>
                              </div>
                            ) : (
                              <div key={row.key} className={styles.relationRow}>
                                <span className={styles.relationDir}>{row.outgoing ? '→' : '←'}</span>
                                <span className={styles.relationTag} title={row.rel.label}>{row.rel.label}</span>
                                <span
                                  className={styles.relationTarget}
                                  title={`${row.otherName}（${row.otherType || '其他'}）`}
                                >
                                  <span className={styles.relationTargetIcon}>{entityIcon(row.otherType)}</span>
                                  <span className={styles.relationTargetName}>{row.otherName}</span>
                                </span>
                                {canEditRelations && (
                                  <>
                                    <button
                                      type="button"
                                      className={styles.itemAction}
                                      title="修改关联"
                                      onClick={() => startEditRelation(row)}
                                    >✎</button>
                                    <button
                                      type="button"
                                      className={`${styles.itemAction} ${styles.itemActionDanger}`}
                                      title="删除关联"
                                      onClick={() => handleDeleteRelation(row)}
                                      disabled={savingRelation}
                                    >✕</button>
                                  </>
                                )}
                              </div>
                            )
                          )}
                          {relationRows.length > relationVisibleCount && (
                            <button
                              type="button"
                              className={styles.loadMore}
                              onClick={loadMoreRelations}
                            >
                              加载更多（已显示 {relationVisibleCount} / {relationRows.length} 条）
                            </button>
                          )}
                        </>
                      )}
                      {addingRelation && canEditRelations && (
                        <div className={styles.relationEditForm}>
                          <button
                            type="button"
                            className={styles.relationDirBtn}
                            title="切换方向"
                            onClick={() => setNewRelationOutgoing((v) => !v)}
                          >{newRelationOutgoing ? '→' : '←'}</button>
                          <input
                            className={styles.relationEditInput}
                            value={newRelationLabel}
                            onChange={(e) => setNewRelationLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddRelation();
                              if (e.key === 'Escape') resetRelationForm();
                            }}
                            placeholder="关系名称"
                            autoFocus
                          />
                          <RelationTargetPicker
                            options={relationTargetOptions}
                            value={newRelationTargetKey}
                            onChange={setNewRelationTargetKey}
                            placeholder="选择对端…"
                          />
                          <button
                            className={`${styles.editBtn} ${styles.editBtnSave}`}
                            onClick={handleAddRelation}
                            disabled={savingRelation || !newRelationTargetKey}
                          >✓</button>
                          <button
                            className={`${styles.editBtn} ${styles.editBtnCancel}`}
                            onClick={resetRelationForm}
                          >✕</button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {listRows.length === 0 ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>暂无实体</div>
            ) : filteredEntities.length === 0 && !graphSelectedEntity ? (
              <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--c-text-muted)' }}>无匹配实体</div>
            ) : null}
            {/* 动态加载：每批不超过 20 条 */}
            {filteredEntities.length > visibleCount && (
              <button
                type="button"
                className={styles.loadMore}
                onClick={() => setVisibleCount((c) => c + ENTITY_BATCH)}
              >
                加载更多（已显示 {visibleCount} / {filteredEntities.length} 条）
              </button>
            )}
          </div>
    </>
  );

  return (
    <div
      className={`${styles.panel} ${mode === 'graph' ? styles.panelGraph : ''} ${mode === 'graph' && isolatedMode ? styles.panelIsolated : ''}`}
    >
      {mode === 'list' ? (
        <>
          {renderListHeader()}
          {renderEntityListContent()}
        </>
      ) : (
        /* ── 图谱模式：左栏实体列表（保持可见）+ 右栏知识图谱 ── */
        <div className={styles.graphSplit}>
          <div className={styles.graphSplitList}>
            {renderListHeader()}
            {renderEntityListContent()}
          </div>
          <div className={styles.graphSplitGraph}>
            {renderGraphHeader()}
          {/* 图例 + 图操作工具栏（展开/清除/撤销/导出） */}
          <div className={styles.graphToolbar}>
            <span>◫ 文章</span>
            <span>● 目录</span>
            <span>◆ 实体</span>
            <span className={styles.graphToolSpacer}>
              {/* 展开层数与展开按钮融合：左侧 ▲/▼ 上下两个按钮增减层数（1-5），主按钮直接展开 */}
              <span className={styles.expandBtnGroup}>
                <span className={styles.expandDepthBtns}>
                  <button
                    type="button"
                    className={styles.expandDepthBtn}
                    onClick={() => setExpandDepth((d) => Math.min(5, d + 1))}
                    disabled={expandDepth >= 5}
                    title={`增加展开层数（当前 ${expandDepth} 层，最多 5 层）`}
                    aria-label="增加展开层数"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className={styles.expandDepthBtn}
                    onClick={() => setExpandDepth((d) => Math.max(1, d - 1))}
                    disabled={expandDepth <= 1}
                    title={`减小展开层数（当前 ${expandDepth} 层，最少 1 层）`}
                    aria-label="减小展开层数"
                  >
                    ▼
                  </button>
                </span>
                <button
                  type="button"
                  className={`${styles.graphToolBtn} ${styles.expandBtnMain}`}
                  disabled={!hasNodeSelection || expanding}
                  onClick={handleExpand}
                  title={hasNodeSelection
                    ? `展开选中节点（${selectedNodeIds.size} 个）的 n 层关系（Neo4j 全量查询）`
                    : '请先在图谱中选中节点（Ctrl+点击多选）'}
                >
                  {expanding ? '⤢ 展开中…' : `⤢ 展开 ${expandDepth} 层`}
                </button>
              </span>
              <button
                type="button"
                className={styles.graphToolBtn}
                disabled={!hasNodeSelection}
                onClick={handleRemoveNodes}
                title={hasNodeSelection
                  ? `从图中移除选中的 ${selectedNodeIds.size} 个节点及其关系（仅视图，不动数据）`
                  : '请先在图谱中选中节点（Ctrl+点击多选）'}
              >
                ✕ 移除
              </button>
              <button
                type="button"
                className={styles.graphToolBtn}
                disabled={graphHistory.length === 0}
                onClick={handleUndo}
                title="撤销上一步图操作"
              >
                ↺ 撤销
              </button>
            </span>
          </div>
          {/* 载入图谱文件（隐藏的 JSON 文件选择器） */}
          <input
            ref={graphFileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleGraphFileChange}
          />
          <div
            className={styles.graphContainer}
            ref={graphContainerRef}
            // d3 zoom 在 mousedown 时 stopImmediatePropagation，冒泡阶段的
            // React onMouseDown 收不到；用 capture 阶段记录拖拽起点，
            // 平移后的 click 才能被位移阈值正确忽略。
            onMouseDownCapture={(e) => {
              graphMouseDownPosRef.current = { x: e.clientX, y: e.clientY };
            }}
            onClick={(e) => {
              // 拖拽平移后浏览器仍会派发 click → 位移超过阈值视为平移，不清除选中
              const down = graphMouseDownPosRef.current;
              if (down && (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5)) return;
              handleGraphBackgroundClick();
            }}
          >
            {!displayGraph || displayGraph.nodes.length === 0 ? (
              graphLoading && !isolatedMode ? (
                <div className={styles.graphEmpty}>加载图谱数据…</div>
              ) : (
                <div className={styles.graphEmpty}>
                  {isolatedMode
                    ? '空图谱：在左侧实体列表点「+」添加实体，再为其添加关联'
                    : focusEntity ? '该实体暂无图谱关联' : articles.length === 0 ? '暂无文章' : '选择文章以查看知识图谱'}
                </div>
              )
            ) : (
              <>
                {/* 刷新时保留 <svg>：否则 hook 会把重挂载当成首次初始化，
                    丢失缩放/平移并重置节点布局（编辑关联后画布跳动） */}
                <svg ref={graphSvgRef} className={styles.graphSvg} />
                <div ref={graphTooltipRef} />
                {graphLoading && !isolatedMode && (
                  <div className={styles.graphReloading}>刷新中…</div>
                )}
              </>
            )}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
