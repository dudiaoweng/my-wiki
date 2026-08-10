import type { ArticleEntities } from './article';

export interface CommentSummary {
  id: string;
  content: string;
  created_by: string | null;
  created_at: string;
}

export interface CommentAttachment {
  path: string;
  name: string;
  type: string;
}

export interface Comment {
  id: string;
  article_id: string;
  content: string;
  tags: string[];
  entities: ArticleEntities | null;
  processing: string | null;
  attachments: CommentAttachment[] | null;
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
