import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useArticles } from '../hooks/useArticles';
import { ArticleDetailView } from './ArticleDetail';
import { orderByHierarchy } from '../utils/hierarchy';

/**
 * Standalone article detail page (route: /articles/:id).
 * Thin wrapper around ArticleDetailView with route-specific navigation.
 * Separated from ArticleDetail.tsx to allow lazy loading.
 */
export function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  const { articles: allArticles } = useArticles();

  // 保活窗口：组件不再随路由卸载重建，切换文章时重置实体选择
  useEffect(() => {
    setSelectedEntity(null);
  }, [id]);

  // 上一篇/下一篇按树状层级顺序（子文章紧随父文章）导航
  const orderedIds = useMemo(
    () => orderByHierarchy(allArticles).map((o) => o.article.id),
    [allArticles],
  );
  const currentIndex = orderedIds.indexOf(id ?? '');
  const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] : undefined;
  const nextId = currentIndex >= 0 && currentIndex < orderedIds.length - 1
    ? orderedIds[currentIndex + 1] : undefined;

  if (!id) {
    return (
      <div style={{ textAlign: 'center', padding: 60, color: 'var(--c-text-muted)' }}>
        文章不存在
      </div>
    );
  }

  return (
    <ArticleDetailView
      articleId={id}
      onBack={() => navigate('/articles')}
      onReturn={(pid, cid) => {
        const search = new URLSearchParams(window.location.search).get('search') ?? '';
        const qs = search ? `&search=${encodeURIComponent(search)}` : '';
        navigate(pid ? `/articles?view=${pid}${qs}` : cid ? `/articles?category=${cid}${qs}` : '/articles');
      }}
      prevArticleId={prevId}
      nextArticleId={nextId}
      onNavigate={(nid) => navigate(`/articles/${nid}`)}
      selectedEntity={selectedEntity}
      onEntitySelect={setSelectedEntity}
    />
  );
}
