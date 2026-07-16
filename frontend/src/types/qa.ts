export interface QAMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface QASource {
  article_id: string;
  title: string;
  excerpt: string;
  relevance: number;
}

export interface QARequest {
  question: string;
  history: QAMessage[];
}

export interface QAResponse {
  answer: string;
  sources: QASource[];
}
