import { Fragment, useMemo } from 'react';

interface HighlightTextProps {
  text: string;
  /** 搜索关键词（支持多个；内部按空白拆分为独立词） */
  terms?: Array<string | null | undefined>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 搜索关键词醒目标识：将文本中命中的词包裹为 <mark class="search-term-highlight">。
 * 用于侧边栏文章/目录名、文章列表卡片标题与摘要、文章详情标题与子文章树。
 */
export function HighlightText({ text, terms }: HighlightTextProps) {
  const matcher = useMemo(() => {
    const words = Array.from(new Set(
      (terms ?? [])
        .flatMap((t) => (t ?? '').split(/\s+/))
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    )).sort((a, b) => b.length - a.length);
    if (!text || words.length === 0) return null;
    return {
      regex: new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi'),
      words: new Set(words),
    };
  }, [text, terms]);

  if (!matcher) return <>{text}</>;

  return (
    <>
      {text.split(matcher.regex).map((part, i) =>
        matcher.words.has(part.toLowerCase()) ? (
          <mark key={i} className="search-term-highlight">{part}</mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
