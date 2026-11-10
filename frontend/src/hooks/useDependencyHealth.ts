import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DependencyHealth } from '../types/health';

/**
 * 轮询 Neo4j / Qdrant 连接状态（默认 30s，窗口重新聚焦时立即检测）。
 * 探测接口失败时保留上次结果；从未成功则按异常处理。
 */
export function useDependencyHealth(intervalMs = 30000) {
  const [health, setHealth] = useState<DependencyHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setChecking(true);
    try {
      const next = await api.getDependencyHealth();
      if (mountedRef.current) setHealth(next);
    } catch {
      if (mountedRef.current) {
        setHealth((prev) => prev ?? { neo4j: false, qdrant: false });
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, intervalMs]);

  return { health, checking, refresh };
}
