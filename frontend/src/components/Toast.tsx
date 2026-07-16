import { useToast } from '../hooks/useToast';
import styles from './Toast.module.css';

const ICONS: Record<string, string> = {
  success: '✅',
  warning: '⚠️',
  error: '❌',
  info: 'ℹ️',
};

export function ToastContainer() {
  const { toasts } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.exiting ? styles.fadeout : ''}`}
        >
          {ICONS[t.type] ?? ICONS.info} {t.message}
        </div>
      ))}
    </div>
  );
}
