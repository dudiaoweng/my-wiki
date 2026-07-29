import type { Category } from './category';

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

export interface Article {
  id: string;
  title: string;
  content: string;
  category_id: string | null;
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
}

export interface ArticleCreate {
  title: string;
  content: string;
  category_id: string | null;
  tags: string[];
  entities?: ArticleEntities | null;
}

export interface ArticleUpdate {
  title?: string;
  content?: string;
  category_id?: string | null;
  tags?: string[];
  entities?: ArticleEntities | null;
}
