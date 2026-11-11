import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import type { GraphData } from '../types/graph';

export function useGraphData() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 请求序号：快速切换视图/连续刷新时丢弃过期响应，避免旧数据覆盖新数据
  const reqSeqRef = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getGraphData();
      if (seq === reqSeqRef.current) setData(result);
    } catch (e: unknown) {
      if (seq === reqSeqRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load graph data');
      }
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
