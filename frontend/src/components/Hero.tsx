import { useNavigate } from 'react-router-dom';
import { useStats } from '../hooks/useStats';
import { useApp } from '../context/AppProvider';
import styles from './Hero.module.css';

export function Hero() {
  const navigate = useNavigate();
  const { stats } = useStats();
  const { searchInputRef } = useApp();

  const handleSearchFocus = () => {
    navigate('/articles');
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    navigate(q ? `/articles?search=${encodeURIComponent(q)}` : '/articles');
  };

  return (
    <div className={styles.hero}>
      <div className={styles.icon}>📚</div>
      <h2>你的知识，井然有序</h2>
      <p>一个安静、专注的个人知识库。搜索、阅读、撰写——让每一个想法都有处可放。</p>

      <div className={styles.searchWrap}>
        <span className={styles.searchIcon}>🔍</span>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="输入关键词开始搜索…"
          onFocus={handleSearchFocus}
          onInput={handleSearchInput}
        />
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.number}>{stats.article_count}</div>
          <div className={styles.label}>篇文章</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.number}>{stats.category_count}</div>
          <div className={styles.label}>个分类</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.number}>{stats.tag_count}</div>
          <div className={styles.label}>个标签</div>
        </div>
      </div>
    </div>
  );
}
