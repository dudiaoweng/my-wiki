import type { Category } from './category';
import type { CommentSummary } from './comment';

export interface EntityItem {
  name: string;
  type: string;
}

export interface EntityRelation {
  source: string;
  target: string;
  label: string;
}

export interface ArticleEntities {
  entities: EntityItem[];
  relations: EntityRelation[];
}

/** 面包屑/子文章导航条目（后端计算）。 */
export interface ArticleBreadcrumbItem {
  id: string;
  title: string;
}

/** 子文章树节点（详情页树形展示用，递归嵌套）。 */
export interface ArticleChildNode {
  id: string;
  title: string;
  /** 创建人（证书 CN，格式「姓名 身份证号」） */
  created_by: string | null;
  /** 最后更新时间（ISO 字符串） */
  updated_at: string;
  children: ArticleChildNode[];
}

export interface Article {
  id: string;
  title: string;
  content: string;
  category_id: string | null;
  /** 父文章 ID（同目录内嵌套；null = 顶级文章） */
  parent_id: string | null;
  /** 祖先链（根→直接父，后端计算） */
  ancestors: ArticleBreadcrumbItem[];
  /** 直接子文章（后端计算） */
  children: ArticleBreadcrumbItem[];
  /** 子文章递归树（含全部子孙，后端计算） */
  children_tree: ArticleChildNode[];
  tags: string[];
  entities: ArticleEntities | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  category: Category | null;
  attachment_name: string | null;
  attachment_type: string | null;
  processing: string | null;
  comment_count?: number;
  latest_comments?: CommentSummary[];
}

/** 文章正文的单个向量分段。 */
export interface ArticleChunkInfo {
  id: string;
  /** 分块序号（如 "0"、"1"、"1.2"） */
  index: string;
  text: string;
  chars: number;
  /** null = Qdrant 不可用，无法确认 */
  embedded: boolean | null;
}

/** 文章向量化分段情况。 */
export interface ArticleChunksResponse {
  article_id: string;
  total: number;
  embedded_count: number;
  qdrant_available: boolean;
  vector_dim: number | null;
  max_chunk_chars: number;
  chunk_overlap: number;
  chunks: ArticleChunkInfo[];
}

export interface ArticleCreate {
  title: string;
  content: string;
  category_id: string | null;
  parent_id?: string | null;
  tags: string[];
  entities?: ArticleEntities | null;
}

export interface ArticleUpdate {
  title?: string;
  content?: string;
  category_id?: string | null;
  parent_id?: string | null;
  tags?: string[];
  entities?: ArticleEntities | null;
}
