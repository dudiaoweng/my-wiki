import type { Article } from '../types/article';
import { Link, useSearchParams } from 'react-router-dom';
import { ChildTree } from './ChildTree';
import styles from './ArticleCard.module.css';

/** 标签累加筛选链接：已激活则移除（toggle），否则追加；全部移除后回根目录 */
export function tagFilterHref(current: string[], clicked: string): string {
  const next = current.includes(clicked)
    ? current.filter((t) => t !== clicked)
    : [...current, clicked];
  return next.length
    ? `/articles?${next.map((t) => `tag=${encodeURIComponent(t)}`).join('&')}`
    : '/articles';
}

interface Props {
  article: Article;
  selected: boolean;
  onSelect: (id: string, ctrl: boolean) => void;
  onOpen: (id: string) => void;
  /** 层级深度（0 = 顶级文章），用于树状缩进 */
  depth?: number;
  /** 拖拽（列表 ⇄ 侧边栏相互移动） */
  draggable?: boolean;
  dropHighlight?: 'drop' | 'invalid' | null;
  onDragStart?: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLElement>) => void;
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

function formatUser(cn: string | null): string {
  if (!cn) return '';
  const match = cn.match(/^(.+?)\s+\d{18}$/);
  return match ? match[1] : cn;
}

export function ArticleCard({
  article, selected, onSelect, onOpen, depth = 0,
  draggable = false, dropHighlight = null,
  onDragStart, onDragOver, onDragLeave, onDrop,
}: Props) {
  // 当前激活的标签集合（累加筛选；URL ?tag=A&tag=B）
  const [searchParams] = useSearchParams();
  const tags = searchParams.getAll('tag');
  const catColor = article.category?.color ?? 'var(--c-border)';
  const catName = article.category?.name ?? '未归类';
  const stripped = stripMarkdown(article.content);
  const excerpt = stripped.slice(0, 200) + (stripped.length > 200 ? '…' : '');
  // 树状缩进（深度封顶 6 级，避免过深嵌套挤出可视区）
  const indent = Math.min(depth, 6) * 24;

  return (
    <div
      className={`${styles.card} ${selected ? styles.cardSelected : ''} ${depth > 0 ? styles.cardNested : ''}${dropHighlight === 'drop' ? ` ${styles.dropTarget}` : ''}${dropHighlight === 'invalid' ? ` ${styles.dropTargetInvalid}` : ''}`}
      style={{ '--tree-indent': `${indent}px`, '--card-accent': catColor } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${article.title}${selected ? '（已选中）' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
          <span className={styles.title}>{depth > 0 ? '↳ ' : ''}{article.title}</span>
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
          {article.created_by && (
            <span title={article.created_by}>👤 创建人 {formatUser(article.created_by)}</span>
          )}
          {article.processing?.startsWith('processing') && (
            <span className={styles.processingBadge}>⏳ 读取中…</span>
          )}
          {article.processing?.startsWith('recognizing') && (
            <span className={styles.processingBadge}>⏳ 解析中…</span>
          )}
          {article.attachment_name && (
            <span style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>📎</span>
          )}
          {article.tags.slice(0, 3).map((t) => {
            const isActive = tags.includes(t);
            return (
              <Link
                key={t}
                to={tagFilterHref(tags, t)}
                className={styles.tag}
                title={isActive
                  ? `取消标签「${t}」筛选`
                  : `累加筛选标签为「${t}」的文章`}
                onClick={(e) => e.stopPropagation()}
              >
                {t}
              </Link>
            );
          })}
        </div>
        {article.comment_count != null && article.comment_count > 0 && article.latest_comments && article.latest_comments.length > 0 && (
          <div className={styles.commentSummary}>
            <div className={styles.commentHeader}>
              <span className={styles.commentIcon}>💬</span>
              <span className={styles.commentCount}>{article.comment_count} 条评论</span>
            </div>
            {article.latest_comments.map((c) => (
              <div key={c.id} className={styles.commentLine}>
                <span className={styles.commentAuthor}>{formatUser(c.created_by)}</span>
                <span className={styles.commentText}>{c.content}</span>
                <span className={styles.commentTime}>{formatDate(c.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        {article.children_tree.length > 0 && (
          <div className={styles.childTreeWrap}>
            <ChildTree nodes={article.children_tree} onOpen={onOpen} />
          </div>
        )}
      </div>
    </div>
  );
}
