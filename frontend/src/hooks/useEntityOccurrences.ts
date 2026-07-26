import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

export interface Occurrence {
  index: number;
  ratio: number; // 0–1, character position / total text length
}

export function useEntityOccurrences(content: string, entityName: string | null) {
  const [activeIndex, setActiveIndex] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // ── Compute occurrence list from raw text ──
  const occurrences = useMemo<Occurrence[]>(() => {
    if (!entityName || !content) return [];

    const escaped = entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const results: Occurrence[] = [];
    const totalLen = content.length;

    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = regex.exec(content)) !== null) {
      results.push({ index: idx, ratio: totalLen > 0 ? m.index / totalLen : 0 });
      idx++;
    }

    return results;
  }, [content, entityName]);

  const count = occurrences.length;

  // ── Cleanup observer on unmount / entity change ──
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [entityName]);

  // ── IntersectionObserver: track which occurrence is nearest top ──
  useEffect(() => {
    // Disconnect previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!entityName || count === 0) {
      setActiveIndex(0);
      return;
    }

    // Small delay to let react-markdown re-render complete
    const timer = setTimeout(() => {
      const visibleIndices = new Map<number, number>(); // index → top offset

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const idxAttr = (entry.target as HTMLElement).dataset.entityOccurrence;
            if (idxAttr === undefined) continue;
            const idx = Number(idxAttr);
            if (entry.isIntersecting) {
              visibleIndices.set(idx, entry.boundingClientRect.top);
            } else {
              visibleIndices.delete(idx);
            }
          }

          if (visibleIndices.size > 0) {
            // Pick the occurrence nearest to the top (smallest positive top)
            let bestIdx = 0;
            let bestTop = Infinity;
            for (const [idx, top] of visibleIndices) {
              if (top > 0 && top < bestTop) {
                bestTop = top;
                bestIdx = idx;
              }
            }
            // If all are above viewport, pick the last one
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

      const marks = document.querySelectorAll('[data-entity-occurrence]');
      marks.forEach((el) => observer.observe(el));
      observerRef.current = observer;
    }, 50);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [entityName, count]);

  // ── Toggle .entity-highlight-active class on the current element ──
  useEffect(() => {
    // Remove active class from all occurrences
    document
      .querySelectorAll('.entity-highlight-active')
      .forEach((el) => el.classList.remove('entity-highlight-active'));

    // Add to the current one
    if (entityName && count > 0) {
      const activeEl = document.getElementById(`entity-occurrence-${activeIndex}`);
      if (activeEl) {
        activeEl.classList.add('entity-highlight-active');
      }
    }
  }, [entityName, count, activeIndex]);

  // ── Scroll to a specific occurrence ──
  const scrollToOccurrence = useCallback((index: number) => {
    const el = document.getElementById(`entity-occurrence-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setActiveIndex(index);
    }
  }, []);

  // Reset activeIndex and scroll to first occurrence when entity changes
  useEffect(() => {
    setActiveIndex(0);
    if (!entityName || count === 0) return;

    // Wait for react-markdown re-render to complete
    const timer = setTimeout(() => {
      const first = document.getElementById('entity-occurrence-0');
      if (first) {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [entityName]); // eslint-disable-line react-hooks/exhaustive-deps

  return { count, activeIndex, occurrences, scrollToOccurrence };
}
