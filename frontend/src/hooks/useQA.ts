import { useState, useCallback, useMemo, useEffect } from 'react';
import { api } from '../api/client';
import type { QAMessage, QAResponse, FileContext } from '../types/qa';

export interface QASession {
  id: string;
  title: string;
  messages: QAMessage[];
  createdAt: number;
}

const STORAGE_KEY = 'qa_sessions';
const ACTIVE_KEY = 'qa_active_id';
const FILE_CTX_KEY = 'qa_file_contexts';

function loadSessions(): Record<string, QASession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt data — start fresh */ }
  return {};
}

function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch { return null; }
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeTitle(question: string): string {
  return question.slice(0, 30) + (question.length > 30 ? '…' : '');
}

export function useQA() {
  const [sessions, setSessions] = useState<Record<string, QASession>>(loadSessions);
  const [activeId, setActiveId] = useState<string | null>(loadActiveId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbEnabled, setKbEnabled] = useState(true);

  // Persist to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch { /* quota exceeded — silently ignore */ }
  }, [sessions]);

  useEffect(() => {
    try {
      if (activeId) {
        localStorage.setItem(ACTIVE_KEY, activeId);
      } else {
        localStorage.removeItem(ACTIVE_KEY);
      }
    } catch { /* ignore */ }
  }, [activeId]);

  const activeSession = activeId && sessions[activeId] ? sessions[activeId] : undefined;
  const messages = activeSession?.messages ?? [];

  // ── File contexts (per session, persist to localStorage) ──
  const [fileContexts, setFileContexts] = useState<Record<string, FileContext[]>>(() => {
    try {
      const raw = localStorage.getItem(FILE_CTX_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const currentFileContexts = activeId ? (fileContexts[activeId] ?? []) : [];

  const addFileContext = useCallback(async (file: File) => {
    try {
      const result = await api.parseFileForQA(file);
      if (!activeId) return;
      setFileContexts((prev) => {
        const updated = { ...prev, [activeId]: [...(prev[activeId] ?? []), result] };
        localStorage.setItem(FILE_CTX_KEY, JSON.stringify(updated));
        return updated;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '文件解析失败';
      throw new Error(msg);
    }
  }, [activeId]);

  const removeFileContext = useCallback((index: number) => {
    if (!activeId) return;
    setFileContexts((prev) => {
      const list = [...(prev[activeId] ?? [])];
      list.splice(index, 1);
      const updated = { ...prev, [activeId]: list };
      localStorage.setItem(FILE_CTX_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [activeId]);

  const clearFileContexts = useCallback(() => {
    if (!activeId) return;
    setFileContexts((prev) => {
      const updated = { ...prev, [activeId]: [] };
      localStorage.setItem(FILE_CTX_KEY, JSON.stringify(updated));
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
      setSessions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setActiveId((prev) => {
        if (prev !== id) return prev;
        // Switch to the most recent remaining session
        const remaining = Object.values(sessions)
          .filter((s) => s.id !== id)
          .sort((a, b) => b.createdAt - a.createdAt);
        return remaining.length > 0 ? remaining[0].id : null;
      });
    },
    [sessions]
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
        const fcs = fileContexts[sid] ?? [];
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
