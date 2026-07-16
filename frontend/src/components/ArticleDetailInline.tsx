import { useState, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import type { Article } from '../types/article';
import styles from './ArticleDetailInline.module.css';

interface Props {
  articleId: string;
  onBack: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ArticleDetailInline({ articleId, onBack }: Props) {
  const { openEditor, requestConfirm } = useApp();
  const { showToast } = useToast();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getArticle(articleId)
      .then(setArticle)
      .catch(() => showToast('文章加载失败', 'error'))
      .finally(() => setLoading(false));
  }, [articleId, showToast]);

  if (loading) return <div className={styles.loading}>加载中…</div>;
  if (!article) return <div className={styles.loading}>文章不存在</div>;

  const catColor = article.category?.color ?? 'var(--c-text-muted)';
  const catName = article.category?.name ?? '未分类';

  const handleDelete = () => {
    requestConfirm('确认删除', `确定要删除「${article.title}」吗？`, async () => {
      try {
        await api.deleteArticle(articleId);
        showToast('文章已删除', 'success');
        onBack();
      } catch {
        showToast('删除失败', 'error');
      }
    });
  };

  return (
    <div className={styles.detail}>
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={onBack}>← 返回列表</button>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={() => openEditor(article.id)}>✏️ 编辑</button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>🗑 删除</button>
        </div>
      </div>

      <div className={styles.categoryLabel} style={{ color: catColor }}>{catName}</div>
      <h1 className={styles.title}>{article.title}</h1>

      <div className={styles.meta}>
        <span>📅 {formatDate(article.created_at)}</span>
        <span>✏️ {formatDate(article.updated_at)}</span>
        <span>🔖 {article.entities?.entities?.length ?? 0} 个实体</span>
        <span>🔗 {article.entities?.relations?.length ?? 0} 个关系</span>
      </div>

      {article.tags.length > 0 && (
        <div className={styles.tags}>
          {article.tags.map((t) => (
            <span key={t} className={styles.tag}>{t}</span>
          ))}
        </div>
      )}

      {article.attachment_name && (
        <div className={styles.attachment}>
          📎 {article.attachment_name}
          <a href={`/uploads/${article.attachment_path}`} download={article.attachment_name} className={styles.dlLink}>下载</a>
        </div>
      )}

      <div className={styles.content}>
        <Markdown remarkPlugins={[remarkGfm]}>{article.content}</Markdown>
      </div>
    </div>
  );
}
