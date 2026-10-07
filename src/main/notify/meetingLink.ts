import type { Item } from '@shared/types'

/**
 * Ссылка на подключение к встрече — та же эвристика, что и в EventDialog
 * (renderer): первая строка тела, целиком являющаяся http(s)-адресом.
 * Коннекторы (EAS и т.п.) кладут её туда при синке.
 */
export function extractMeetingUrl(item: Item): string | null {
  if (item.kind !== 'event') return null
  const line = item.body.split('\n').find((l) => /^https?:\/\//i.test(l.trim()))
  return line ? line.trim() : null
}
