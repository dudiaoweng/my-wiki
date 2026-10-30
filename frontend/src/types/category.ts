export interface Category {
  id: string;
  name: string;
  color: string;
  /** 上级目录 ID（空 = 顶级目录） */
  parent_id?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CategoryCreate {
  name: string;
  color: string;
  /** 上级目录 ID；空串 = 顶级目录 */
  parent_id?: string | null;
}
