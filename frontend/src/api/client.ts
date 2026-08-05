import type { Article, ArticleCreate, ArticleUpdate } from '../types/article';
import type { Category, CategoryCreate } from '../types/category';
import type { Stats } from '../types/stats';
import type { GraphData } from '../types/graph';
import type { QARequest, QAResponse, FileParseResult, FileStatusResult } from '../types/qa';
import { getDevUserHeader } from './auth';

export interface EntityInfoItem {
  id: string;
  entity_name: string;
  name: string;
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

/** Inject X-Dev-User header so the Vite proxy picks the right client cert (dev mode). */
function mergeHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const user = getDevUserHeader();
  if (user) headers.set('X-Dev-User', user);
  return headers;
}

/** Handle API error responses — extract detail, dispatch auth:forbidden on 403. */
async function handleError(res: Response): Promise<never> {
  if (res.status === 403) {
    window.dispatchEvent(new CustomEvent('auth:forbidden'));
  }
  const body = await res.json().catch(() => ({ detail: res.statusText }));
  let detail = body.detail ?? res.statusText;
  if (Array.isArray(detail)) {
    detail = detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
  }
  throw new ApiError(res.status, detail);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { headers: customHeaders, ...restOpts } = options ?? {};
  const headers = mergeHeaders(customHeaders);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${BASE}${path}`, {
    ...restOpts,
    headers,
  });

  if (!res.ok) {
    return handleError(res);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

function qs(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
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
  async createArticle(data: ArticleCreate, files?: File[]): Promise<Article> {
    const formData = new FormData();
    formData.append('title', data.title);
    formData.append('content', data.content);
    formData.append('category_id', data.category_id ?? '');
    formData.append('tags', JSON.stringify(data.tags));
    if (files) {
      for (const f of files) formData.append('files', f);
    }

    const res = await fetch(`${BASE}/articles`, {
      method: 'POST',
      headers: mergeHeaders(),
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      let detail = body.detail ?? res.statusText;
      if (Array.isArray(detail)) {
        detail = detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
      }
      throw new ApiError(res.status, detail);
    }

    return res.json();
  },
  async updateArticle(id: string, data: ArticleUpdate, files?: File[], keepAttachments?: string[]): Promise<Article> {
    const formData = new FormData();
    if (data.title !== undefined) formData.append('title', data.title);
    if (data.content !== undefined) formData.append('content', data.content);
    if (data.category_id !== undefined) formData.append('category_id', data.category_id ?? '');
    if (data.tags !== undefined) formData.append('tags', JSON.stringify(data.tags));
    if (files) {
      for (const f of files) formData.append('files', f);
    }
    if (keepAttachments !== undefined) {
      formData.append('keep_attachments', JSON.stringify(keepAttachments));
    }

    const res = await fetch(`${BASE}/articles/${id}`, {
      method: 'PUT',
      headers: mergeHeaders(),
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      let detail = body.detail ?? res.statusText;
      if (Array.isArray(detail)) {
        detail = detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
      }
      throw new ApiError(res.status, detail);
    }

    return res.json();
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
  updateCategory(id: string, data: CategoryCreate) {
    return request<Category>(`/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  deleteCategory(id: string) {
    return request<void>(`/categories/${id}`, { method: 'DELETE' });
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
      method: 'POST',
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
  createEntityInfo(entityName: string, name: string, content: string) {
    return request<EntityInfoItem>(`/entities/${encodeURIComponent(entityName)}/info`, {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    });
  },
  updateEntityInfo(entityName: string, infoId: string, data: { name?: string; content?: string }) {
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

  async parseFileForQA(file: File): Promise<FileParseResult> {
    const formData = new FormData();
    formData.append('file', file);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);  // 10s timeout for upload only (processing is async)
    try {
      const res = await fetch(`${BASE}/qa/parse-file`, {
        method: 'POST',
        headers: mergeHeaders(),
        body: formData,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new ApiError(res.status, body.detail ?? res.statusText);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  async getFileStatus(fileId: string): Promise<FileStatusResult> {
    const res = await fetch(`${BASE}/qa/file-status/${encodeURIComponent(fileId)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, body.detail ?? res.statusText);
    }
    return res.json();
  },

  // ── Upload ──
  async uploadFile(file: File, categoryId?: string): Promise<Article> {
    const formData = new FormData();
    formData.append('file', file);
    if (categoryId) formData.append('category_id', categoryId);

    const res = await fetch(`${BASE}/upload`, {
      method: 'POST',
      headers: mergeHeaders(),
      body: formData,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      throw new ApiError(res.status, body.detail ?? res.statusText);
    }

    return res.json();
  },
};
