import { useLocation } from 'react-router-dom';
import { useReadingProgress } from '../hooks/useReadingProgress';
import styles from './ReadingProgress.module.css';

export function ReadingProgress() {
  const { pathname } = useLocation();
  const isDetail = pathname.startsWith('/articles/') && pathname.split('/').length === 3;
  const progress = useReadingProgress({ enabled: isDetail });

  if (!isDetail) return null;

  return (
    <div
      className={styles.bar}
      style={{ width: `${progress}%` }}
      role="progressbar"
      aria-valuenow={Math.round(progress)}
      aria-valuemin={0}
      aria-valuemax={100}
    />
  );
}
