export interface Category {
  id: string;
  name: string;
  color: string;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CategoryCreate {
  name: string;
  color: string;
}
