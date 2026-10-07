import { useEffect, useMemo, useState, type JSX } from 'react'
import type { Item, TodoCreatePayload } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DateTimePicker } from '@/components/DateTimePicker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

function fromLocalInput(v: string): number | null {
  if (!v.trim()) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function defaultDue(): number {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}

type RemindPreset = 'none' | 'at' | '5m' | '15m' | '1h' | '1d' | 'custom'

function remindAtFromPreset(due: number | null, preset: RemindPreset, custom: string): number | null {
  if (preset === 'none' || due == null) return null
  if (preset === 'at') return due
  if (preset === '5m') return due - 5 * 60_000
  if (preset === '15m') return due - 15 * 60_000
  if (preset === '1h') return due - 60 * 60_000
  if (preset === '1d') return due - 24 * 60 * 60_000
  return fromLocalInput(custom)
}

export function CreateTodoDialog({
  open,
  initial,
  defaultDueAt,
  onClose,
  onSaved
}: {
  open: boolean
  /** Редактирование существующей. */
  initial?: Item | null
  /** Стартовый срок при создании (например, выбранный день в календаре). */
  defaultDueAt?: number | null
  onClose: () => void
  onSaved?: (item: Item) => void
}): JSX.Element {
  const editing = Boolean(initial)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(() => toLocalInput(defaultDue()))
  const [hasDue, setHasDue] = useState(true)
  const [remind, setRemind] = useState<RemindPreset>('1h')
  const [remindCustom, setRemindCustom] = useState('')
  const [inCalendar, setInCalendar] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    if (initial) {
      setTitle(initial.title)
      if (initial.startsAt) {
        setHasDue(true)
        setDue(toLocalInput(initial.startsAt))
      } else {
        setHasDue(false)
        setDue(toLocalInput(defaultDue()))
      }
      const remindLine = initial.body.split('\n').find((l) => l.startsWith('remind:'))
      const remindMs = remindLine ? Number(remindLine.slice(7)) : null
      const cal = !initial.body.split('\n').includes('cal:0')
      setInCalendar(cal)
      const notes = initial.body
        .split('\n')
        .filter((l) => l.startsWith('note:'))
        .map((l) => l.slice(5))
        .join('\n')
      setNote(notes)
      if (remindMs && initial.startsAt) {
        const delta = initial.startsAt - remindMs
        if (Math.abs(delta) < 30_000) setRemind('at')
        else if (Math.abs(delta - 5 * 60_000) < 30_000) setRemind('5m')
        else if (Math.abs(delta - 15 * 60_000) < 30_000) setRemind('15m')
        else if (Math.abs(delta - 60 * 60_000) < 30_000) setRemind('1h')
        else if (Math.abs(delta - 24 * 60 * 60_000) < 30_000) setRemind('1d')
        else {
          setRemind('custom')
          setRemindCustom(toLocalInput(remindMs))
        }
      } else if (remindMs) {
        setRemind('custom')
        setRemindCustom(toLocalInput(remindMs))
      } else setRemind('none')
    } else {
      setTitle('')
      setHasDue(true)
      const seed =
        defaultDueAt != null && defaultDueAt > 0
          ? (() => {
              const d = new Date(defaultDueAt)
              // Если пришёл только день (00:00) — поставь 9:00, иначе сохрани время.
              if (d.getHours() === 0 && d.getMinutes() === 0) d.setHours(9, 0, 0, 0)
              return d.getTime()
            })()
          : defaultDue()
      setDue(toLocalInput(seed))
      setRemind('1h')
      setRemindCustom('')
      setInCalendar(true)
      setNote('')
    }
  }, [open, initial, defaultDueAt])

  const dueMs = useMemo(() => (hasDue ? fromLocalInput(due) : null), [hasDue, due])

  const submit = async (): Promise<void> => {
    const t = title.trim()
    if (!t) {
      setError('Напишите, что нужно сделать')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const remindAt = remindAtFromPreset(dueMs, remind, remindCustom)
      if (editing && initial) {
        const item = await window.kontur.todos.update({
          id: initial.id,
          title: t,
          dueAt: dueMs,
          remindAt,
          showInCalendar: inCalendar && dueMs != null,
          note
        })
        onSaved?.(item)
      } else {
        const payload: TodoCreatePayload = {
          title: t,
          dueAt: dueMs,
          remindAt,
          showInCalendar: inCalendar && dueMs != null,
          note
        }
        const item = await window.kontur.todos.create(payload)
        onSaved?.(item)
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Дело' : 'Новое дело'}</DialogTitle>
          <DialogDescription className="text-left">
            Срок, напоминание и появление в календаре — как в Напоминаниях на iPhone.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-1">
          <Input
            autoFocus
            placeholder="Что нужно сделать"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />

          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]">
            <span>Срок</span>
            <input
              type="checkbox"
              checked={hasDue}
              onChange={(e) => setHasDue(e.target.checked)}
              className="size-4 accent-primary"
            />
          </label>
          {hasDue && (
            <DateTimePicker value={due} onChange={setDue} />
          )}

          <div className="grid gap-1.5">
            <span className="text-[12px] text-muted-foreground">Напомнить</span>
            <Select
              value={remind}
              onValueChange={(v) => setRemind(v as RemindPreset)}
              disabled={!hasDue && remind !== 'custom' && remind !== 'none'}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Не напоминать</SelectItem>
                <SelectItem value="at" disabled={!hasDue}>
                  В момент срока
                </SelectItem>
                <SelectItem value="5m" disabled={!hasDue}>
                  За 5 минут
                </SelectItem>
                <SelectItem value="15m" disabled={!hasDue}>
                  За 15 минут
                </SelectItem>
                <SelectItem value="1h" disabled={!hasDue}>
                  За 1 час
                </SelectItem>
                <SelectItem value="1d" disabled={!hasDue}>
                  За 1 день
                </SelectItem>
                <SelectItem value="custom">В своё время…</SelectItem>
              </SelectContent>
            </Select>
            {remind === 'custom' && (
              <DateTimePicker value={remindCustom} onChange={setRemindCustom} placeholder="Когда напомнить" />
            )}
          </div>

          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]">
            <span>Показать в календаре</span>
            <input
              type="checkbox"
              checked={inCalendar && hasDue}
              disabled={!hasDue}
              onChange={(e) => setInCalendar(e.target.checked)}
              className="size-4 accent-primary"
            />
          </label>

          <Textarea
            placeholder="Заметка (необязательно)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />

          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Сохраняю…' : editing ? 'Сохранить' : 'Добавить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
