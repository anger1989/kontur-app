import { useRef, useState, type JSX, type ReactNode } from 'react'
import {
  type MotionValue,
  motion,
  useMotionValue,
  useSpring,
  useTransform
} from 'motion/react'
import { cn } from '@/lib/utils'

/**
 * Док: плотное стекло-таблетка + magnification.
 * Плитки непрозрачные — иначе при подъёме на hover полупрозрачные
 * квадраты «вылезают» на обои и выглядят грязно.
 */

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
        // items-end + pb: волна растёт вверх. overflow-visible — тултипы / magnification.
        'mx-auto flex h-[4.75rem] items-end overflow-visible rounded-3xl border-2 px-1 pb-3 shadow-2xl',
        'border-white/25 bg-neutral-200/80 backdrop-blur-lg ring-1 ring-black/10',
        'dark:border-white/15 dark:bg-neutral-900/80 dark:ring-white/10',
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
              className="mb-2 w-px shrink-0 self-end bg-black/15 dark:bg-white/15"
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
          'relative flex size-full items-center justify-center rounded-2xl shadow-lg ring-1',
          'bg-gradient-to-b from-white/90 to-white/55 ring-black/10',
          'dark:from-neutral-800 dark:to-neutral-900 dark:ring-white/10',
          isFocused && 'ring-2 ring-primary/70'
        )}
        animate={{
          y: pressed ? 2 : hovered || isFocused ? -8 : 0
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      >
        <motion.div
          className="relative z-[1] flex items-center justify-center text-neutral-800 dark:text-white"
          style={{ width: iconW, height: iconH }}
          animate={{ scale: hovered ? 1.1 : 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
        >
          {icon}
        </motion.div>

        <motion.div
          className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white/25 to-transparent"
          animate={{ opacity: hovered ? 0.35 : 0.12 }}
          transition={{ duration: 0.2 }}
        />
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
        className="pointer-events-none absolute -top-10 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-neutral-900/90 px-2 py-1 text-xs whitespace-nowrap text-white backdrop-blur-sm"
      >
        {title}
      </motion.div>

      {/* Точка «открыто» / пульс при клике */}
      <motion.div
        className={cn(
          'absolute -bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full',
          isOpen ? 'bg-primary' : 'bg-transparent'
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
