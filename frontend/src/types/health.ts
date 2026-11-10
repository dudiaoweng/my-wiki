export type ModelKind = 'text' | 'vision' | 'asr' | 'embedding';

export interface ModelHealth {
  configured: boolean;
  /** null = 未配置/未探测；false = 已配置但不可用 */
  ok: boolean | null;
}

export interface DependencyHealth {
  /** null = 后端首次巡检尚未完成（前端不提示） */
  neo4j: boolean | null;
  qdrant: boolean | null;
  models?: Partial<Record<ModelKind, ModelHealth>>;
}
