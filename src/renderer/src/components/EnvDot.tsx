import type { JSX } from 'react'
import type { TunnelState } from '@shared/types'
import { cn } from '@/lib/utils'

const HINT: Record<TunnelState, string> = {
  up: 'контур доступен',
  down: 'туннель не поднят',
  checking: 'проверяем…',
  unknown: 'состояние неизвестно'
}

/**
 * Индикатор контура. Залитая точка — туннель поднят, полый контур — нет.
 * Форма несёт тот же смысл, что и цвет: состояние читается и без различения оттенков.
 */
export function EnvDot({
  accent,
  tunnel = 'unknown',
  className
}: {
  accent: string
  tunnel?: TunnelState
  className?: string
}): JSX.Element {
  const up = tunnel === 'up'
  return (
    <span
      title={HINT[tunnel]}
      className={cn(
        'size-2 shrink-0 rounded-full',
        tunnel === 'checking' && 'animate-pulse',
        !up && 'border-[1.5px] border-muted-foreground/60',
        className
      )}
      style={
        up
          ? { background: accent, boxShadow: `0 0 0 2px color-mix(in srgb, ${accent} 22%, transparent)` }
          : undefined
      }
    />
  )
}
