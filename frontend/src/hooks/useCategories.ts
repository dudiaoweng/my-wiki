import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import type { Category, CategoryCreate } from '../types/category';
import { useApp } from '../context/AppProvider';
import { useToast } from './useToast';

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();
  const { categoriesVersion, notifyCategoriesChanged } = useApp();

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCategories();
      setCategories(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch categories';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // Initial fetch
  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  // Refetch when another component modifies categories (skip initial)
  const initialRender = useRef(true);
  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    if (categoriesVersion > 0) {
      fetchCategories();
    }
  }, [categoriesVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const createCategory = async (data: CategoryCreate): Promise<Category | null> => {
    try {
      const cat = await api.createCategory(data);
      setCategories((prev) => [...prev, cat]);
      notifyCategoriesChanged();
      showToast(`分类「${cat.name}」已创建`, 'success');
      return cat;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create category';
      showToast(msg, 'error');
      return null;
    }
  };

  const updateCategory = async (id: string, data: CategoryCreate): Promise<Category | null> => {
    try {
      const updated = await api.updateCategory(id, data);
      setCategories((prev) => prev.map((c) => (c.id === id ? updated : c)));
      notifyCategoriesChanged();
      showToast(`分类「${updated.name}」已更新`, 'success');
      return updated;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to update category';
      showToast(msg, 'error');
      return null;
    }
  };

  const deleteCategory = async (id: string): Promise<boolean> => {
    try {
      await api.deleteCategory(id);
      setCategories((prev) => prev.filter((c) => c.id !== id));
      notifyCategoriesChanged();
      showToast('分类已删除', 'success');
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to delete category';
      showToast(msg, 'error');
      return false;
    }
  };

  return { categories, loading, error, createCategory, updateCategory, deleteCategory, refetch: fetchCategories };
}
