import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import type { Article } from '../types/article';
import styles from './ArticleDetail.module.css';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { openEditor, requestConfirm, notifyArticleSaved } = useApp();
  const { showToast } = useToast();

  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api
      .getArticle(id)
      .then(setArticle)
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load article');
        showToast('文章不存在', 'error');
      })
      .finally(() => setLoading(false));
  }, [id, showToast]);

  if (loading) {
    return <div className={styles.loading}>加载中…</div>;
  }

  if (error || !article) {
    return (
      <div className={styles.loading}>
        <p>{error ?? '文章不存在'}</p>
        <button className={`${styles.btn} ${styles.btnPrimary}`} style={{ marginTop: 16 }} onClick={() => navigate('/articles')}>
          返回列表
        </button>
      </div>
    );
  }

  const catColor = article.category?.color ?? 'var(--c-text-muted)';
  const catName = article.category?.name ?? '未分类';
  const entityCount = article.entities?.entities?.length ?? 0;
  const relationCount = article.entities?.relations?.length ?? 0;

  const handleDelete = () => {
    if (!id) return;
    requestConfirm('确认删除', `确定要删除「${article.title}」吗？此操作不可撤销。`, async () => {
      try {
        await api.deleteArticle(id);
        showToast('文章已删除', 'success');
        notifyArticleSaved();
        navigate('/articles');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Delete failed';
        showToast(msg, 'error');
      }
    });
  };

  const handleTagClick = (tag: string) => {
    navigate(`/articles?tag=${encodeURIComponent(tag)}`);
  };

  return (
    <div className={styles.detail}>
      <button className={styles.backBtn} onClick={() => navigate('/articles')}>
        ← 返回列表
      </button>

      <div className={styles.header}>
        <div className={styles.categoryLabel} style={{ color: catColor }}>
          {catName}
        </div>
        <h1 className={styles.title}>{article.title}</h1>
        <div className={styles.meta}>
          <span>📅 创建于 {formatDate(article.created_at)}</span>
          <span>✏️ 更新于 {formatDate(article.updated_at)}</span>
          <span>🔖 {entityCount} 个实体</span>
          <span>🔗 {relationCount} 个关系</span>
        </div>
        {article.tags.length > 0 && (
          <div className={styles.tags}>
            {article.tags.map((t) => (
              <button
                key={t}
                className={styles.tag}
                onClick={() => handleTagClick(t)}
                title={`查看所有标记为「${t}」的文章`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {article.attachment_name && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', background: 'var(--c-surface)',
          borderRadius: 'var(--radius-sm)', marginBottom: 24,
          fontSize: 13, color: 'var(--c-text-soft)',
        }}>
          <span>📎</span>
          <span style={{ flex: 1 }}>{article.attachment_name}</span>
          <a
            href={`/api/articles/${article.id}/download`}
            download={article.attachment_name}
            style={{
              color: 'var(--c-accent)', textDecoration: 'none',
              fontWeight: 500, cursor: 'pointer',
            }}
          >
            下载
          </a>
        </div>
      )}

      <div className={styles.content}>
        <Markdown remarkPlugins={[remarkGfm]}>{article.content}</Markdown>
      </div>

      <div className={styles.actions}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => openEditor(article.id)}
        >
          ✏️ 编辑
        </button>
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleDelete}>
          🗑 删除
        </button>
      </div>
    </div>
  );
}
