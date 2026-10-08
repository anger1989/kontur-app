import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

export interface HorizontalDepthFadeItem {
  id: string
  /** data URL / URL превью; без него — fallback. */
  src?: string | null
  alt?: string
  label?: string
  fallback?: ReactNode
}

export interface HorizontalDepthFadeProps {
  items: HorizontalDepthFadeItem[]
  activeIndex: number
  onSelect?: (index: number) => void
  itemWidth?: number
  itemHeight?: number
  gap?: number
  /** Доп. яркость центрального кадра, 0–100. */
  brightnessBoost?: number
  /** Насколько сильно соседние уменьшаются (0.08 ≈ −8% на шаг). */
  scaleEffect?: number
  className?: string
}

/**
 * Горизонтальная лента с cinematic depth-of-field (в духе unlumen Horizontal Depth Fade):
 * активный кадр резкий и яркий, соседи — blur / dim / desaturate / scale.
 * Управление индексом снаружи (клавиатура / клик), без GSAP ScrollTrigger.
 */
export function HorizontalDepthFade({
  items,
  activeIndex,
  onSelect,
  itemWidth = 280,
  itemHeight = 176,
  gap = 18,
  brightnessBoost = 12,
  scaleEffect = 0.07,
  className
}: HorizontalDepthFadeProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportW, setViewportW] = useState(640)

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const push = (): void => setViewportW(el.clientWidth)
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stride = itemWidth + gap
  const active = Math.max(0, Math.min(activeIndex, Math.max(0, items.length - 1)))
  // Центрируем активный кадр в вьюпорте.
  const trackX = viewportW / 2 - (active + 0.5) * stride + gap / 2

  return (
    <div ref={viewportRef} className={cn('relative w-full overflow-hidden', className)}>
      <motion.div
        className="flex items-center will-change-transform"
        style={{ gap, width: 'max-content' }}
        animate={{ x: trackX }}
        transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.85 }}
      >
        {items.map((item, i) => {
          const d = Math.abs(i - active)
          const blur = Math.min(d * 5.5, 14)
          const brightness = Math.max(0.42, 1 + brightnessBoost / 100 - d * 0.28)
          const saturate = Math.max(0.15, 1 - d * 0.42)
          const scale = Math.max(0.82, 1 - d * scaleEffect)
          const opacity = Math.max(0.45, 1 - d * 0.18)
          const focused = d === 0

          return (
            <motion.button
              key={item.id}
              type="button"
              onClick={() => onSelect?.(i)}
              className={cn(
                'relative shrink-0 overflow-hidden rounded-2xl border text-left outline-none',
                'bg-background/80 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.55)]',
                focused ? 'border-white/35 ring-2 ring-white/25' : 'border-white/10'
              )}
              style={{ width: itemWidth, height: itemHeight }}
              animate={{
                scale,
                opacity,
                filter: `blur(${blur}px) brightness(${brightness}) saturate(${saturate})`
              }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              aria-current={focused ? 'true' : undefined}
              aria-label={item.label ?? item.alt ?? item.id}
            >
              {item.src ? (
                <img
                  src={item.src}
                  alt={item.alt ?? ''}
                  className="size-full object-cover object-left-top"
                  draggable={false}
                />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-2 bg-muted/60 px-4">
                  {item.fallback}
                </div>
              )}
              {item.label ? (
                <span
                  className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 truncate px-3 py-2 text-[12px] font-medium',
                    'bg-gradient-to-t from-black/70 via-black/35 to-transparent text-white'
                  )}
                >
                  {item.label}
                </span>
              ) : null}
            </motion.button>
          )
        })}
      </motion.div>
    </div>
  )
}
