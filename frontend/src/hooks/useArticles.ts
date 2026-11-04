import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Article, ArticleCreate, ArticleUpdate } from '../types/article';
import { useToast } from './useToast';

export function useArticles(params?: {
  category_id?: string; search?: string; tag?: string[]; root_only?: boolean;
  skip?: number; limit?: number;
}) {
  const [articles, setArticles] = useState<Article[]>([]);
  // 分页模式（显式传 limit）下的服务器总数；未分页时为 null（列表页分页器用）
  const [total, setTotal] = useState<number | null>(null);
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
  }, [params?.category_id, params?.search, params?.tag, params?.root_only, params?.skip, params?.limit, showToast]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await api.getArticles(params);
        if (cancelled) return;
        setArticles(data);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Failed to fetch articles';
        setError(msg);
        showToast(msg, 'error');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params?.category_id, params?.search, params?.tag, params?.root_only, params?.skip, params?.limit, showToast]);

  // 分页模式：并行拉取服务器总数（过滤条件与列表一致）；未分页时清空
  const paginated = params?.limit != null;
  useEffect(() => {
    if (!paginated) {
      setTotal(null);
      return;
    }
    let cancelled = false;
    api.getArticlesCount({
      category_id: params?.category_id,
      search: params?.search,
      tag: params?.tag,
      root_only: params?.root_only,
    })
      .then(({ total: t }) => {
        if (!cancelled) setTotal(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paginated, params?.category_id, params?.search, params?.tag, params?.root_only]);

  const createArticle = async (data: ArticleCreate): Promise<Article | null> => {
    try {
      const article = await api.createArticle(data);
      // Only prepend to list if no active filter (or if article matches filter)
      setArticles((prev) => {
        const matchesCategory = !params?.category_id || article.category_id === params.category_id;
        // 多标签 AND：新文章必须包含全部筛选标签
        const matchesTag = !params?.tag?.length || params.tag.every((t) => article.tags.includes(t));
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

  return { articles, total, loading, error, createArticle, updateArticle, deleteArticle, refetch: fetchArticles };
}
