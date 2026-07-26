import { entityIcon } from '../utils/entityIcons';
import type { Occurrence } from '../hooks/useEntityOccurrences';
import styles from './EntityOccurrenceBar.module.css';

interface Props {
  entityName: string;
  entityType?: string;
  totalCount: number;
  activeIndex: number;
  occurrences: Occurrence[];
  onNavigate: (index: number) => void;
  onClose: () => void;
}

export function EntityOccurrenceBar({
  entityName,
  entityType,
  totalCount,
  activeIndex,
  occurrences,
  onNavigate,
  onClose,
}: Props) {
  const handlePrev = () => {
    if (activeIndex > 0) onNavigate(activeIndex - 1);
  };

  const handleNext = () => {
    if (activeIndex < totalCount - 1) onNavigate(activeIndex + 1);
  };

  const handleDotClick = (index: number) => {
    onNavigate(index);
  };

  return (
    <div className={styles.bar}>
      {/* ── Left: entity name + count ── */}
      <div className={styles.info}>
        {entityType && (
          <span className={styles.icon} title={entityType}>
            {entityIcon(entityType)}
          </span>
        )}
        <span className={styles.entityName}>{entityName}</span>
      </div>

      {/* ── Center: position dots track ── */}
      <div className={styles.dotsTrack}>
        {occurrences.map((occ) => {
          const isPassed = occ.index < activeIndex;
          const isActive = occ.index === activeIndex;
          return (
            <button
              key={occ.index}
              className={`${styles.dot} ${isPassed ? styles.dotPassed : ''} ${isActive ? styles.dotActive : ''}`}
              style={{ left: `${occ.ratio * 100}%` }}
              onClick={() => handleDotClick(occ.index)}
              title={`第 ${occ.index + 1} 处`}
              aria-label={`跳转到第 ${occ.index + 1} 处出现`}
            />
          );
        })}
      </div>

      {/* ── Right: nav arrows + count + close ── */}
      <div className={styles.controls}>
        <span className={styles.count}>
          {activeIndex + 1}/{totalCount}
        </span>
        <button
          className={`${styles.arrowBtn} ${styles.arrowBtnPrev}`}
          onClick={handlePrev}
          disabled={activeIndex <= 0}
          title="上一处"
          aria-label="上一处"
        >
          ▲
        </button>
        <button
          className={`${styles.arrowBtn} ${styles.arrowBtnNext}`}
          onClick={handleNext}
          disabled={activeIndex >= totalCount - 1}
          title="下一处"
          aria-label="下一处"
        >
          ▼
        </button>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          title="取消高亮"
          aria-label="取消高亮"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
