import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Stats } from '../types/stats';

const STORAGE_KEY = 'kb_stats';

/** 与智能问答一致：统计值缓存到 localStorage，页面切换不清理，进入即显示旧值并后台刷新。 */
function loadCached(): Stats | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt data — ignore */ }
  return null;
}

export function useStats() {
  const [stats, setStats] = useState<Stats | null>(loadCached);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getStats();
      setStats(data);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch { /* quota exceeded — silently ignore */ }
    } catch {
      setError('Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, error, refetch: fetchStats };
}
