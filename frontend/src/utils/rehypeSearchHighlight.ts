import type { Plugin } from 'unified';

/**
 * Create a rehype plugin that wraps all occurrences of `searchTerm`
 * in <mark class="search-highlight" data-search-occurrence="N"
 * id="search-occurrence-N"> elements within text nodes.
 *
 * - Skips <code>, <pre>, <style>, <script>, <svg> subtrees.
 * - Case-insensitive matching.
 * - Returns a no-op plugin when searchTerm is null/empty.
 */
export function createSearchHighlightPlugin(searchTerm: string | null): Plugin {
  if (!searchTerm) {
    return function noop() {
      return function transform() {
        /* no-op: no search term */
      };
    };
  }

  const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'gi');
  const SKIP_TAGS = new Set(['code', 'pre', 'style', 'script', 'svg', 'mark']);

  return function searchHighlightAttacher() {
    let occurrenceIndex = 0;

    return function transform(tree: any) {
      occurrenceIndex = 0;
      processChildren(tree.children);

      function processChildren(children: any[]): void {
        if (!children) return;

        for (let i = 0; i < children.length; i++) {
          const node = children[i];

          if (node.type === 'element') {
            if (!SKIP_TAGS.has(node.tagName)) {
              processChildren(node.children);
            }
            continue;
          }

          if (node.type !== 'text') continue;

          const text: string = node.value;
          const matches: Array<{ start: number; end: number }> = [];
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(text)) !== null) {
            matches.push({ start: m.index, end: m.index + m[0].length });
          }

          if (matches.length === 0) continue;

          const replacements: any[] = [];
          let lastEnd = 0;

          for (const match of matches) {
            if (match.start > lastEnd) {
              replacements.push({
                type: 'text',
                value: text.slice(lastEnd, match.start),
              });
            }
            replacements.push({
              type: 'element',
              tagName: 'mark',
              properties: {
                className: ['search-highlight'],
                'data-search-occurrence': occurrenceIndex,
                id: `search-occurrence-${occurrenceIndex}`,
              },
              children: [{ type: 'text', value: text.slice(match.start, match.end) }],
            });
            occurrenceIndex++;
            lastEnd = match.end;
          }

          if (lastEnd < text.length) {
            replacements.push({ type: 'text', value: text.slice(lastEnd) });
          }

          children.splice(i, 1, ...replacements);
          i += replacements.length - 1;
        }
      }
    };
  };
}
