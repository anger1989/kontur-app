import { useRef, useState, type JSX, type ReactNode } from 'react'
import {
  type MotionValue,
  motion,
  useMotionValue,
  useSpring,
  useTransform
} from 'motion/react'
import { GlowingEffect } from '@/components/ui/glowing-effect'
import { cn } from '@/lib/utils'

/** Стеклянный dock с magnification и локальным amber-glow на плитках. */

export interface DockItem {
  title: string
  icon: ReactNode
  onClick: () => void
  /** Точка под иконкой — окно этого пункта открыто (в т.ч. свёрнуто). */
  open?: boolean
  /** Плитка в фокусе — чуть выше + акцент на кольце. */
  focused?: boolean
  /** Разделитель перед этим пунктом (между страницами и контурами). */
  separatorBefore?: boolean
}

/** Размеры «в покое» — от них считается уменьшение на узком столе. */
const BASE_TILE = 50
const BASE_GAP = 12
const DOCK_PADDING = 32
const MIN_TILE = 32
/** Радиус волны (как в dock-tabs). */
const MAG_RANGE = 150
/** Пик magnification относительно покоя. */
const MAG_PEAK = 1.55

function metrics(
  count: number,
  separators: number,
  maxWidth?: number
): { tile: number; gap: number; pad: number; peak: number } {
  // Запас под пик волны: ряд не должен вылезать за maxWidth в покое;
  // при hover соседние плитки раздуваются — ок, как в macOS/dock-tabs.
  const natural =
    count * BASE_TILE + Math.max(0, count - 1) * BASE_GAP + separators * (1 + BASE_GAP) + DOCK_PADDING
  const room = maxWidth && maxWidth > 0 ? maxWidth : natural
  const k = Math.min(1, room / Math.max(1, natural))
  const tile = Math.max(MIN_TILE, Math.round(BASE_TILE * k))
  return {
    tile,
    gap: Math.max(6, Math.round(BASE_GAP * k)),
    pad: Math.max(10, Math.round(16 * k)),
    peak: Math.round(tile * MAG_PEAK)
  }
}

export function Dock({
  items,
  maxWidth,
  className
}: {
  items: DockItem[]
  maxWidth?: number
  className?: string
}): JSX.Element {
  const separators = items.filter((it, i) => it.separatorBefore && i > 0).length
  const { tile, gap, pad, peak } = metrics(items.length, separators, maxWidth)
  const mouseX = useMotionValue(Number.POSITIVE_INFINITY)

  return (
    <motion.div
      onMouseMove={(e) => mouseX.set(e.clientX)}
      onMouseLeave={() => mouseX.set(Number.POSITIVE_INFINITY)}
      style={{ gap, paddingLeft: pad, paddingRight: pad }}
      className={cn(
        'mx-auto flex h-[4.75rem] items-end overflow-visible rounded-2xl border border-border bg-card/82 px-1 pb-3',
        'shadow-[inset_0_1px_rgb(255_255_255/0.1),0_1px_2px_rgb(0_0_0/0.16),0_16px_40px_-20px_rgb(0_0_0/0.65)] backdrop-blur-2xl',
        className
      )}
      initial={{ y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22, delay: 0.05 }}
    >
      {items.map((item, i) => (
        <div key={item.title} className="relative flex items-end" style={{ gap }}>
          {item.separatorBefore && i > 0 && (
            <span
              className="mb-2 w-px shrink-0 self-end bg-border"
              style={{ height: tile * 0.55 }}
            />
          )}
          <DockIcon {...item} size={tile} peak={peak} mouseX={mouseX} />
        </div>
      ))}
    </motion.div>
  )
}

function DockIcon({
  title,
  icon,
  onClick,
  open,
  focused,
  size,
  peak,
  mouseX
}: DockItem & { size: number; peak: number; mouseX: MotionValue<number> }): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const isOpen = open ?? false
  const isFocused = focused ?? false

  const distance = useTransform(mouseX, (val) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }
    return val - bounds.x - bounds.width / 2
  })

  const spring = { mass: 0.1, stiffness: 150, damping: 12 }
  const width = useSpring(useTransform(distance, [-MAG_RANGE, 0, MAG_RANGE], [size, peak, size]), spring)
  const height = useSpring(useTransform(distance, [-MAG_RANGE, 0, MAG_RANGE], [size, peak, size]), spring)
  const iconW = useTransform(width, (w) => w * 0.5)
  const iconH = useTransform(height, (h) => h * 0.5)

  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label={title}
      onClick={onClick}
      style={{ width, height }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false)
        setPressed(false)
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      className="no-drag relative flex aspect-square cursor-pointer items-center justify-center"
      whileTap={{ scale: 0.95 }}
    >
      <motion.div
        className={cn(
          'relative flex size-full items-center justify-center rounded-xl border border-border bg-secondary/75 shadow-xs',
          'transition-colors hover:bg-accent',
          isFocused && 'border-foreground/20 bg-accent ring-1 ring-ring/50'
        )}
        animate={{
          y: pressed ? 2 : hovered || isFocused ? -8 : 0
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      >
        <GlowingEffect
          className="z-10"
          disabled={false}
          glow
          variant="amber"
          proximity={72}
          spread={42}
          borderWidth={2}
          inactiveZone={0.01}
          movementDuration={0.35}
        />

        <motion.div
          className="relative z-[1] flex items-center justify-center text-neutral-800 dark:text-white"
          style={{ width: iconW, height: iconH }}
          animate={{ scale: hovered ? 1.1 : 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        >
          {icon}
        </motion.div>

        <span className="pointer-events-none absolute inset-x-1 top-px h-px bg-foreground/5" />
      </motion.div>

      {/* Tooltip сверху */}
      <motion.div
        initial={false}
        animate={{
          opacity: hovered ? 1 : 0,
          y: hovered ? -18 : 8,
          scale: hovered ? 1 : 0.85
        }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="pointer-events-none absolute -top-10 left-1/2 z-[60] -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md"
      >
        {title}
      </motion.div>

      {/* Точка «открыто» / пульс при клике */}
      <motion.div
        className={cn(
          'absolute -bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full',
          isOpen ? 'bg-foreground/70' : 'bg-transparent'
        )}
        animate={{
          scale: pressed ? 1.5 : 1,
          opacity: isOpen ? (pressed ? 1 : 0.9) : 0
        }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </motion.button>
  )
}
