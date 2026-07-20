/** Shared entity type → icon mapping and helpers. */

export const ENTITY_ICONS: Record<string, string> = {
  person: '👤', people: '👤', 人物: '👤',
  organization: '🏢', org: '🏢', 组织: '🏢', company: '🏢', 公司: '🏢',
  location: '📍', place: '📍', 地点: '📍',
  event: '📅', 事件: '📅',
  product: '📦', 产品: '📦',
};

export function entityIcon(t: string | undefined): string {
  if (!t) return '◆';
  return ENTITY_ICONS[t.toLowerCase()] ?? '◆';
}

/** Options for entity type <select> dropdowns. */
export const ENTITY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '人物', label: '👤 人物' },
  { value: '组织', label: '🏢 组织' },
  { value: '地点', label: '📍 地点' },
  { value: '事件', label: '📅 事件' },
  { value: '产品', label: '📦 产品' },
  { value: '其他', label: '◆ 其他' },
];
