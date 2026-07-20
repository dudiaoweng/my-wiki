import { useStats } from '../hooks/useStats';
import styles from './Hero.module.css';

export function Hero() {
  const { stats } = useStats();

  return (
    <div className={styles.hero}>
      <div className={styles.icon}>📚</div>
      <h2>你的知识，井然有序</h2>
      <p>一个安静、专注的个人知识库。搜索、阅读、撰写——让每一个想法都有处可放。</p>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.number}>{stats?.article_count ?? '—'}</div>
          <div className={styles.label}>篇文章</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.number}>{stats?.category_count ?? '—'}</div>
          <div className={styles.label}>个分类</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.number}>{stats?.entity_count ?? '—'}</div>
          <div className={styles.label}>个实体</div>
        </div>
      </div>
    </div>
  );
}
