import { useState, useMemo } from 'react';
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
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const { articles: allArticles } = useArticles();
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
      onReturn={(pid, cid) =>
        navigate(pid ? `/articles?view=${pid}` : cid ? `/articles?category=${cid}` : '/articles')
      }
      prevArticleId={prevId}
      nextArticleId={nextId}
      onNavigate={(nid) => navigate(`/articles/${nid}`)}
      selectedEntity={selectedEntity}
      onEntitySelect={(name) => {
        setSelectedEntity(name);
        if (name) setSelectedTag(null);  // 实体与标签互斥
      }}
      selectedTag={selectedTag}
      onTagClick={(tag) => {
        // 内容导航：选中定位文中所有该标签词，再点取消；与实体选择互斥
        setSelectedTag((prev) => (prev === tag ? null : tag));
        setSelectedEntity(null);
      }}
    />
  );
}
