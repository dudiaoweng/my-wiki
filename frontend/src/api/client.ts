import type { Article, ArticleCreate, ArticleUpdate } from '../types/article';
import type { Category, CategoryCreate } from '../types/category';
import type { Stats } from '../types/stats';
import type { GraphData } from '../types/graph';
import type { QARequest, QAResponse } from '../types/qa';

export interface EntityInfoItem {
  id: string;
  entity_name: string;
  category: string;
  content: string;
  created_at: string;
  updated_at: string;
}

const BASE = '/api';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, body.detail ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

function qs(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // ── Articles ──
  getArticles(params?: { category_id?: string; search?: string; tag?: string }) {
    return request<Article[]>(`/articles${params ? qs(params) : ''}`);
  },
  getArticle(id: string) {
    return request<Article>(`/articles/${id}`);
  },
  createArticle(data: ArticleCreate) {
    return request<Article>('/articles', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateArticle(id: string, data: ArticleUpdate) {
    return request<Article>(`/articles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  deleteArticle(id: string) {
    return request<void>(`/articles/${id}`, { method: 'DELETE' });
  },

  // ── Categories ──
  getCategories() {
    return request<Category[]>('/categories');
  },
  createCategory(data: CategoryCreate) {
    return request<Category>('/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // ── Tags ──
  getTags() {
    return request<string[]>('/tags');
  },

  // ── Stats ──
  getStats() {
    return request<Stats>('/stats');
  },

  // ── Tags (mutations) ──
  addTag(tag: string, articleIds: string[]) {
    return request<{ tag: string; count: number }>('/tags', {
      method: 'POST',
      body: JSON.stringify({ tag, article_ids: articleIds }),
    });
  },
  renameTag(oldName: string, newName: string) {
    return request<{ old: string; new: string; count: number }>('/tags/rename', {
      method: 'PUT',
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },
  removeTag(tag: string, articleIds?: string[]) {
    return request<{ tag: string; count: number }>('/tags/remove', {
      method: 'DELETE',
      body: JSON.stringify({ tag, article_ids: articleIds ?? null }),
    });
  },
  getTagsByArticle(articleIds?: string[]) {
    const qs = articleIds?.length ? `?article_ids=${articleIds.join(',')}` : '';
    return request<{ article_id: string; title: string; tags: string[] }[]>(`/tags/by-article${qs}`);
  },

  // ── Entities (mutations) ──
  addEntity(name: string, type: string, articleIds: string[]) {
    return request<{ name: string; type: string; count: number }>('/entities', {
      method: 'POST',
      body: JSON.stringify({ entity: { name, type }, article_ids: articleIds }),
    });
  },
  updateEntity(oldName: string, name?: string, type?: string) {
    return request<{ old: string; name: string | null; type: string | null; count: number }>('/entities/update', {
      method: 'PUT',
      body: JSON.stringify({ old_name: oldName, name: name ?? null, type: type ?? null }),
    });
  },
  renameEntity(oldName: string, newName: string) {
    return request<{ old: string; new: string; count: number }>('/entities/rename', {
      method: 'PUT',
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },
  removeEntity(entityName: string, articleIds?: string[]) {
    return request<{ entity: string; count: number }>('/entities/remove', {
      method: 'DELETE',
      body: JSON.stringify({ entity_name: entityName, article_ids: articleIds ?? null }),
    });
  },

  // ── Entity Info (附加信息) ──
  getEntityInfos(entityName: string) {
    return request<EntityInfoItem[]>(`/entities/${encodeURIComponent(entityName)}/info`);
  },
  createEntityInfo(entityName: string, category: string, content: string) {
    return request<EntityInfoItem>(`/entities/${encodeURIComponent(entityName)}/info`, {
      method: 'POST',
      body: JSON.stringify({ category, content }),
    });
  },
  updateEntityInfo(entityName: string, infoId: string, data: { category?: string; content?: string }) {
    return request<EntityInfoItem>(`/entities/${encodeURIComponent(entityName)}/info/${infoId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  deleteEntityInfo(entityName: string, infoId: string) {
    return request<void>(`/entities/${encodeURIComponent(entityName)}/info/${infoId}`, { method: 'DELETE' });
  },

  // ── Graph ──
  getGraphData() {
    return request<GraphData>('/graph');
  },

  // ── Q&A ──
  askQuestion(data: QARequest) {
    return request<QAResponse>('/qa/ask', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // ── Upload ──
  async uploadFile(file: File, categoryId?: string): Promise<Article> {
    const formData = new FormData();
    formData.append('file', file);
    if (categoryId) formData.append('category_id', categoryId);

    const res = await fetch(`${BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, body.detail ?? res.statusText);
    }

    return res.json();
  },
};
