import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react'
import { Check, Plus } from 'lucide-react'
import { motion } from 'motion/react'
import type { Item } from '@shared/types'
import { useStore } from '@/store'
import { WidgetHeader } from '@/components/ui/stats-card'
import { CreateTodoDialog } from '@/components/CreateTodoDialog'
import { ViewTodoDialog } from '@/components/ViewTodoDialog'
import { cn } from '@/lib/utils'

function isDone(it: Item): boolean {
  return it.body.split('\n').includes('cat:done')
}

function dueShort(it: Item): string {
  if (it.startsAt == null) return ''
  const d = new Date(it.startsAt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isOverdue(it: Item): boolean {
  return !isDone(it) && it.startsAt != null && it.startsAt < Date.now()
}

function TodoRow({
  item,
  onOpen
}: {
  item: Item
  onOpen: (item: Item) => void
}): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'checked' | 'leaving'>('idle')
  const committed = useRef(false)
  const busy = phase !== 'idle'

  const complete = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation()
    if (busy) return
    setPhase('checked')
    window.setTimeout(() => setPhase('leaving'), 220)
  }

  return (
    <motion.li
      layout
      initial={false}
      animate={
        phase === 'leaving'
          ? { opacity: 0, x: 72, height: 0, marginBottom: 0 }
          : { opacity: 1, x: 0, height: 'auto' }
      }
      transition={
        phase === 'leaving'
          ? {
              x: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.28, ease: 'easeOut' },
              height: { delay: 0.12, duration: 0.24, ease: [0.22, 1, 0.36, 1] },
              layout: { duration: 0.24 }
            }
          : { layout: { duration: 0.2 } }
      }
      onAnimationComplete={() => {
        if (phase !== 'leaving' || committed.current) return
        committed.current = true
        void window.kontur.todos.update({ id: item.id, done: true })
      }}
      className="overflow-hidden"
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => onOpen(item)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/5 disabled:hover:bg-transparent"
      >
        <span
          role="button"
          tabIndex={busy ? -1 : 0}
          title="Готово"
          onClick={complete}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              complete(e)
            }
          }}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            busy
              ? 'border-primary bg-primary text-primary-foreground'
              : 'desk-tile border-muted-foreground/40 hover:border-primary'
          )}
        >
          <Check
            className={cn(
              'size-2.5 transition-opacity duration-150',
              busy ? 'opacity-100' : 'opacity-0'
            )}
            strokeWidth={3}
          />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium transition-[color,text-decoration-color] duration-200',
            busy && 'text-muted-foreground line-through decoration-muted-foreground/70'
          )}
        >
          {item.title}
        </span>
        {item.startsAt != null && (
          <span
            className={cn(
              'shrink-0 text-[11px] tabular-nums transition-opacity duration-200',
              busy && 'opacity-40',
              !busy && isOverdue(item) ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {dueShort(item)}
          </span>
        )}
      </button>
    </motion.li>
  )
}

/** Виджет личных дел на рабочем столе. */
export function TodosWidget({ bare }: { bare?: boolean } = {}): JSX.Element | null {
  const openWindow = useStore((s) => s.openWindow)
  const [items, setItems] = useState<Item[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [editItem, setEditItem] = useState<Item | null>(null)
  const [viewItem, setViewItem] = useState<Item | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.kontur.todos.list().then(setItems)
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  const open = useMemo(() => {
    const now = Date.now()
    const day0 = new Date()
    day0.setHours(0, 0, 0, 0)
    const day1 = day0.getTime() + 86_400_000
    return items
      .filter((i) => !isDone(i))
      .sort((a, b) => {
        const ao = a.startsAt != null && a.startsAt < now ? 0 : 1
        const bo = b.startsAt != null && b.startsAt < now ? 0 : 1
        if (ao !== bo) return ao - bo
        const at = a.startsAt ?? Number.MAX_SAFE_INTEGER
        const bt = b.startsAt ?? Number.MAX_SAFE_INTEGER
        return at - bt
      })
      .filter((i) => {
        if (i.startsAt == null) return true
        return i.startsAt < day1 + 7 * 86_400_000
      })
      .slice(0, 8)
  }, [items])

  return (
    <div className={cn(!bare && 'desktop-glass rounded-2xl border p-3 backdrop-blur-2xl', bare && 'p-3')}>
      <WidgetHeader
        title="Дела"
        count={open.length}
        action={{ label: 'Все дела', onClick: () => openWindow({ kind: 'page', page: 'planner' }) }}
      >
        <button
          type="button"
          title="Новое дело"
          aria-label="Новое дело"
          onClick={() => {
            setEditItem(null)
            setCreateOpen(true)
          }}
          className="desk-chip rounded-md p-1 text-muted-foreground transition-[box-shadow,color] hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </WidgetHeader>

      {open.length === 0 ? (
        <button
          type="button"
          onClick={() => {
            setEditItem(null)
            setCreateOpen(true)
          }}
          className="w-full rounded-lg px-2 py-3 text-center text-[12px] text-muted-foreground hover:bg-foreground/5"
        >
          Добавить дело
        </button>
      ) : (
        <ul className="space-y-px">
          {open.map((it) => (
            <TodoRow key={it.id} item={it} onOpen={setViewItem} />
          ))}
        </ul>
      )}

      <ViewTodoDialog
        item={viewItem}
        open={viewItem != null}
        onClose={() => setViewItem(null)}
        onEdit={(it) => {
          setViewItem(null)
          setEditItem(it)
          setCreateOpen(true)
        }}
        onDone={(it) => {
          void window.kontur.todos.update({ id: it.id, done: true })
          setViewItem(null)
        }}
      />

      <CreateTodoDialog
        open={createOpen}
        initial={editItem}
        onClose={() => {
          setCreateOpen(false)
          setEditItem(null)
        }}
      />
    </div>
  )
}
