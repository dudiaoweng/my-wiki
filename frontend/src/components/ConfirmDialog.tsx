import { useApp } from '../context/AppProvider';
import styles from './ConfirmDialog.module.css';

export function ConfirmDialog() {
  const { confirmState, closeConfirm, executeConfirm } = useApp();

  if (!confirmState) return null;

  return (
    <div className={`${styles.overlay} ${styles.open}`}>
      <div className={styles.dialog}>
        <h4>{confirmState.title}</h4>
        <p>{confirmState.message}</p>
        <div className={styles.row}>
          <button className={styles.btn} onClick={closeConfirm}>
            取消
          </button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={executeConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
