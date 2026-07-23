import { useState, useRef, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { useQA } from '../hooks/useQA';
import { useApp } from '../context/AppProvider';
import { useToast } from '../hooks/useToast';
import { ArticleDetailInline } from './ArticleDetailInline';
import type { FileContext } from '../types/qa';
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
    kbEnabled,
    setKbEnabled,
    fileContexts,
    addFileContext,
    removeFileContext,
    clearFileContexts,
    newSession,
    switchSession,
    deleteSession,
    askQuestion,
    clearHistory,
  } = useQA();

  const { sidebarOpen, closeSidebar } = useApp();
  const { showToast } = useToast();

  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewedArticleId, setViewedArticleId] = useState<string | null>(null);

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
    await askQuestion(q);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleExample = (q: string) => {
    setInput(q);
    askQuestion(q);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await addFileContext(file);
      showToast(`已上传「${file.name}」`, 'success');
    } catch {
      showToast('文件解析失败', 'error');
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
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
              <div key={msg.id ?? `msg-${i}`} className={msg.role === 'user' ? styles.userMsgGroup : styles.assistantMsgGroup}>
                <div
                  className={`${styles.message} ${msg.role === 'user' ? styles.user : styles.assistant}`}
                >
                  {isAssistant(msg) && (
                    <span className={styles.avatar}>🤖</span>
                  )}
                  <div className={`${styles.bubble} markdown-content`}>
                    {isAssistant(msg) ? (
                      <Markdown rehypePlugins={[rehypeRaw]}>{msg.content}</Markdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>

                {/* Sources attached to this answer */}
                {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                  <div className={`${styles.message} ${styles.assistant}`}>
                    <div className={styles.sources}>
                      <span style={{ fontSize: 11, color: 'var(--c-text-muted)', marginRight: 4 }}>
                        📎 参考来源:
                      </span>
                      {msg.sources.map((src) => (
                        <button
                          key={src.article_id}
                          className={styles.sourceCard}
                          onClick={() => setViewedArticleId(src.article_id)}
                          title={src.excerpt}
                        >
                          <span className={styles.sourceRelevance}>{Math.round(src.relevance * 100)}%</span>
                          {src.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}

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

        {/* ── Uploaded file chips ── */}
        {fileContexts.length > 0 && (
          <div className={styles.fileChips}>
            {fileContexts.map((fc: FileContext, i: number) => (
              <span key={i} className={styles.fileChip} title={fc.is_image ? fc.filename : fc.content.slice(0, 200)}>
                {fc.is_image ? '🖼' : '📎'} {fc.filename}
                <button
                  className={styles.fileChipRemove}
                  onClick={() => removeFileContext(i)}
                  title="移除"
                >✕</button>
              </span>
            ))}
            <button className={styles.fileChipClear} onClick={clearFileContexts} title="清除全部">
              清除全部
            </button>
          </div>
        )}

        <div className={styles.inputArea}>
          <button
            className={styles.clearBtn}
            onClick={clearHistory}
            disabled={messages.length === 0}
            title="清除对话"
          >
            清除
          </button>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            className={styles.fileInput}
            onChange={handleFileUpload}
            accept=".txt,.md,.json,.xml,.csv,.yaml,.yml,.py,.js,.ts,.html,.css,.docx,.xlsx,.xls,.pptx,.ppt,.pdf,.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.ico,.tiff,.tif,.mp3,.wav,.m4a,.flac,.ogg,.wma,.mp4,.avi,.mov,.mkv,.webm,.wmv"
            aria-label="上传文件作为问答上下文"
          />
          <button
            className={`${styles.kbToggle} ${kbEnabled ? styles.kbToggleOn : styles.kbToggleOff}`}
            onClick={() => setKbEnabled(!kbEnabled)}
            disabled={loading}
            title={kbEnabled ? '知识库已开启 — 点击关闭' : '知识库已关闭 — 点击开启'}
          >
            📚
          </button>
          <button
            className={styles.uploadBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="上传文件作为问答上下文"
          >
            📎
          </button>
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

      {/* ── Article detail modal ── */}
      {viewedArticleId && (
        <div className={styles.modalOverlay} onClick={() => setViewedArticleId(null)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <button className={styles.modalClose} onClick={() => setViewedArticleId(null)}>✕</button>
            <ArticleDetailInline articleId={viewedArticleId} onBack={() => setViewedArticleId(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
