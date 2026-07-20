import { useEffect, useRef } from 'react';
import { useApp } from '../context/AppProvider';
import styles from './ConfirmDialog.module.css';

export function ConfirmDialog() {
  const { confirmState, closeConfirm, executeConfirm } = useApp();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus trap: focus the cancel button when dialog opens
  useEffect(() => {
    if (confirmState) {
      cancelRef.current?.focus();
    }
  }, [confirmState]);

  // Close on Escape
  useEffect(() => {
    if (!confirmState) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeConfirm();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [confirmState, closeConfirm]);

  if (!confirmState) return null;

  return (
    <div className={`${styles.overlay} ${styles.open}`} onClick={closeConfirm}>
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 id="confirm-title">{confirmState.title}</h4>
        <p id="confirm-message">{confirmState.message}</p>
        <div className={styles.row}>
          <button className={styles.btn} onClick={closeConfirm} ref={cancelRef}>
            取消
          </button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={executeConfirm}>
            {confirmState.confirmLabel ?? '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
