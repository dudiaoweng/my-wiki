import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useArticles } from '../hooks/useArticles';
import { ArticleDetailView } from './ArticleDetail';

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
  const currentIndex = allArticles.findIndex((a) => a.id === id);
  const prevId = currentIndex > 0 ? allArticles[currentIndex - 1]?.id : undefined;
  const nextId = currentIndex >= 0 && currentIndex < allArticles.length - 1
    ? allArticles[currentIndex + 1]?.id : undefined;

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
      prevArticleId={prevId}
      nextArticleId={nextId}
      onNavigate={(nid) => navigate(`/articles/${nid}`)}
      selectedEntity={selectedEntity}
      onEntitySelect={(name) => setSelectedEntity(name)}
      onTagClick={(tag) => navigate(`/articles?tag=${encodeURIComponent(tag)}`)}
    />
  );
}
