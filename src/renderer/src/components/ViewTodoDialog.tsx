import { type JSX } from 'react'
import type { Item } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function isDone(it: Item): boolean {
  return it.body.split('\n').includes('cat:done')
}

function parseNote(body: string): string {
  return body
    .split('\n')
    .filter((l) => l.startsWith('note:'))
    .map((l) => l.slice(5))
    .join('\n')
}

function parseRemind(body: string): number | null {
  const line = body.split('\n').find((l) => l.startsWith('remind:'))
  if (!line) return null
  const n = Number(line.slice(7))
  return Number.isFinite(n) ? n : null
}

function inCalendar(body: string): boolean {
  return !body.split('\n').includes('cal:0')
}

function fmtWhen(ms: number | null | undefined): string {
  if (ms == null) return 'Без срока'
  return new Date(ms).toLocaleString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Только просмотр дела — без полей редактирования. */
export function ViewTodoDialog({
  item,
  open,
  onClose,
  onEdit,
  onDone
}: {
  item: Item | null
  open: boolean
  onClose: () => void
  onEdit: (item: Item) => void
  onDone?: (item: Item) => void
}): JSX.Element {
  const done = item ? isDone(item) : false
  const note = item ? parseNote(item.body) : ''
  const remind = item ? parseRemind(item.body) : null
  const cal = item ? inCalendar(item.body) && item.startsAt != null : false

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 text-left leading-snug">
            {item?.title ?? 'Дело'}
          </DialogTitle>
        </DialogHeader>

        {item && (
          <div className="grid gap-3 text-[13px]">
            <Row label="Срок" value={fmtWhen(item.startsAt)} />
            <Row
              label="Напоминание"
              value={remind != null ? fmtWhen(remind) : 'Нет'}
            />
            <Row label="В календаре" value={cal ? 'Да' : 'Нет'} />
            <Row label="Статус" value={done ? 'Готово' : 'Открыто'} />
            {note ? (
              <div className="grid gap-1">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Заметка
                </span>
                <p className="whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-[13px] leading-relaxed">
                  {note}
                </p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {item && !done && onDone ? (
              <Button type="button" variant="secondary" onClick={() => onDone(item)}>
                Готово
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            {item ? (
              <Button type="button" variant="outline" onClick={() => onEdit(item)}>
                Изменить
              </Button>
            ) : null}
            <Button type="button" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="min-w-0 text-right font-medium">{value}</span>
    </div>
  )
}
