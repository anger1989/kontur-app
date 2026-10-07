import type { JSX } from 'react'
import RubberSegment, { type SegmentItem } from '@/components/ui/rubber-segment'
import '@/styles/segmented.css'

/**
 * Обёртка над React Bits Rubber Segment с палитрой приложения.
 *
 * Цвета приходят переменными темы, поэтому переключатель сам следует светлой
 * и тёмной теме. Размеры и поведение одинаковые во всех местах — иначе
 * «резинка» в настройках и в календаре вели бы себя по-разному.
 */
export function Segmented({
  items,
  value,
  onChange,
  size = 'md',
  equalSlots = false,
  className,
  ariaLabel
}: {
  items: SegmentItem[]
  value: string
  onChange: (value: string) => void
  size?: 'sm' | 'md' | 'lg'
  /** Одинаковая ширина слотов. По умолчанию слоты по тексту — подписи разной длины. */
  equalSlots?: boolean
  className?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <RubberSegment
      items={items}
      value={value}
      onChange={(v) => onChange(v)}
      size={size}
      equalSlots={equalSlots}
      radius={8}
      inset={3}
      trackColor="var(--muted)"
      thumbColor="var(--kontur-seg-thumb)"
      textColor="var(--muted-foreground)"
      activeTextColor="var(--foreground)"
      className={`kontur-segment${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel ?? 'Переключатель'}
    />
  )
}
