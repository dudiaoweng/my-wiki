import { useState, useEffect, useCallback, useRef } from 'react';

export interface SearchOccurrence {
  index: number;
  ratio: number; // 0–1, character position / total text length
}

/**
 * Hook for in-article text search.
 * After the rehype plugin renders <mark data-search-occurrence> elements,
 * this hook collects them from the DOM and manages active-index tracking.
 */
export function useArticleSearch(searchTerm: string, _contentLength: number) {
  const [activeIndex, setActiveIndex] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Prevent IntersectionObserver from overriding manual navigation during scroll animation
  const isManualScrolling = useRef(false);
  const manualTimer = useRef<ReturnType<typeof setTimeout>>();

  // ── Compute occurrence list from DOM ──
  const [occurrences, setOccurrences] = useState<SearchOccurrence[]>([]);

  const hasTerm = searchTerm.trim().length > 0;

  useEffect(() => {
    if (!hasTerm) {
      setOccurrences([]);
      return;
    }

    // Wait for react-markdown re-render to complete
    const timer = setTimeout(() => {
      const container = document.getElementById('article-content');
      const marks = document.querySelectorAll('[data-search-occurrence]');
      const results: SearchOccurrence[] = [];

      // Use rendered text length (not raw markdown) for accurate ratio
      let totalLen = 1;
      if (container) {
        const fullRange = document.createRange();
        fullRange.selectNodeContents(container);
        totalLen = fullRange.toString().length || 1;
      }

      marks.forEach((el) => {
        const idxAttr = (el as HTMLElement).dataset.searchOccurrence;
        if (idxAttr !== undefined) {
          const idx = Number(idxAttr);
          // Estimate ratio from DOM position within the container
          if (container) {
            const range = document.createRange();
            range.setStart(container, 0);
            range.setEndBefore(el);
            const offset = range.toString().length;
            results.push({ index: idx, ratio: offset / totalLen });
          } else {
            results.push({ index: idx, ratio: 0 });
          }
        }
      });

      // Sort by index to ensure correct order
      results.sort((a, b) => a.index - b.index);
      setOccurrences(results);
    }, 80);

    return () => clearTimeout(timer);
  }, [searchTerm, hasTerm]);

  const count = occurrences.length;

  // ── Cleanup observer ──
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [searchTerm]);

  // ── IntersectionObserver: track which occurrence is nearest top ──
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!hasTerm || count === 0) {
      setActiveIndex(0);
      return;
    }

    const timer = setTimeout(() => {
      const visibleIndices = new Map<number, number>();

      const observer = new IntersectionObserver(
        (entries) => {
          // Don't override manual navigation during scroll animation
          if (isManualScrolling.current) return;

          for (const entry of entries) {
            const idxAttr = (entry.target as HTMLElement).dataset.searchOccurrence;
            if (idxAttr === undefined) continue;
            const idx = Number(idxAttr);
            if (entry.isIntersecting) {
              visibleIndices.set(idx, entry.boundingClientRect.top);
            } else {
              visibleIndices.delete(idx);
            }
          }

          if (visibleIndices.size > 0) {
            let bestIdx = 0;
            let bestTop = Infinity;
            for (const [idx, top] of visibleIndices) {
              if (top > 0 && top < bestTop) {
                bestTop = top;
                bestIdx = idx;
              }
            }
            if (!isFinite(bestTop)) {
              for (const [idx, top] of visibleIndices) {
                if (top < bestTop) {
                  bestTop = top;
                  bestIdx = idx;
                }
              }
            }
            setActiveIndex(bestIdx);
          }
        },
        { rootMargin: '-80px 0px -40% 0px', threshold: 0 },
      );

      const marks = document.querySelectorAll('[data-search-occurrence]');
      marks.forEach((el) => observer.observe(el));
      observerRef.current = observer;
    }, 100);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [searchTerm, count, hasTerm]);

  // ── Toggle .search-highlight-active class ──
  useEffect(() => {
    document
      .querySelectorAll('.search-highlight-active')
      .forEach((el) => el.classList.remove('search-highlight-active'));

    if (hasTerm && count > 0) {
      const activeEl = document.getElementById(`search-occurrence-${activeIndex}`);
      if (activeEl) {
        activeEl.classList.add('search-highlight-active');
      }
    }
  }, [searchTerm, count, activeIndex, hasTerm]);

  // ── Scroll to a specific occurrence ──
  const scrollToMatch = useCallback(
    (index: number) => {
      const el = document.getElementById(`search-occurrence-${index}`);
      if (!el) return;

      // Prevent IntersectionObserver from overriding during manual navigation
      isManualScrolling.current = true;
      if (manualTimer.current) clearTimeout(manualTimer.current);
      manualTimer.current = setTimeout(() => {
        isManualScrolling.current = false;
      }, 400);

      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      setActiveIndex(index);
    },
    [],
  );

  // Reset activeIndex when search term changes
  useEffect(() => {
    setActiveIndex(0);
    if (!hasTerm || count === 0) return;

    const timer = setTimeout(() => {
      const first = document.getElementById('search-occurrence-0');
      if (first) {
        first.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [searchTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  return { count, activeIndex, occurrences, scrollToMatch };
}
