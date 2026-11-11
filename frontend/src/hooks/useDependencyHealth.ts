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
  const checkInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // 请求序号：手动检测优先于普通读取，过期响应不覆盖新快照
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightRef.current || checkInFlightRef.current) return;
    inFlightRef.current = true;
    const seq = ++seqRef.current;
    setChecking(true);
    try {
      const next = await api.getDependencyHealth();
      if (mountedRef.current && seq === seqRef.current) setHealth(next);
    } catch {
      if (mountedRef.current && seq === seqRef.current) {
        setHealth((prev) => prev ?? { neo4j: false, qdrant: false });
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && !checkInFlightRef.current) setChecking(false);
    }
  }, []);

  /** 手动触发一次后端检测（POST），返回最新快照；失败时抛出供调用方提示。 */
  const check = useCallback(async () => {
    checkInFlightRef.current = true;
    const seq = ++seqRef.current;
    setChecking(true);
    try {
      const next = await api.checkDependencyHealth();
      if (mountedRef.current && seq === seqRef.current) setHealth(next);
      return next;
    } catch (e) {
      if (mountedRef.current && seq === seqRef.current) {
        setHealth((prev) => prev ?? { neo4j: false, qdrant: false });
      }
      throw e;
    } finally {
      checkInFlightRef.current = false;
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

  return { health, checking, refresh, check };
}
