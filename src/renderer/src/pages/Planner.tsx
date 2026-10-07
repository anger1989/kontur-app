import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { Item } from '@shared/types'
import { useStore } from '@/store'
import { CreateTodoDialog } from '@/components/CreateTodoDialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function isDone(it: Item): boolean {
  return it.body.split('\n').includes('cat:done')
}

function dueLabel(it: Item): string {
  if (it.startsAt == null) return 'Без срока'
  const d = new Date(it.startsAt)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `Сегодня, ${time}`
  return (
    d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) +
    (d.getHours() || d.getMinutes() ? `, ${time}` : '')
  )
}

function isOverdue(it: Item): boolean {
  return !isDone(it) && it.startsAt != null && it.startsAt < Date.now()
}

/**
 * Личный планировщик — не Jira. Срок, напоминание, календарь.
 */
export function Planner({ focusItemId, onFocused }: { focusItemId?: string; onFocused?: () => void } = {}): JSX.Element {
  const openWindow = useStore((s) => s.openWindow)
  const [items, setItems] = useState<Item[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [edit, setEdit] = useState<Item | null>(null)

  const load = (): void => {
    void window.kontur.todos.list().then(setItems)
  }

  useEffect(() => {
    load()
    return window.kontur.items.onChange(load)
  }, [])

  useEffect(() => {
    if (!focusItemId || !items.length) return
    const it = items.find((x) => x.id === focusItemId)
    if (it) setEdit(it)
    onFocused?.()
  }, [focusItemId, items, onFocused])

  const open = useMemo(() => items.filter((i) => !isDone(i)), [items])
  const done = useMemo(() => items.filter((i) => isDone(i)), [items])

  const toggle = async (it: Item): Promise<void> => {
    await window.kontur.todos.update({ id: it.id, done: !isDone(it) })
  }

  const remove = async (it: Item): Promise<void> => {
    await window.kontur.todos.remove(it.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold tracking-tight">Планировщик</h1>
          <p className="text-[12px] text-muted-foreground">
            Личные дела · {open.length} открыто
            {done.length ? ` · ${done.length} готово` : ''}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openWindow({ kind: 'page', page: 'calendar' })}
        >
          Календарь
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEdit(null)
            setCreateOpen(true)
          }}
        >
          <Plus className="size-3.5" />
          Дело
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="text-[14px] font-medium">Пока пусто</p>
            <p className="max-w-xs text-[12px] text-muted-foreground">
              Добавьте дело со сроком и напоминанием — оно появится в календаре и на рабочем столе.
            </p>
            <Button
              type="button"
              className="mt-2"
              onClick={() => {
                setEdit(null)
                setCreateOpen(true)
              }}
            >
              <Plus className="size-3.5" />
              Первое дело
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <TodoGroup
              title="Открытые"
              items={open}
              empty="Нет открытых дел"
              onToggle={(it) => void toggle(it)}
              onEdit={setEdit}
              onRemove={(it) => void remove(it)}
            />
            {done.length > 0 && (
              <TodoGroup
                title="Готово"
                items={done}
                onToggle={(it) => void toggle(it)}
                onEdit={setEdit}
                onRemove={(it) => void remove(it)}
              />
            )}
          </div>
        )}
      </div>

      <CreateTodoDialog
        open={createOpen || edit != null}
        initial={edit}
        onClose={() => {
          setCreateOpen(false)
          setEdit(null)
        }}
        onSaved={() => load()}
      />
    </div>
  )
}

function TodoGroup({
  title,
  items,
  empty,
  onToggle,
  onEdit,
  onRemove
}: {
  title: string
  items: Item[]
  empty?: string
  onToggle: (it: Item) => void
  onEdit: (it: Item) => void
  onRemove: (it: Item) => void
}): JSX.Element {
  return (
    <section>
      <h2 className="mb-1.5 px-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
        <span className="ml-1.5 tabular-nums opacity-70">{items.length}</span>
      </h2>
      {items.length === 0 && empty ? (
        <p className="px-1 py-2 text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border bg-card">
          {items.map((it, i) => {
            const done = isDone(it)
            const overdue = isOverdue(it)
            return (
              <li
                key={it.id}
                className={cn(
                  'flex items-start gap-2 px-3 py-2.5',
                  i > 0 && 'border-t',
                  done && 'opacity-55'
                )}
              >
                <button
                  type="button"
                  title={done ? 'Вернуть' : 'Готово'}
                  onClick={() => onToggle(it)}
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                    done
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40 hover:border-primary'
                  )}
                >
                  {done && <Check className="size-3" strokeWidth={3} />}
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(it)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className={cn('block text-[13px] font-medium', done && 'line-through')}>
                    {it.title}
                  </span>
                  <span
                    className={cn(
                      'mt-0.5 block text-[11px] tabular-nums',
                      overdue ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {dueLabel(it)}
                    {overdue ? ' · просрочено' : ''}
                  </span>
                </button>
                <button
                  type="button"
                  title="Удалить"
                  onClick={() => onRemove(it)}
                  className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
