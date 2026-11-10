export interface GraphNode {
  id: string;
  label: string;
  type: 'article' | 'category' | 'entity';
  url: string;
  color: string | null;
  entity_type: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 当前图谱节点上限（后端 GRAPH_MAX_NODES）；未设置 = 不限制 */
  max_nodes?: number | null;
}
