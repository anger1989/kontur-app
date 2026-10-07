import type { JSX, ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Поясняющая врезка. Используется там, где поведение приложения неочевидно. */
export function Callout({
  tone = 'info',
  children,
  className
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
  className?: string
}): JSX.Element {
  const Icon = tone === 'warning' ? TriangleAlert : Info
  return (
    <div
      className={cn(
        'mb-4 flex gap-3 rounded-md border border-l-[3px] bg-muted/50 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground',
        tone === 'warning' ? 'border-l-warning' : 'border-l-primary',
        className
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
