import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Category, CategoryCreate } from '../types/category';
import { useToast } from './useToast';

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getCategories();
      setCategories(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch categories';
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const createCategory = async (data: CategoryCreate): Promise<Category | null> => {
    try {
      const cat = await api.createCategory(data);
      setCategories((prev) => [...prev, cat]);
      showToast(`分类「${cat.name}」已创建`, 'success');
      return cat;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create category';
      showToast(msg, 'error');
      return null;
    }
  };

  return { categories, loading, createCategory, refetch: fetchCategories };
}
