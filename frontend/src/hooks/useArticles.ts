import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Article, ArticleCreate, ArticleUpdate } from '../types/article';
import { useToast } from './useToast';

export function useArticles(params?: { category_id?: string; search?: string; tag?: string }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getArticles(params);
      setArticles(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch articles';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [params?.category_id, params?.search, params?.tag, showToast]);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  const createArticle = async (data: ArticleCreate): Promise<Article | null> => {
    try {
      const article = await api.createArticle(data);
      // Only prepend to list if no active filter (or if article matches filter)
      setArticles((prev) => {
        const matchesCategory = !params?.category_id || article.category_id === params.category_id;
        const matchesTag = !params?.tag || article.tags.includes(params.tag);
        if (matchesCategory && matchesTag) {
          return [article, ...prev];
        }
        return prev;
      });
      showToast('文章已创建', 'success');
      return article;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create article';
      showToast(msg, 'error');
      return null;
    }
  };

  const updateArticle = async (id: string, data: ArticleUpdate): Promise<Article | null> => {
    try {
      const updated = await api.updateArticle(id, data);
      setArticles((prev) => prev.map((a) => (a.id === id ? updated : a)));
      showToast('文章已更新', 'success');
      return updated;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to update article';
      showToast(msg, 'error');
      return null;
    }
  };

  const deleteArticle = async (id: string): Promise<boolean> => {
    try {
      await api.deleteArticle(id);
      setArticles((prev) => prev.filter((a) => a.id !== id));
      showToast('文章已删除', 'success');
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to delete article';
      showToast(msg, 'error');
      return false;
    }
  };

  return { articles, loading, error, createArticle, updateArticle, deleteArticle, refetch: fetchArticles };
}
