import {
  useEffect,
  useState,
  type ElementType,
  type JSX,
  type MouseEvent,
  type ReactNode
} from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

/**
 * Aceternity Hover Border Gradient (`npx shadcn add @aceternity/hover-border-gradient-demo`),
 * адаптированный под Kontur.
 *
 * Механика оригинала: по рамке бежит радиальное «пятно» света (сверху → слева →
 * снизу → справа, шаг `duration`), потом вспыхивает подсветка. Отличия:
 *  - бежит только на hover. В оригинале пятно крутится постоянно, а здесь
 *    рамка стоит на всех кнопках и полях: сотни вечно анимированных рамок
 *    рябили бы в глазах и дёргали рендер каждую секунду;
 *  - палитра та же, что у GlowingEffect (виджеты «Моего дня», док), подсветка —
 *    фирменный оранжевый вместо синего;
 *  - кольцо вырезается маской, а не непрозрачной подложкой (`bg-black inset-[2px]`
 *    у оригинала). Поэтому слой можно положить поверх любого фона: прозрачные
 *    поля, стекло, цветные кнопки.
 *
 * Слой (`HoverBorderRing`) встроен прямо в ui/button и ui/input — так эффект
 * получают все кнопки и поля без правок по месту.
 */

type Direction = 'TOP' | 'LEFT' | 'BOTTOM' | 'RIGHT'

/** Палитра как у GlowingEffect. */
const GLOW = {
  pink: [221, 123, 187],
  amber: [215, 159, 30],
  green: [90, 146, 44],
  blue: [76, 120, 148],
  highlight: [240, 154, 5]
} as const

/**
 * Конечный цвет — тот же, но с нулевой альфой, а не `transparent`: motion
 * интерполирует background между градиентами только при одинаковой структуре
 * чисел, а `transparent` ломает это сопоставление.
 */
function spot(rgb: readonly number[], shape: string): string {
  const [r, g, b] = rgb
  return `radial-gradient(${shape}, rgba(${r}, ${g}, ${b}, 1) 0%, rgba(${r}, ${g}, ${b}, 0) 100%)`
}

const MOVING: Record<Direction, string> = {
  TOP: spot(GLOW.pink, '20.7% 50% at 50% 0%'),
  LEFT: spot(GLOW.amber, '16.6% 43.1% at 0% 50%'),
  BOTTOM: spot(GLOW.green, '20.7% 50% at 50% 100%'),
  RIGHT: spot(GLOW.blue, '16.2% 41.2% at 100% 50%')
}
const HIGHLIGHT = spot(GLOW.highlight, '75% 181.16% at 50% 50%')
const DIRECTIONS: Direction[] = ['TOP', 'LEFT', 'BOTTOM', 'RIGHT']

/** Оставить от прямоугольника только рамку толщиной `padding`. */
const RING_MASK = 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)'

/**
 * Само кольцо. Родитель обязан быть `relative`; скругление берётся у него
 * (`rounded-[inherit]`). Слой не ловит мышь и не влияет на раскладку.
 */
export function HoverBorderRing({
  active,
  duration = 1,
  clockwise = true,
  width = 1.5,
  className
}: {
  active: boolean
  duration?: number
  clockwise?: boolean
  /** Толщина кольца, px. */
  width?: number
  className?: string
}): JSX.Element {
  const [direction, setDirection] = useState<Direction>('TOP')

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      setDirection((prev) => {
        const i = DIRECTIONS.indexOf(prev)
        return clockwise
          ? DIRECTIONS[(i - 1 + DIRECTIONS.length) % DIRECTIONS.length]!
          : DIRECTIONS[(i + 1) % DIRECTIONS.length]!
      })
    }, duration * 1000)
    return () => window.clearInterval(id)
  }, [active, duration, clockwise])

  return (
    <motion.span
      aria-hidden
      className={cn(
        'pointer-events-none absolute -inset-px z-10 rounded-[inherit] transition-opacity duration-200',
        active ? 'opacity-100' : 'opacity-0',
        className
      )}
      style={{
        padding: width,
        WebkitMask: RING_MASK,
        WebkitMaskComposite: 'xor',
        mask: RING_MASK,
        maskComposite: 'exclude'
      }}
      initial={{ background: MOVING[direction] }}
      animate={{ background: active ? [MOVING[direction], HIGHLIGHT, MOVING[direction]] : MOVING[direction] }}
      transition={{ ease: 'linear', duration }}
    />
  )
}

/**
 * Компонент в API оригинала — для мест, где нужен отдельный элемент с рамкой,
 * а не ui/button.
 */
export function HoverBorderGradient({
  children,
  containerClassName,
  className,
  as: Tag = 'button',
  duration = 1,
  clockwise = true,
  ...props
}: {
  children?: ReactNode
  as?: ElementType
  containerClassName?: string
  className?: string
  duration?: number
  clockwise?: boolean
} & React.HTMLAttributes<HTMLElement>): JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <Tag
      {...props}
      onMouseEnter={(e: MouseEvent<HTMLElement>) => {
        setHovered(true)
        props.onMouseEnter?.(e)
      }}
      onMouseLeave={(e: MouseEvent<HTMLElement>) => {
        setHovered(false)
        props.onMouseLeave?.(e)
      }}
      className={cn('relative inline-flex w-fit items-center justify-center rounded-md', containerClassName)}
    >
      <span className={cn('relative inline-flex items-center justify-center rounded-[inherit]', className)}>
        {children}
      </span>
      <HoverBorderRing active={hovered} duration={duration} clockwise={clockwise} />
    </Tag>
  )
}
