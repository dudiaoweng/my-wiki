import type { Article } from '../types/article';

export interface OrderedArticle {
  article: Article;
  depth: number;
}

/**
 * 按层级（目录 → 文章 → 子文章）排布文章列表：
 * - 根节点（无父文章，或父文章不在集合中）按 updated_at 降序；
 * - 子文章紧随其父文章之后（同层降序）；
 * - 数据异常成环时防御性跳过（visited 集合）。
 */
export function orderByHierarchy(articles: Article[]): OrderedArticle[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const childrenOf = new Map<string, Article[]>();
  const roots: Article[] = [];

  for (const a of articles) {
    if (a.parent_id && byId.has(a.parent_id)) {
      const list = childrenOf.get(a.parent_id) ?? [];
      list.push(a);
      childrenOf.set(a.parent_id, list);
    } else {
      roots.push(a);
    }
  }

  const byUpdatedDesc = (arr: Article[]) =>
    arr.sort((x, y) => y.updated_at.localeCompare(x.updated_at));

  const ordered: OrderedArticle[] = [];
  const visited = new Set<string>();
  const walk = (article: Article, depth: number) => {
    if (visited.has(article.id)) return; // 环防御
    visited.add(article.id);
    ordered.push({ article, depth });
    for (const child of byUpdatedDesc(childrenOf.get(article.id) ?? [])) {
      walk(child, depth + 1);
    }
  };

  for (const root of byUpdatedDesc(roots)) walk(root, 0);
  return ordered;
}
