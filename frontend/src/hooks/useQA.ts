import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { QAMessage, QAResponse, FileContext } from '../types/qa';

export interface QASession {
  id: string;
  title: string;
  messages: QAMessage[];
  createdAt: number;
}

/** Build user-scoped localStorage keys so each user has independent sessions. */
function keys(userId: string) {
  const ns = userId ? `qa_${userId}` : 'qa';
  return {
    sessions: `${ns}_sessions`,
    activeId: `${ns}_active_id`,
    fileContexts: `${ns}_file_contexts`,
  };
}

function loadSessions(userId: string): Record<string, QASession> {
  try {
    const raw = localStorage.getItem(keys(userId).sessions);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt data — start fresh */ }
  return {};
}

function loadActiveId(userId: string): string | null {
  try {
    return localStorage.getItem(keys(userId).activeId);
  } catch { return null; }
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeTitle(question: string): string {
  return question.slice(0, 30) + (question.length > 30 ? '…' : '');
}

export function useQA(userId: string = '') {
  const _keys = keys(userId);

  const [sessions, setSessions] = useState<Record<string, QASession>>(() => loadSessions(userId));
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveId(userId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbEnabled, setKbEnabled] = useState(true);

  // Persist to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(_keys.sessions, JSON.stringify(sessions));
    } catch { /* quota exceeded — silently ignore */ }
  }, [sessions, _keys.sessions]);

  useEffect(() => {
    try {
      if (activeId) {
        localStorage.setItem(_keys.activeId, activeId);
      } else {
        localStorage.removeItem(_keys.activeId);
      }
    } catch { /* ignore */ }
  }, [activeId, _keys.activeId]);

  const activeSession = activeId && sessions[activeId] ? sessions[activeId] : undefined;
  const messages = activeSession?.messages ?? [];

  // ── File contexts (per session, persist to localStorage) ──
  const [fileContexts, setFileContexts] = useState<Record<string, FileContext[]>>(() => {
    try {
      const raw = localStorage.getItem(_keys.fileContexts);
      if (!raw) return {};
      const data = JSON.parse(raw);
      // Purge entries without file_id (legacy data before async processing)
      let changed = false;
      for (const sid of Object.keys(data)) {
        if (Array.isArray(data[sid])) {
          data[sid] = data[sid].filter((fc: FileContext) => {
            if (!fc.file_id) { changed = true; return false; }
            return true;
          });
        }
      }
      if (changed) {
        try { localStorage.setItem(_keys.fileContexts, JSON.stringify(data)); } catch {}
      }
      return data;
    } catch { return {}; }
  });

  const currentFileContexts = activeId ? (fileContexts[activeId] ?? []) : [];

  // Ref to track active polling timers so we can cancel them on unmount
  const pollingTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      pollingTimers.current.forEach(clearTimeout);
      pollingTimers.current.clear();
    };
  }, []);

  /** Poll a file's processing status until done or error. */
  const pollFileUntilDone = useCallback((fileId: string, sessionId: string, attempts: number = 0) => {
    if (!fileId || fileId === 'undefined') return;  // Guard against corrupted data
    const MAX_ATTEMPTS = 90;  // ~3 minutes at 2s intervals
    if (attempts >= MAX_ATTEMPTS) {
      setFileContexts((prev) => {
        const list = [...(prev[sessionId] ?? [])];
        const idx = list.findIndex(fc => fc.file_id === fileId);
        if (idx >= 0) list[idx] = { ...list[idx], content: '[文件处理超时，请重试]', status: 'error' };
        const updated = { ...prev, [sessionId]: list };
        try { localStorage.setItem(_keys.fileContexts, JSON.stringify(updated)); } catch {}
        return updated;
      });
      return;
    }

    const timer = setTimeout(async () => {
      pollingTimers.current.delete(timer);
      try {
        const status = await api.getFileStatus(fileId);
        if (status.status === 'done') {
          setFileContexts((prev) => {
            if (!prev[sessionId]) return prev;  // session deleted
            const list = [...prev[sessionId]];
            const idx = list.findIndex(fc => fc.file_id === fileId);
            if (idx >= 0) {
              list[idx] = { ...list[idx], content: status.content!, content_type: status.content_type, is_image: status.is_image, status: 'done', media_url: status.media_url, thumb_url: status.thumb_url };
            }
            const updated = { ...prev, [sessionId]: list };
            try { localStorage.setItem(_keys.fileContexts, JSON.stringify(updated)); } catch {}
            return updated;
          });
          return;
        }
        if (status.status === 'error') {
          setFileContexts((prev) => {
            if (!prev[sessionId]) return prev;
            const list = [...prev[sessionId]];
            const idx = list.findIndex(fc => fc.file_id === fileId);
            if (idx >= 0) {
              list[idx] = { ...list[idx], content: `[文件解析失败: ${status.error}]`, status: 'error' };
            }
            const updated = { ...prev, [sessionId]: list };
            try { localStorage.setItem(_keys.fileContexts, JSON.stringify(updated)); } catch {}
            return updated;
          });
          return;
        }
        // Still processing — poll again
        pollFileUntilDone(fileId, sessionId, attempts + 1);
      } catch {
        // Network error — retry
        pollFileUntilDone(fileId, sessionId, attempts + 1);
      }
    }, 2000);

    pollingTimers.current.add(timer);
  }, []);

  const addFileContext = useCallback(async (file: File) => {
    // Capture session id synchronously — avoid stale closure after await
    const sessionId = activeId;
    if (!sessionId) throw new Error('请先开始对话');

    // Phase 1: upload file, get back a file_id immediately
    const result = await api.parseFileForQA(file);

    // Phase 2: add placeholder to state, start background polling
    setFileContexts((prev) => {
      const fc: FileContext = {
        file_id: result.file_id,
        filename: result.filename,
        content: '' /* filled by polling */,
        content_type: result.content_type,
        is_image: result.is_image,
        status: 'processing',
        media_url: result.media_url,
      };
      const updated = { ...prev, [sessionId]: [...(prev[sessionId] ?? []), fc] };
      try { localStorage.setItem(_keys.fileContexts, JSON.stringify(updated)); } catch {}
      return updated;
    });

    // Kick off background polling for this file
    pollFileUntilDone(result.file_id, sessionId);
  }, [activeId, pollFileUntilDone]);

  const removeFileContext = useCallback((index: number) => {
    if (!activeId) return;
    setFileContexts((prev) => {
      const list = [...(prev[activeId] ?? [])];
      list.splice(index, 1);
      const updated = { ...prev, [activeId]: list };
      try {
        localStorage.setItem(_keys.fileContexts, JSON.stringify(updated));
      } catch { /* quota exceeded */ }
      return updated;
    });
  }, [activeId]);

  const clearFileContexts = useCallback(() => {
    if (!activeId) return;
    setFileContexts((prev) => {
      const updated = { ...prev, [activeId]: [] };
      try {
        localStorage.setItem(_keys.fileContexts, JSON.stringify(updated));
      } catch { /* quota exceeded */ }
      return updated;
    });
  }, [activeId]);

  const sessionList = useMemo(
    () =>
      Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt),
    [sessions]
  );

  /** Create a new session and switch to it */
  const newSession = useCallback(() => {
    const id = makeId();
    setSessions((prev) => ({
      ...prev,
      [id]: { id, title: '新对话', messages: [], createdAt: Date.now() },
    }));
    setActiveId(id);
    setError(null);
  }, []);

  /** Switch to an existing session */
  const switchSession = useCallback((id: string) => {
    setActiveId(id);
    setError(null);
  }, []);

  /** Delete a session */
  const deleteSession = useCallback(
    (id: string) => {
      let nextActive: string | null = null;
      setSessions((prev) => {
        const { [id]: _, ...rest } = prev;
        const remaining = Object.values(rest).sort((a, b) => b.createdAt - a.createdAt);
        nextActive = remaining.length > 0 ? remaining[0].id : null;
        return rest;
      });
      setActiveId((prev) => (prev === id ? nextActive : prev));
      // Clean up file contexts for the deleted session
      setFileContexts((prev) => {
        const { [id]: _, ...rest } = prev;
        localStorage.setItem(_keys.fileContexts, JSON.stringify(rest));
        return rest;
      });
    },
    []
  );

  const askQuestion = useCallback(
    async (question: string): Promise<QAResponse | null> => {
      // Ensure a session exists
      let sid = activeId;
      if (!sid) {
        sid = makeId();
        setSessions((prev) => ({
          ...prev,
          [sid!]: { id: sid!, title: makeTitle(question), messages: [], createdAt: Date.now() },
        }));
        setActiveId(sid);
      }

      const userMsg: QAMessage & { id: string } = { id: makeId(), role: 'user', content: question };

      // Update title if first message
      setSessions((prev) => {
        const s = prev[sid!];
        if (!s) return prev;
        const isFirst = s.messages.length === 0;
        return {
          ...prev,
          [sid!]: {
            ...s,
            title: isFirst ? makeTitle(question) : s.title,
            messages: [...s.messages, userMsg],
          },
        };
      });

      setLoading(true);
      setError(null);

      try {
        // Use the session's existing messages (before the user msg was added) for history
        const history = (sessions[sid]?.messages ?? []).slice(-20);
        // Only include files that have finished processing (skip 'processing' ones)
        const fcs = (fileContexts[sid] ?? []).filter(fc => fc.status !== 'processing');
        const result = await api.askQuestion({
          question,
          history,
          file_contexts: fcs.length > 0 ? fcs : undefined,
          kb_enabled: kbEnabled,
        });

        const assistantMsg: QAMessage & { id: string } = {
          id: makeId(),
          role: 'assistant',
          content: result.answer,
          sources: result.sources.filter(s => s.relevance >= 0.4).length > 0
            ? result.sources.filter(s => s.relevance >= 0.4)
            : undefined,
        };
        setSessions((prev) => {
          const s = prev[sid];
          if (!s) return prev;
          return {
            ...prev,
            [sid]: { ...s, messages: [...s.messages, assistantMsg] },
          };
        });

        return result;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to get answer';
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [activeId, sessions, fileContexts, kbEnabled]
  );

  const clearHistory = useCallback(() => {
    if (!activeId) return;
    setSessions((prev) => {
      const s = prev[activeId];
      if (!s) return prev;
      return { ...prev, [activeId]: { ...s, messages: [] } };
    });
    setError(null);
  }, [activeId]);

  return {
    sessions: sessionList,
    activeId,
    activeSession,
    messages,
    loading,
    error,
    fileContexts: currentFileContexts,
    kbEnabled,
    setKbEnabled,
    addFileContext,
    removeFileContext,
    clearFileContexts,
    newSession,
    switchSession,
    deleteSession,
    askQuestion,
    clearHistory,
  };
}
