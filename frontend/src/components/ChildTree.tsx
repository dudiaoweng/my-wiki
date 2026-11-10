import { Link } from 'react-router-dom';
import type { ArticleChildNode } from '../types/article';
import { HighlightText } from './HighlightText';
import styles from './ChildTree.module.css';

export function countDescendants(nodes: ArticleChildNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countDescendants(n.children), 0);
}

function formatUser(cn: string | null): string {
  if (!cn) return '';
  const match = cn.match(/^(.+?)\s+\d{18}$/);
  return match ? match[1] : cn;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

interface ChildTreeProps {
  nodes: ArticleChildNode[];
  /** 自定义打开方式（如列表内联打开）；优先于 getHref */
  onOpen?: (id: string) => void;
  /** 自定义链接生成（如带实体列表的内联视图）；不传时默认跳转文章详情页 */
  getHref?: (id: string) => string;
  /** 搜索关键词：子文章标题中醒目标识 */
  highlightTerms?: string[];
}

/**
 * 子文章标题树（文章详情页与文章卡片共用）：
 * 嵌套缩进 + 左侧连接线。
 */
export function ChildTree({ nodes, onOpen, getHref, highlightTerms }: ChildTreeProps) {
  if (nodes.length === 0) return null;
  return (
    <ul className={styles.childTree}>
      {nodes.map((n) => (
        <li key={n.id}>
          <div className={styles.treeRow}>
            <span className={styles.treeIcon}>📄</span>
            {onOpen ? (
              <button
                type="button"
                className={styles.treeLink}
                onClick={() => onOpen(n.id)}
                title={`打开「${n.title}」`}
              >
                <HighlightText text={n.title} terms={highlightTerms} />
              </button>
            ) : (
              <Link
                to={getHref ? getHref(n.id) : `/articles/${n.id}`}
                className={styles.treeLink}
                title={n.title}
              >
                <HighlightText text={n.title} terms={highlightTerms} />
              </Link>
            )}
            {(n.created_by || n.updated_at) && (
              <span className={styles.treeMeta}>
                {formatUser(n.created_by) && `👤 ${formatUser(n.created_by)}`}
                {n.created_by && n.updated_at ? ' · ' : ''}
                {formatDate(n.updated_at)}
              </span>
            )}
          </div>
          <ChildTree nodes={n.children} onOpen={onOpen} getHref={getHref} highlightTerms={highlightTerms} />
        </li>
      ))}
    </ul>
  );
}
