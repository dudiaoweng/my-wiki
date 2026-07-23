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
  filename: string;
  content: string;
  content_type?: string;
  is_image?: boolean;
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
