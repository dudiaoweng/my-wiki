export interface QAMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: QASource[];
}

export interface QASource {
  article_id: string;
  title: string;
  excerpt: string;
  relevance: number;
}

export interface FileContext {
  file_id?: string;
  filename: string;
  content: string;
  content_type?: string;
  is_image?: boolean;
  status?: 'processing' | 'done' | 'error';
  media_url?: string;
  thumb_url?: string;
}

export interface FileParseResult {
  file_id: string;
  filename: string;
  content_type: string;
  is_image: boolean;
  status: 'processing';
  media_url: string;
}

export interface FileStatusResult {
  file_id: string;
  status: 'processing' | 'done' | 'error';
  filename: string;
  content?: string;
  content_type: string;
  is_image: boolean;
  error?: string;
  media_url: string;
  thumb_url: string;
}

export interface QARequest {
  question: string;
  history: QAMessage[];
  file_contexts?: FileContext[];
  kb_enabled?: boolean;
}

export interface QAResponse {
  answer: string;
  sources: QASource[];
}
