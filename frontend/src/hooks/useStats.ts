import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Stats } from '../types/stats';

export function useStats() {
  const [stats, setStats] = useState<Stats>({ article_count: 0, category_count: 0, tag_count: 0 });
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getStats();
      setStats(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, refetch: fetchStats };
}
