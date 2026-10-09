/**
 * Kanban Board (cult-ui) — адаптирован под Electron/Kontur:
 * без next/image, колонки с произвольным id (статусы Jira),
 * опциональный клик по карточке и subtitle (ключ задачи).
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type JSX } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'

const TAG_VARIANTS = {
  feature: { bg: 'rgba(59,130,246,0.10)', color: '#2563eb' },
  bug: { bg: 'rgba(239,68,68,0.10)', color: '#dc2626' },
  design: { bg: 'rgba(168,85,247,0.10)', color: '#9333ea' },
  done: { bg: 'rgba(16,185,129,0.10)', color: '#059669' },
  improvement: { bg: 'rgba(245,158,11,0.10)', color: '#d97706' },
  docs: { bg: 'rgba(6,182,212,0.10)', color: '#0891b2' }
} as const

export type TagVariant = keyof typeof TAG_VARIANTS
/** Категория для иконки колонки (Jira statusCategory.key). */
export type ColumnKind = 'todo' | 'in-progress' | 'done'

export type CardTag = {
  label: string
  variant: TagVariant
}

export type Assignee = {
  name: string
  avatar?: string
}

export type CardData = {
  id: string
  title: string
  /** Ключ задачи / вторичная строка. */
  subtitle?: string
  tags?: CardTag[]
  assignee?: Assignee
  date?: string
}

export type ColumnData = {
  id: string
  title: string
  /** Визуальный тип колонки (иконка). */
  kind?: ColumnKind
  cards: CardData[]
}

export type DragState = {
  cardId: string
  fromColumn: string
} | null

const COLUMN_ICONS: Record<ColumnKind, JSX.Element> = {
  todo: (
    <svg aria-hidden fill="none" height="13" stroke="#b0b0b0" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="13">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  'in-progress': (
    <svg aria-hidden fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="13">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  done: (
    <svg aria-hidden fill="none" height="13" stroke="#10b981" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="13">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

const springTransition = { type: 'spring' as const, stiffness: 500, damping: 30 }
export const gentleSpring = { type: 'spring' as const, stiffness: 300, damping: 26 }

function Tag({ label, variant }: { label: string; variant: TagVariant }): JSX.Element {
  const v = TAG_VARIANTS[variant] || TAG_VARIANTS.feature
  return (
    <span
      className="inline-block rounded-[6px] px-[7px] py-[2.5px] text-[10.5px] leading-snug font-semibold tracking-wide"
      style={{ backgroundColor: v.bg, color: v.color }}
    >
      {label}
    </span>
  )
}

function Avatar({ src, name }: { src?: string; name?: string }): JSX.Element {
  if (src) {
    return (
      <img
        alt={name || ''}
        className="size-[22px] rounded-full object-cover"
        height={22}
        src={src}
        style={{ outline: '1px solid var(--border)', outlineOffset: '-1px' }}
        width={22}
      />
    )
  }
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className="flex size-[22px] items-center justify-center rounded-full text-[9px] font-bold"
      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
    >
      {initials}
    </div>
  )
}

const cardVariants = {
  initial: { opacity: 0, y: 8, scale: 0.97, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -6, scale: 0.98, filter: 'blur(3px)' }
}

function Card({
  card,
  isDone,
  index,
  onDragStart,
  onDragEnd,
  isDragging,
  onClick
}: {
  card: CardData
  isDone: boolean
  index: number
  onDragStart: () => void
  onDragEnd: () => void
  isDragging: boolean
  onClick?: (card: CardData) => void
}): JSX.Element {
  const shouldReduce = useReducedMotion()
  const tags = card.tags ?? []

  return (
    <motion.div
      animate="animate"
      className="not-prose flex cursor-grab select-none flex-col gap-1.5 active:cursor-grabbing"
      draggable
      exit="exit"
      initial="initial"
      layout
      layoutId={card.id}
      onClick={() => onClick?.(card)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      style={{
        borderRadius: 14,
        background: 'var(--card)',
        padding: '8px 10px',
        boxShadow: isDragging
          ? '0 0 0 1px var(--border), 0 12px 32px rgba(0,0,0,0.18), 0 4px 8px rgba(0,0,0,0.10)'
          : '0 0 0 1px var(--border), 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.03)',
        opacity: isDone && !isDragging ? 0.55 : 1,
        position: 'relative',
        zIndex: isDragging ? 50 : 1
      }}
      transition={{
        ...gentleSpring,
        delay: shouldReduce ? 0 : index * 0.04,
        layout: springTransition
      }}
      variants={cardVariants}
      whileHover={{
        y: -2,
        boxShadow:
          '0 0 0 1px var(--border), 0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.06)',
        transition: { type: 'spring', stiffness: 400, damping: 20 }
      }}
      whileTap={{ scale: 0.97 }}
    >
      {card.subtitle && (
        <span className="font-mono text-[10px] text-muted-foreground">{card.subtitle}</span>
      )}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Tag key={`${card.id}-${tag.label}-${tag.variant}`} label={tag.label} variant={tag.variant} />
          ))}
        </div>
      )}
      <div
        className="text-[11.5px] leading-snug font-semibold"
        style={{
          color: 'var(--foreground)',
          textDecoration: isDone ? 'line-through' : 'none',
          textDecorationColor: isDone ? 'var(--muted-foreground)' : undefined,
          textWrap: 'pretty'
        }}
      >
        {card.title}
      </div>
      {(card.assignee || card.date) && (
        <div className="flex items-center justify-between">
          {card.assignee ? <Avatar name={card.assignee.name} src={card.assignee.avatar} /> : <div />}
          {card.date && (
            <span className="text-[10.5px] font-medium tabular-nums" style={{ color: 'var(--muted-foreground)' }}>
              {card.date}
            </span>
          )}
        </div>
      )}
    </motion.div>
  )
}

function DropIndicator({ isActive }: { isActive: boolean }): JSX.Element {
  return (
    <motion.div
      animate={{ opacity: isActive ? 1 : 0, scaleX: isActive ? 1 : 0.3 }}
      className="pointer-events-none mx-auto"
      initial={false}
      style={{
        height: 3,
        width: '60%',
        borderRadius: 99,
        background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.4), transparent)',
        marginTop: 2,
        marginBottom: 2
      }}
      transition={{ type: 'spring', stiffness: 500, damping: 28 }}
    />
  )
}

export function Column({
  column,
  onDrop,
  dragState,
  setDragState,
  onCardClick
}: {
  column: ColumnData
  onDrop: (cardId: string, fromColumnId: string, toColumnId: string) => void
  dragState: DragState
  setDragState: Dispatch<SetStateAction<DragState>>
  onCardClick?: (card: CardData) => void
}): JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const kind: ColumnKind = column.kind ?? 'todo'
  const isDone = kind === 'done'
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setDragOver(false), 60)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      if (dragState) onDrop(dragState.cardId, dragState.fromColumn, column.id)
    },
    [dragState, onDrop, column.id]
  )

  return (
    <div className="flex h-full min-h-0 min-w-[200px] flex-1 flex-col">
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mb-[14px] flex items-center gap-[7px] px-[2px]"
        initial={{ opacity: 0, y: -4 }}
        transition={{ ...gentleSpring, delay: 0.05 }}
      >
        {COLUMN_ICONS[kind]}
        <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--foreground)' }}>
          {column.title}
        </span>
        <motion.span
          animate={{ scale: 1, opacity: 1 }}
          className="ml-auto text-[12.5px] font-semibold tabular-nums"
          initial={{ scale: 0.6, opacity: 0 }}
          key={column.cards.length}
          style={{ color: 'var(--muted-foreground)' }}
          transition={springTransition}
        >
          {column.cards.length}
        </motion.span>
      </motion.div>

      <motion.div
        animate={{
          backgroundColor: dragOver ? 'rgba(59,130,246,0.045)' : 'rgba(0,0,0,0)',
          scale: dragOver ? 1.012 : 1
        }}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-2xl p-0.5"
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        transition={{ type: 'spring', stiffness: 400, damping: 24 }}
      >
        <DropIndicator isActive={dragOver} />
        <AnimatePresence initial={false} mode="popLayout">
          {column.cards.map((card, i) => (
            <Card
              card={card}
              index={i}
              isDone={isDone}
              isDragging={dragState?.cardId === card.id}
              key={card.id}
              onClick={onCardClick}
              onDragEnd={() => setDragState(null)}
              onDragStart={() => setDragState({ cardId: card.id, fromColumn: column.id })}
            />
          ))}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

/** Горизонтальный ряд колонок — обёртка поверх cult-ui Column. */
export function KanbanBoard({
  columns,
  onDrop,
  onCardClick,
  className
}: {
  columns: ColumnData[]
  onDrop: (cardId: string, fromColumnId: string, toColumnId: string) => void
  onCardClick?: (card: CardData) => void
  className?: string
}): JSX.Element {
  const [dragState, setDragState] = useState<DragState>(null)
  return (
    <div className={cn('flex min-h-0 flex-1 gap-4 overflow-x-auto pb-1', className)}>
      {columns.map((column) => (
        <Column
          key={column.id}
          column={column}
          dragState={dragState}
          setDragState={setDragState}
          onCardClick={onCardClick}
          onDrop={onDrop}
        />
      ))}
    </div>
  )
}
