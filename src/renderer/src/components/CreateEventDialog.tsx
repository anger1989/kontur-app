import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type {
  CalendarCreatePayload,
  CalendarPerson,
  CalendarScheduleResult,
  CalendarUpdatePayload,
  FreeBusySlot,
  Item
} from '@shared/types'
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
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

function fromLocalInput(v: string): number {
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

function defaultStart(day?: number | null): number {
  if (day != null) return day + 10 * 3600_000
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d.getTime()
}

const SLOT_COLORS: Record<FreeBusySlot, string> = {
  0: 'bg-emerald-500/25',
  1: 'bg-amber-400/40',
  2: 'bg-red-500/55',
  3: 'bg-violet-500/45',
  4: 'bg-muted/60'
}

function slotLabel(s: FreeBusySlot): string {
  return ['свободен', 'под вопросом', 'занят', 'вне офиса', 'нет данных'][s] ?? ''
}

/** Снимок полей формы при открытии редактирования — чтобы отправить только изменённое. */
interface EditSnapshot {
  subject: string
  startsAt: string
  endsAt: string
  location: string
  body: string
  attendees: string
}

const attendeesKey = (people: CalendarPerson[]): string =>
  people
    .map((p) => p.email.toLowerCase())
    .sort()
    .join(', ')

export function CreateEventDialog({
  open,
  initialDay,
  onClose,
  onCreated,
  editItem,
  onSaved,
  initialStart,
  initialEnd
}: {
  open: boolean
  initialDay?: number | null
  /** Интервал, выделенный мышью в сетке календаря. */
  initialStart?: number | null
  initialEnd?: number | null
  onClose: () => void
  onCreated?: () => void
  /** Режим редактирования/переноса своей встречи. */
  editItem?: Item | null
  onSaved?: (item: Item) => void
}): JSX.Element {
  const { config } = useStore()
  const services = useMemo(
    () =>
      (config?.services ?? []).filter(
        (s) => (s.kind === 'mail' || s.kind === 'calendar') && s.enabled
      ),
    [config]
  )

  const [serviceId, setServiceId] = useState(services[0]?.id ?? '')
  const [subject, setSubject] = useState('')
  const [startsAt, setStartsAt] = useState(() => toLocalInput(defaultStart(initialDay)))
  const [endsAt, setEndsAt] = useState(() => toLocalInput(defaultStart(initialDay) + 3600_000))
  const [location, setLocation] = useState('')
  const [people, setPeople] = useState<CalendarPerson[]>([])
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<CalendarPerson[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<CalendarScheduleResult | null>(null)
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<HTMLInputElement>(null)
  const snapshot = useRef<EditSnapshot | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [recurring, setRecurring] = useState(false)
  const editing = editItem != null

  const sid = serviceId || services[0]?.id || ''

  useEffect(() => {
    if (!open) return
    setDraft('')
    setSuggestions([])
    setSuggestOpen(false)
    setError(null)
    setBusy(false)
    setSchedule(null)
    setRecurring(false)

    if (editItem) {
      // Редактирование: время и тема — из встречи, участники/место/описание — с сервера.
      const start = toLocalInput(editItem.startsAt ?? Date.now())
      const end = toLocalInput(editItem.endsAt ?? (editItem.startsAt ?? Date.now()) + 3600_000)
      setServiceId(editItem.serviceId)
      setSubject(editItem.title)
      setStartsAt(start)
      setEndsAt(end)
      setLocation('')
      setBody('')
      setPeople([])
      snapshot.current = { subject: editItem.title, startsAt: start, endsAt: end, location: '', body: '', attendees: '' }
      setLoadingDetails(true)
      let alive = true
      void window.kontur.calendar
        .details(editItem.id)
        .then((d) => {
          if (!alive) return
          setLocation(d.location)
          setBody(d.body)
          setPeople(d.attendees)
          setRecurring(d.recurring)
          snapshot.current = {
            ...snapshot.current!,
            location: d.location,
            body: d.body,
            attendees: attendeesKey(d.attendees)
          }
        })
        .catch((e: unknown) => {
          if (!alive) return
          const raw = e instanceof Error ? e.message : String(e)
          // Без деталей можно перенести/переименовать; участников/место тогда не трогаем.
          setError(`Не удалось загрузить участников и описание: ${raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')}`)
        })
        .finally(() => alive && setLoadingDetails(false))
      return () => {
        alive = false
      }
    }

    snapshot.current = null
    const s = initialStart ?? defaultStart(initialDay)
    const e = initialEnd != null && initialEnd > s ? initialEnd : s + 3600_000
    setSubject('')
    setStartsAt(toLocalInput(s))
    setEndsAt(toLocalInput(e))
    setLocation('')
    setPeople([])
    setBody('')
    if (services[0]) setServiceId(services[0].id)
    return undefined
  }, [open, initialDay, services, editItem, initialStart, initialEnd])

  // Автокомплит участников: GAL + локальный кэш.
  useEffect(() => {
    if (!open || !sid) return
    if (suggestTimer.current) clearTimeout(suggestTimer.current)
    const q = draft.trim()
    if (q.length < 1) {
      setSuggestions([])
      setSuggestOpen(false)
      return
    }
    suggestTimer.current = setTimeout(() => {
      void window.kontur.calendar.suggestPeople(sid, q).then((list) => {
        const taken = new Set(people.map((p) => p.email))
        const next = list.filter((p) => !taken.has(p.email))
        setSuggestions(next)
        setSuggestOpen(next.length > 0)
      })
    }, 220)
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current)
    }
  }, [draft, sid, open, people])

  // Планировщик пересечений — при смене времени / участников.
  useEffect(() => {
    if (!open || !sid) return
    const start = fromLocalInput(startsAt)
    const end = fromLocalInput(endsAt)
    if (!(start > 0) || !(end > start)) {
      setSchedule(null)
      return
    }
    const t = setTimeout(() => {
      void window.kontur.calendar
        .schedule({
          serviceId: sid,
          startsAt: start,
          endsAt: end,
          emails: people.map((p) => p.email),
          excludeItemId: editItem?.id
        })
        .then(setSchedule)
        .catch(() => setSchedule(null))
    }, 280)
    return () => clearTimeout(t)
  }, [open, sid, startsAt, endsAt, people, editItem])

  const addPerson = (p: CalendarPerson): void => {
    setPeople((prev) => (prev.some((x) => x.email === p.email) ? prev : [...prev, p]))
    setDraft('')
    setSuggestions([])
    setSuggestOpen(false)
    draftRef.current?.focus()
  }

  const commitDraft = (): void => {
    const raw = draft.trim()
    if (!raw) return
    if (suggestions[0]) {
      addPerson(suggestions[0])
      return
    }
    const email = raw.toLowerCase()
    if (!email.includes('@')) {
      setError('Укажите email или выберите человека из списка')
      return
    }
    addPerson({ email, name: email.split('@')[0] || email, source: 'local' })
  }

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && !draft && people.length) {
      setPeople((prev) => prev.slice(0, -1))
    } else if (e.key === 'Escape') {
      setSuggestOpen(false)
    } else if (e.key === 'ArrowDown' && suggestions[0]) {
      e.preventDefault()
      setSuggestOpen(true)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!editItem || !snapshot.current) return
    const was = snapshot.current
    const payload: CalendarUpdatePayload = { itemId: editItem.id }
    if (subject.trim() !== was.subject.trim()) payload.subject = subject.trim()
    if (startsAt !== was.startsAt || endsAt !== was.endsAt) {
      payload.startsAt = fromLocalInput(startsAt)
      payload.endsAt = fromLocalInput(endsAt)
    }
    // Пока детали не загрузились (или не загрузились вовсе) — участников/место/описание не трогаем.
    if (!loadingDetails && !error?.startsWith('Не удалось загрузить')) {
      if (location.trim() !== was.location.trim()) payload.location = location.trim()
      if (body.trim() !== was.body.trim()) payload.body = body.trim()
      if (attendeesKey(people) !== was.attendees) payload.attendees = people.map((p) => p.email).join(', ')
    }
    if (Object.keys(payload).length === 1) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const item = await window.kontur.calendar.update(payload)
      onSaved?.(item)
      onClose()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setError(raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, ''))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (editing) return saveEdit()
    if (!sid) {
      setError('Нет настроенного календаря')
      return
    }
    const payload: CalendarCreatePayload = {
      serviceId: sid,
      subject,
      startsAt: fromLocalInput(startsAt),
      endsAt: fromLocalInput(endsAt),
      location: location.trim() || undefined,
      attendees: people.map((p) => p.email).join(', ') || undefined,
      body: body.trim() || undefined
    }
    setBusy(true)
    setError(null)
    try {
      await window.kontur.calendar.create(payload)
      onCreated?.()
      onClose()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const inner = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
      setError(inner)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Изменить встречу' : 'Новая встреча'}</DialogTitle>
          <DialogDescription>
            {editing
              ? recurring
                ? 'Повторяющаяся встреча: изменения коснутся только этого дня. Участникам уйдёт обновление.'
                : people.length
                  ? 'Участникам уйдёт обновление приглашения.'
                  : 'Перенесите время или поправьте детали.'
              : 'Участники из адресной книги, пересечения — как в Outlook.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-[13px]">
          {!editing && services.length > 1 && (
            <label className="block space-y-1">
              <span className="text-muted-foreground">Календарь</span>
              <Select value={sid} onValueChange={setServiceId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {services.map((s) => {
                    const env = config?.envs.find((e) => e.id === s.envId)
                    return (
                      <SelectItem key={s.id} value={s.id}>
                        {env?.short ? `${env.short} · ` : ''}
                        {s.name}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </label>
          )}

          <label className="block space-y-1">
            <span className="text-muted-foreground">Тема</span>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-muted-foreground">Начало</span>
              <DateTimePicker
                value={startsAt}
                onChange={(next) => {
                  // Как в Outlook: сдвигаем конец на ту же длительность, а не оставляем на месте.
                  const was = fromLocalInput(startsAt)
                  const dur = fromLocalInput(endsAt) - was
                  setStartsAt(next)
                  if (was > 0 && dur > 0) setEndsAt(toLocalInput(fromLocalInput(next) + dur))
                }}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-muted-foreground">Конец</span>
              <DateTimePicker value={endsAt} onChange={setEndsAt} />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-muted-foreground">Место</span>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>

          <div className="relative space-y-1">
            <span className="text-muted-foreground">Участники</span>
            <div
              className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1.5"
              onClick={() => draftRef.current?.focus()}
            >
              {people.map((p) => (
                <span
                  key={p.email}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[12px]"
                  title={p.email}
                >
                  <span className="truncate">{p.name}</span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPeople((prev) => prev.filter((x) => x.email !== p.email))
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              <input
                ref={draftRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setError(null)
                }}
                onKeyDown={onDraftKey}
                onBlur={() => {
                  // Дать клику по suggestion сработать.
                  window.setTimeout(() => setSuggestOpen(false), 150)
                }}
                onFocus={() => {
                  if (suggestions.length) setSuggestOpen(true)
                }}
                placeholder={people.length ? '' : 'Начните вводить имя или email'}
                className="min-w-[8rem] flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            {suggestOpen && suggestions.length > 0 && (
              <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover py-1 shadow-lg">
                {suggestions.map((p) => (
                  <li key={p.email}>
                    <button
                      type="button"
                      className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-accent"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        addPerson(p)
                      }}
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {p.email}
                        {p.source === 'gal' ? ' · GAL' : ' · из почты'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {schedule && <SchedulingAssistant schedule={schedule} />}

          <label className="block space-y-1">
            <span className="text-muted-foreground">Описание</span>
            <textarea
              className="min-h-[72px] w-full rounded-md border bg-background px-3 py-2 text-[13px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          {loadingDetails && (
            <p className="text-[12px] text-muted-foreground">Загружаем участников и описание…</p>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !subject.trim()}>
            {editing ? (busy ? 'Сохраняем…' : 'Сохранить') : busy ? 'Создаём…' : 'Создать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Лента дня: я + участники, слоты 30 мин, рамка предложенного интервала. */
function SchedulingAssistant({ schedule }: { schedule: CalendarScheduleResult }): JSX.Element {
  const { dayStart, slotMinutes, proposedStart, proposedEnd, rows, conflicts } = schedule
  const slotMs = slotMinutes * 60_000
  const dayEnd = dayStart + 86_400_000
  // Показываем рабочий день 8–20, иначе слишком мелко.
  const viewStart = dayStart + 8 * 3600_000
  const viewEnd = dayStart + 20 * 3600_000
  const firstSlot = Math.max(0, Math.floor((viewStart - dayStart) / slotMs))
  const lastSlot = Math.min(rows[0]?.slots.length ?? 0, Math.ceil((viewEnd - dayStart) / slotMs))
  const visible = Math.max(1, lastSlot - firstSlot)

  const propLeft = ((proposedStart - viewStart) / (viewEnd - viewStart)) * 100
  const propWidth = ((proposedEnd - proposedStart) / (viewEnd - viewStart)) * 100

  const hours = [8, 10, 12, 14, 16, 18, 20]

  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium">Планировщик</span>
        {conflicts.length > 0 ? (
          <span className="text-[11px] text-destructive">
            Пересечение с {conflicts.length === 1 ? `«${conflicts[0]!.title}»` : `${conflicts.length} встречами`}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">В вашем календаре свободно</span>
        )}
      </div>

      <div className="relative ml-[5.5rem]">
        <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
          {hours.map((h) => (
            <span key={h}>{String(h).padStart(2, '0')}:00</span>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.email} className="flex items-center gap-2">
            <div className="w-[5.5rem] shrink-0 truncate text-[11px]" title={row.email}>
              {row.name}
            </div>
            <div className="relative h-5 min-w-0 flex-1 overflow-hidden rounded bg-muted/40">
              <div className="absolute inset-0 flex">
                {row.slots.slice(firstSlot, lastSlot).map((s, i) => (
                  <div
                    key={i}
                    className={cn('h-full flex-1 border-r border-background/40 last:border-0', SLOT_COLORS[s])}
                    title={`${slotLabel(s)}`}
                  />
                ))}
              </div>
              {proposedEnd > viewStart && proposedStart < viewEnd && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-[1] border-2 border-primary/80 bg-primary/10"
                  style={{
                    left: `${Math.max(0, Math.min(100, propLeft))}%`,
                    width: `${Math.max(2, Math.min(100 - Math.max(0, propLeft), propWidth))}%`
                  }}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <i className={cn('inline-block size-2 rounded-sm', SLOT_COLORS[0])} /> свободно
        </span>
        <span className="inline-flex items-center gap-1">
          <i className={cn('inline-block size-2 rounded-sm', SLOT_COLORS[1])} /> под вопросом
        </span>
        <span className="inline-flex items-center gap-1">
          <i className={cn('inline-block size-2 rounded-sm', SLOT_COLORS[2])} /> занят
        </span>
        <span className="inline-flex items-center gap-1">
          <i className={cn('inline-block size-2 rounded-sm', SLOT_COLORS[4])} /> нет данных
        </span>
      </div>

      {/* visible unused but keeps ratio logic honest if we tweak later */}
      <span className="sr-only">{visible} слотов · до {new Date(dayEnd).toLocaleDateString('ru')}</span>
    </div>
  )
}
