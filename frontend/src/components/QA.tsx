import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import { useQA } from '../hooks/useQA';
import { useApp } from '../context/AppProvider';
import type { QASource } from '../types/qa';
import styles from './QA.module.css';

const EXAMPLE_QUESTIONS = [
  '什么是观察者模式？',
  'JavaScript 异步编程有哪些要点？',
  'React 组件设计有什么原则？',
  '如何配置开发环境？',
];

export function QA() {
  const {
    sessions,
    activeId,
    messages,
    loading,
    error,
    newSession,
    switchSession,
    deleteSession,
    askQuestion,
    clearHistory,
  } = useQA();

  const { sidebarOpen, closeSidebar } = useApp();

  const [input, setInput] = useState('');
  const [currentSources, setCurrentSources] = useState<QASource[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const handleSwitchSession = useCallback(
    (id: string) => {
      switchSession(id);
      closeSidebar();
    },
    [switchSession, closeSidebar]
  );

  const handleNewSession = useCallback(() => {
    newSession();
    closeSidebar();
  }, [newSession, closeSidebar]);

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input on mount and when switching sessions
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');
    setCurrentSources([]);
    const result = await askQuestion(q);
    if (result) {
      setCurrentSources(result.sources);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleExample = (q: string) => {
    setInput(q);
    askQuestion(q).then((result) => {
      if (result) setCurrentSources(result.sources);
    });
  };

  const isAssistant = (msg: { role: string }) => msg.role === 'assistant';

  return (
    <div className={styles.page}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className={styles.overlay} onClick={closeSidebar} />
      )}

      {/* ── Session sidebar ── */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <button className={styles.newChatBtn} onClick={handleNewSession}>
          <span>+</span> 新对话
        </button>
        <div className={styles.sessionList}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles.sessionItem} ${s.id === activeId ? styles.sessionActive : ''}`}
              onClick={() => handleSwitchSession(s.id)}
            >
              <span className={styles.sessionTitle}>{s.title}</span>
              <button
                className={styles.sessionDel}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
                title="删除会话"
              >
                ✕
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className={styles.sessionEmpty}>暂无对话记录</div>
          )}
        </div>
      </aside>

      {/* ── Chat area ── */}
      <div className={styles.chatArea}>
        {messages.length === 0 && !loading ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>💬</div>
            <h4>向知识库提问</h4>
            <p>我会从你的知识库中检索相关信息来回答问题。尝试以下问题或输入你自己的问题：</p>
            <div className={styles.examples}>
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  className={styles.exampleBtn}
                  onClick={() => handleExample(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.chat}>
            {messages.map((msg, i) => (
              <div
                key={msg.id ?? `msg-${i}`}
                className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}
              >
                {isAssistant(msg) && (
                  <span className={styles.avatar}>🤖</span>
                )}
                <div className={styles.bubble}>
                  {isAssistant(msg) ? (
                    <Markdown>{msg.content}</Markdown>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {/* Sources for the last assistant message */}
            {currentSources.length > 0 && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.sources}>
                  <span style={{ fontSize: 11, color: 'var(--c-text-muted)', marginRight: 4 }}>
                    📎 参考来源:
                  </span>
                  {currentSources.map((src) => (
                    <button
                      key={src.article_id}
                      className={styles.sourceCard}
                      onClick={() => navigate(`/articles/${src.article_id}`)}
                      title={src.excerpt}
                    >
                      <span className={styles.sourceRelevance}>{Math.round(src.relevance * 100)}%</span>
                      {src.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loading && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.bubble}>
                  <div className={styles.typing}>
                    <div className={styles.typingDot} />
                    <div className={styles.typingDot} />
                    <div className={styles.typingDot} />
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.bubble} style={{ color: 'var(--c-danger)' }}>
                  ⚠️ {error}
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>
        )}

        <div className={styles.inputArea}>
          {messages.length > 0 && (
            <button className={styles.clearBtn} onClick={clearHistory} title="清除对话">
              清除
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="输入你的问题… (Enter 发送)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {loading ? '思考中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
