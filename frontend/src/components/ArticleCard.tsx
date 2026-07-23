import type { Article } from '../types/article';
import styles from './ArticleCard.module.css';

interface Props {
  article: Article;
  selected: boolean;
  onSelect: (id: string, ctrl: boolean) => void;
  onOpen: (id: string) => void;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/<[^>]*>/g, '')                     // HTML tags (img, audio, video)
    .replace(/#{1,6}\s/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')    // images → alt text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links → text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')                  // strikethrough
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^>\s/gm, '')                        // blockquotes
    .replace(/^[>\-*+|\d]+\.?\s/gm, '')           // list markers
    .replace(/[\n\r]+/g, ' ')                     // newlines → spaces
    .replace(/[>\-*+|#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (hrs < 24) return `${hrs} 小时前`;
  if (days < 7) return `${days} 天前`;

  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ArticleCard({ article, selected, onSelect, onOpen }: Props) {
  const catColor = article.category?.color ?? 'var(--c-border)';
  const catName = article.category?.name ?? '未分类';
  const stripped = stripMarkdown(article.content);
  const excerpt = stripped.slice(0, 200) + (stripped.length > 200 ? '…' : '');

  return (
    <div
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      style={{ '--card-accent': catColor } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${article.title}${selected ? '（已选中）' : ''}`}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button')) return;
        onSelect(article.id, e.ctrlKey || e.metaKey);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onOpen(article.id); }
        if (e.key === ' ') { e.preventDefault(); onSelect(article.id, e.ctrlKey || e.metaKey); }
      }}
    >
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <span className={styles.title}>{article.title}</span>
          <button
            className={styles.openBtn}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(article.id);
            }}
            title="打开文章"
          >
            ↗
          </button>
        </div>
        <div className={styles.excerpt}>{excerpt}</div>
        <div className={styles.meta}>
          <span
            className={styles.categoryBadge}
            style={{ color: catColor, background: `${catColor}15` }}
          >
            {catName}
          </span>
          <span>{formatDate(article.created_at)}</span>
          {article.attachment_name && (
            <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>📎</span>
          )}
          {article.tags.slice(0, 3).map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
