import { useRef, useState, useEffect, useCallback } from 'react';
import { api, type EntityInfoItem } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useApp } from '../context/AppProvider';
import { entityIcon, ENTITY_TYPE_OPTIONS } from '../utils/entityIcons';
import styles from './EntityPanel.module.css';

interface Props {
  entityName: string;
  entityType: string;
  x: number;
  y: number;
  createdBy?: string;
  canModify: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onRefresh: () => void;
}

export function EntityGraphPopover({
  entityName,
  entityType,
  x,
  y,
  createdBy,
  canModify,
  containerRef,
  onClose,
  onRefresh,
}: Props) {
  // Compute container dimensions from ref
  const [dims, setDims] = useState({ w: 400, h: 300 });
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setDims({ w: rect.width, h: rect.height });
    }
  }, [containerRef]);
  const { showToast } = useToast();
  const { requestConfirm, userIdNumber } = useApp();

  // ── Entity edit state ──
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(entityName);
  const [editType, setEditType] = useState(entityType || '其他');
  const editNameRef = useRef<HTMLInputElement>(null);

  // ── Entity info state ──
  const [infos, setInfos] = useState<EntityInfoItem[]>([]);
  const [loadingInfos, setLoadingInfos] = useState(false);
  const [addingInfo, setAddingInfo] = useState(false);
  const [newInfoName, setNewInfoName] = useState('');
  const [newInfoContent, setNewInfoContent] = useState('');
  const [editingInfoId, setEditingInfoId] = useState<string | null>(null);
  const [editInfoName, setEditInfoName] = useState('');
  const [editInfoContent, setEditInfoContent] = useState('');
  const newInfoNameRef = useRef<HTMLInputElement>(null);

  // ── Load infos on mount ──
  const loadInfos = useCallback(async () => {
    setLoadingInfos(true);
    try {
      const data = await api.getEntityInfos(entityName);
      setInfos(data);
    } catch {
      setInfos([]);
    } finally {
      setLoadingInfos(false);
    }
  }, [entityName]);

  useEffect(() => {
    loadInfos();
  }, [loadInfos]);

  // Auto-focus
  useEffect(() => { if (editing) editNameRef.current?.focus(); }, [editing]);
  useEffect(() => { if (addingInfo) newInfoNameRef.current?.focus(); }, [addingInfo]);

  // ── Entity save ──
  const handleSaveEdit = async () => {
    const name = editName.trim();
    if (!name) return;
    try {
      await api.updateEntity(entityName, name !== entityName ? name : undefined, editType);
      showToast(`实体已更新`, 'success');
      setEditing(false);
      onRefresh();
    } catch (e: unknown) {
      const msg = (e instanceof Error && e.message) ? e.message : '更新失败';
      showToast(msg, 'error');
    }
  };

  // ── Entity delete ──
  const handleDeleteEntity = () => {
    requestConfirm('删除实体', `确定要删除实体「${entityName}」吗？`, async () => {
      try {
        await api.removeEntity(entityName);
        showToast(`实体已删除`, 'success');
        onRefresh();
        onClose();
      } catch (e: unknown) {
        const msg = (e instanceof Error && e.message) ? e.message : '删除失败';
        showToast(msg, 'error');
      }
    });
  };

  // ── Info CRUD ──
  const handleAddInfo = async () => {
    if (!newInfoName.trim() || !newInfoContent.trim()) return;
    try {
      await api.createEntityInfo(entityName, newInfoName.trim(), newInfoContent.trim());
      showToast('附加信息已添加', 'success');
      setNewInfoName('');
      setNewInfoContent('');
      setAddingInfo(false);
      await loadInfos();
    } catch (e: unknown) {
      const msg = (e instanceof Error && e.message) ? e.message : '添加失败';
      showToast(msg, 'error');
    }
  };

  const handleUpdateInfo = async (infoId: string) => {
    if (!editInfoName.trim() || !editInfoContent.trim()) return;
    try {
      await api.updateEntityInfo(entityName, infoId, {
        name: editInfoName.trim(),
        content: editInfoContent.trim(),
      });
      showToast('附加信息已更新', 'success');
      setEditingInfoId(null);
      await loadInfos();
    } catch (e: unknown) {
      const msg = (e instanceof Error && e.message) ? e.message : '更新失败';
      showToast(msg, 'error');
    }
  };

  const handleDeleteInfo = (infoId: string, infoName: string) => {
    requestConfirm('删除附加信息', `确定要删除「${infoName}」吗？`, async () => {
      try {
        await api.deleteEntityInfo(entityName, infoId);
        showToast('附加信息已删除', 'success');
        await loadInfos();
      } catch (e: unknown) {
        const msg = (e instanceof Error && e.message) ? e.message : '删除失败';
        showToast(msg, 'error');
      }
    });
  };

  // ── Position: keep popover within container bounds ──
  const popoverWidth = 280;
  const popoverMaxHeight = 400;
  let left = x + 12;
  let top = y - 16;
  if (left + popoverWidth > dims.w) left = x - popoverWidth - 12;
  if (left < 0) left = 8;
  if (top + popoverMaxHeight > dims.h) top = dims.h - popoverMaxHeight - 8;
  if (top < 0) top = 8;

  return (
    <div
      className={styles.infoPanel}
      data-popover="entity"
      style={{
        position: 'absolute',
        left,
        top,
        width: popoverWidth,
        maxHeight: popoverMaxHeight,
        overflowY: 'auto',
        zIndex: 20,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        padding: 12,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* ── Header: entity name + close ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }} title={entityType}>{entityIcon(entityType)}</span>
        <strong
          style={{ flex: 1, fontSize: 14, color: '#7D5DA9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={createdBy ? `类型：${entityType}\n创建人：${createdBy.replace(/\s+\d{18}$/, '')}` : `类型：${entityType}`}
        >
          {entityName}
        </strong>
        <button
          className={`${styles.itemAction} ${styles.itemActionDanger}`}
          style={{ opacity: 1 }}
          onClick={onClose}
          title="关闭"
        >✕</button>
      </div>

      {/* ── Entity actions ── */}
      {canModify && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            onClick={() => {
              setEditing(true);
              setEditName(entityName);
              setEditType(entityType || '其他');
            }}
            style={{
              flex: 1, padding: '3px 8px', border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius-sm)', background: 'var(--c-card)',
              fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-body)',
              color: 'var(--c-text-soft)',
            }}
            disabled={editing}
          >✎ 编辑实体</button>
          <button
            onClick={handleDeleteEntity}
            style={{
              flex: 1, padding: '3px 8px', border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius-sm)', background: 'var(--c-card)',
              fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-body)',
              color: 'var(--c-danger)',
            }}
          >✕ 删除实体</button>
        </div>
      )}

      {/* ── Entity edit mode ── */}
      {editing && (
        <div className={styles.editRow} style={{ marginBottom: 10 }}>
          <select
            className={styles.editInput}
            value={editType}
            onChange={(e) => setEditType(e.target.value)}
            style={{ flex: '0 0 70px', cursor: 'pointer', minWidth: 0 }}
          >
            {ENTITY_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            ref={editNameRef}
            className={styles.editInput}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className={`${styles.editBtn} ${styles.editBtnSave}`} onClick={handleSaveEdit}>✓</button>
          <button className={`${styles.editBtn} ${styles.editBtnCancel}`} onClick={() => setEditing(false)}>✕</button>
        </div>
      )}

      {/* ── Divider ── */}
      <div style={{ borderTop: '1px solid var(--c-border)', margin: '6px 0' }} />

      {/* ── Additional info section ── */}
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-text-soft)', marginBottom: 6 }}>
        附加信息
      </div>

      {loadingInfos ? (
        <div className={styles.infoLoading}>加载中…</div>
      ) : (
        <div className={styles.infoList}>
          {infos.map((info) => (
            <div key={info.id} className={styles.infoItem}>
              {editingInfoId === info.id ? (
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
                <div className={styles.infoReadRow}>
                  <span className={styles.infoCat}>{info.name}</span>
                  <span
                    className={styles.infoContent}
                    title={info.created_by ? `创建人：${info.created_by.replace(/\s+\d{18}$/, '')}` : undefined}
                  >{info.content}</span>
                  {(!info.created_by || !userIdNumber || (info.created_by.match(/\d{18}/)?.[0] ?? '') === userIdNumber) && (
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
                  {(!info.created_by || !userIdNumber || (info.created_by.match(/\d{18}/)?.[0] ?? '') === userIdNumber) && (
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
          {infos.length === 0 && !addingInfo && (
            <div className={styles.infoEmpty}>暂无附加信息</div>
          )}
        </div>
      )}

      {/* ── Add info ── */}
      {addingInfo ? (
        <div className={styles.infoEditRow} style={{ marginTop: 4 }}>
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
        <button
          className={styles.infoAddBtn}
          style={{ marginTop: 6 }}
          onClick={() => setAddingInfo(true)}
        >
          + 添加信息
        </button>
      )}
    </div>
  );
}
