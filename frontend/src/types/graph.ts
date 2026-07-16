export interface GraphNode {
  id: string;
  label: string;
  type: 'article' | 'category' | 'entity';
  url: string;
  color: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
