import { useCallback, useEffect, useMemo, useState, type ComponentType, type JSX } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import {
  Calendar as BigCalendar,
  dateFnsLocalizer,
  type CalendarProps,
  type Formats,
  type SlotInfo,
  type View
} from 'react-big-calendar'
import withDragAndDrop, { type EventInteractionArgs } from 'react-big-calendar/lib/addons/dragAndDrop'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css'
import '@/styles/big-calendar.css'
import {
  addDays,
  addMonths,
  addWeeks,
  endOfWeek,
  format,
  getDay,
  parse,
  startOfWeek
} from 'date-fns'
import { ru } from 'date-fns/locale'
import { toast } from '@/components/ui/toast'
import type { Item } from '@shared/types'
import { isMeetingInvitation } from '@shared/attention'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { EventDialog } from '@/components/EventDialog'
import { CreateEventDialog } from '@/components/CreateEventDialog'
import { CreateTodoDialog } from '@/components/CreateTodoDialog'

/**
 * Календарь на react-big-calendar (п. 4 подборки builder.io): виды
 * день / неделя / месяц / список, перетаскивание и растягивание своих встреч
 * и дел. По умолчанию — неделя.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
/** Акцент личных дел в сетке (не привязан к контуру). */
const TODO_ACCENT = '#0A84FF'

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: (d: Date) => startOfWeek(d, { weekStartsOn: 1 }),
  getDay,
  locales: { ru }
})

interface CalEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  item: Item
}

const DnDCalendar = withDragAndDrop<CalEvent>(
  BigCalendar as unknown as ComponentType<CalendarProps<CalEvent>>
)

const VIEWS: View[] = ['day', 'week', 'month', 'agenda']
type CalView = 'day' | 'week' | 'month' | 'agenda'

const MESSAGES = {
  date: 'Дата',
  time: 'Время',
  event: 'Событие',
  allDay: 'Весь день',
  week: 'Неделя',
  work_week: 'Рабочая неделя',
  day: 'День',
  month: 'Месяц',
  previous: 'Назад',
  next: 'Вперёд',
  yesterday: 'Вчера',
  tomorrow: 'Завтра',
  today: 'Сегодня',
  agenda: 'Список',
  noEventsInRange: 'В этом периоде событий нет',
  showMore: (n: number) => `ещё ${n}`
}

const range = (fmt: string) =>
  ({ start, end }: { start: Date; end: Date }, culture?: string): string =>
    `${localizer.format(start, fmt, culture)}–${localizer.format(end, fmt, culture)}`

const FORMATS: Formats = {
  timeGutterFormat: 'HH:mm',
  eventTimeRangeFormat: range('HH:mm'),
  eventTimeRangeStartFormat: ({ start }, culture) => `${localizer.format(start, 'HH:mm', culture)} –`,
  eventTimeRangeEndFormat: ({ end }, culture) => `– ${localizer.format(end, 'HH:mm', culture)}`,
  selectRangeFormat: range('HH:mm'),
  dayFormat: 'EEEEEE, d',
  weekdayFormat: 'EEEEEE',
  dayHeaderFormat: 'EEEE, d MMMM',
  agendaDateFormat: 'EEEEEE, d MMM',
  agendaTimeFormat: 'HH:mm',
  agendaTimeRangeFormat: range('HH:mm')
}

function isTodoVisible(t: Item): boolean {
  return (
    t.kind === 'todo' &&
    t.startsAt != null &&
    !t.body.split('\n').includes('cat:done') &&
    !t.body.split('\n').includes('cal:0')
  )
}

const isAllDay = (e: Item): boolean =>
  e.body.split('\n').some((l) => l === 'allday:1') ||
  (e.startsAt != null &&
    e.endsAt != null &&
    e.endsAt - e.startsAt >= DAY - 60_000 &&
    new Date(e.startsAt).getHours() === 0 &&
    new Date(e.startsAt).getMinutes() === 0)

/** Свои — можно двигать: дела и встречи, где я организатор / без участников. */
const canMove = (it: Item): boolean =>
  it.kind === 'todo' || (it.kind === 'event' && (it.state === 'организатор' || it.state === 'встреча'))

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v))

/**
 * Содержимое события в сетке. У получасовых время и название — в одну строку:
 * штатно время шло отдельной строкой, и название в такой высоте не помещалось.
 */
function EventContent({ event }: { event: CalEvent }): JSX.Element {
  const short = !event.allDay && event.end.getTime() - event.start.getTime() <= 30 * 60_000
  if (!short) return <span>{event.title}</span>
  return (
    <span className="block truncate">
      <span className="tabular-nums opacity-85">{format(event.start, 'HH:mm')}</span> {event.title}
    </span>
  )
}

const COMPONENTS = { event: EventContent }

function periodTitle(view: CalView, date: Date): string {
  // Без года: заголовок дня и так самый длинный, а в узком окне он обрезался.
  if (view === 'day') return format(date, 'EEEE, d MMMM', { locale: ru })
  if (view === 'month') return format(date, 'LLLL yyyy', { locale: ru })
  if (view === 'agenda') {
    return `${format(date, 'd MMM', { locale: ru })} – ${format(addDays(date, 30), 'd MMM yyyy', { locale: ru })}`
  }
  const a = startOfWeek(date, { weekStartsOn: 1 })
  const b = endOfWeek(date, { weekStartsOn: 1 })
  return a.getMonth() === b.getMonth()
    ? `${format(a, 'd', { locale: ru })} – ${format(b, 'd MMMM yyyy', { locale: ru })}`
    : `${format(a, 'd MMM', { locale: ru })} – ${format(b, 'd MMM yyyy', { locale: ru })}`
}

function shift(view: CalView, date: Date, dir: 1 | -1): Date {
  if (view === 'day') return addDays(date, dir)
  if (view === 'month') return addMonths(date, dir)
  if (view === 'agenda') return addDays(date, 30 * dir)
  return addWeeks(date, dir)
}

interface PendingMove {
  item: Item
  start: Date
  end: Date
}

export function Calendar({
  focusItemId,
  onFocused
}: {
  /** Открыть сразу конкретную встречу — пришли из уведомления/ленты. */
  focusItemId?: string
  /** Deep-link отработан — сбросить его на уровне окна. */
  onFocused?: () => void
}): JSX.Element {
  const { config } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [view, setView] = useState<CalView>('week')
  const [date, setDate] = useState(() => new Date())
  const [selectedEvent, setSelectedEvent] = useState<Item | null>(null)
  const [selectedTodo, setSelectedTodo] = useState<Item | null>(null)
  const [create, setCreate] = useState<{ start: number; end: number } | null>(null)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [moving, setMoving] = useState(false)

  const calServices = (config?.services ?? []).filter(
    (s) => (s.kind === 'mail' || s.kind === 'calendar') && s.enabled
  )
  const envOf = useCallback((envId: string) => config?.envs.find((e) => e.id === envId), [config])

  useEffect(() => {
    const load = (): void => {
      void Promise.all([
        window.kontur.items.query({ kinds: ['event'], limit: 2000 }),
        window.kontur.items.query({ kinds: ['todo'], limit: 500, mode: 'full' })
      ]).then(([events, todos]) => {
        setItems([...events, ...todos.filter(isTodoVisible)])
      })
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  // Уведомление о встрече / деле → день этой встречи + её карточка.
  useEffect(() => {
    if (!focusItemId || !items.length) return
    const ev = items.find((i) => i.id === focusItemId)
    if (!ev) return
    if (ev.startsAt != null) {
      setDate(new Date(ev.startsAt))
      setView('day')
    }
    if (ev.kind === 'todo') setSelectedTodo(ev)
    else setSelectedEvent(ev)
    onFocused?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItemId, items])

  const events = useMemo<CalEvent[]>(() => {
    const seen = new Set<string>()
    const out: CalEvent[] = []
    for (const it of items) {
      if (it.startsAt == null || seen.has(it.id)) continue
      seen.add(it.id)
      const start = new Date(it.startsAt)
      // У дела нет длительности — показываем получасовым блоком.
      const end = new Date(it.endsAt != null && it.endsAt > it.startsAt ? it.endsAt : it.startsAt + 30 * 60_000)
      out.push({ id: it.id, title: it.title, start, end, allDay: it.kind === 'event' && isAllDay(it), item: it })
    }
    return out
  }, [items])

  const eventPropGetter = useCallback(
    (e: CalEvent) => {
      const accent = e.item.kind === 'todo' ? TODO_ACCENT : (envOf(e.item.envId)?.accent ?? '#64748b')
      const canceled = e.item.state === 'отменена'
      // Приглашение из сетки не убираем — важно видеть, что оно пришло, — но
      // приглушаем штриховкой: настоящая встреча лежит рядом тем же часом.
      const invitation = isMeetingInvitation(e.item)
      const short = !e.allDay && e.end.getTime() - e.start.getTime() <= 30 * 60_000
      const className =
        [
          canceled && 'kontur-event-canceled',
          invitation && 'kontur-event-invitation',
          short && 'kontur-event-short'
        ]
          .filter(Boolean)
          .join(' ') || undefined
      // В «Списке» rbc вешает стиль на всю строку таблицы — сплошная заливка
      // делает список нечитаемым. Там только лёгкая подложка и цветная полоса.
      if (view === 'agenda') {
        return {
          className,
          style: {
            background: `color-mix(in oklab, ${accent} 14%, transparent)`,
            boxShadow: `inset 3px 0 0 ${accent}`,
            cursor: 'pointer'
          }
        }
      }
      return {
        className,
        style: {
          backgroundColor: accent,
          color: '#fff',
          cursor: canMove(e.item) ? 'grab' : 'pointer'
        }
      }
    },
    [envOf, view]
  )

  const tooltip = useCallback(
    (e: CalEvent) => {
      const hint = e.item.kind === 'todo' ? 'Дело' : e.item.body.split('\n')[0]?.trim()
      const env = e.item.kind === 'event' ? envOf(e.item.envId)?.short : undefined
      return [e.title, hint, env].filter(Boolean).join(' · ')
    },
    [envOf]
  )

  const openItem = (it: Item): void => {
    if (it.kind === 'todo') setSelectedTodo(it)
    else setSelectedEvent(it)
  }

  const onSelectSlot = (slot: SlotInfo): void => {
    const start = slot.start.getTime()
    let end = slot.end.getTime()
    // Клик по дню в месяце / «весь день» → как новая встреча: 10:00 на час.
    const wholeDays = end - start >= DAY && slot.start.getHours() === 0 && slot.start.getMinutes() === 0
    if (calServices.length === 0) {
      setCreateTodoOpen(true)
      return
    }
    if (wholeDays) {
      setCreate({ start: start + 10 * HOUR, end: start + 11 * HOUR })
      return
    }
    if (end - start < 15 * 60_000) end = start + HOUR
    setCreate({ start, end })
  }

  /** Применить перенос: сразу на сетке, при ошибке — вернуть как было. */
  const applyMove = async ({ item, start, end }: PendingMove): Promise<void> => {
    const before = item
    const moved: Item = { ...item, startsAt: start.getTime(), endsAt: item.kind === 'todo' ? item.endsAt : end.getTime() }
    setItems((prev) => prev.map((x) => (x.id === item.id ? moved : x)))
    try {
      if (item.kind === 'todo') {
        await window.kontur.todos.update({ id: item.id, dueAt: start.getTime() })
      } else {
        await window.kontur.calendar.update({ itemId: item.id, startsAt: start.getTime(), endsAt: end.getTime() })
        toast.success(`«${item.title}» перенесена на ${format(start, 'EEEEEE d MMM, HH:mm', { locale: ru })}`)
      }
    } catch (e) {
      setItems((prev) => prev.map((x) => (x.id === item.id ? before : x)))
      const raw = e instanceof Error ? e.message : String(e)
      toast.error(raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, ''))
    }
  }

  const onMove = ({ event, start, end, isAllDay: toAllDay }: EventInteractionArgs<CalEvent>): void => {
    const s = toDate(start)
    const e = toDate(end)
    if (!canMove(event.item)) return
    // Перевод между «весь день» и временем — это другой тип события, а не перенос.
    if (toAllDay != null && toAllDay !== event.allDay) {
      toast.info('Перенос в «весь день» и обратно пока не поддерживается — откройте встречу и измените время')
      return
    }
    if (s.getTime() === event.start.getTime() && e.getTime() === event.end.getTime()) return
    const move = { item: event.item, start: s, end: e }
    // Встреча с участниками — им уйдёт обновление: спрашиваем, а не шлём молча.
    if (event.item.kind === 'event' && event.item.state === 'организатор') setPendingMove(move)
    else void applyMove(move)
  }

  const goToday = (): void => setDate(new Date())

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pt-5 pb-4 sm:px-6 lg:px-8">
      <div className="mb-3 shrink-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Календарь</h1>
        <p className="mt-1 text-muted-foreground">
          {calServices.length === 0
            ? 'Личные дела. Почту и календарь можно подключить в настройках.'
            : 'Перетащите свою встречу, чтобы перенести; выделите время в сетке, чтобы создать.'}
        </p>
      </div>

      {/* Панель — отдельной строкой: рядом с заголовком в узком окне подпись сжималась в колонку. */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" title="Назад" onClick={() => setDate((d) => shift(view, d, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday}>
            Сегодня
          </Button>
          <Button variant="ghost" size="icon-sm" title="Вперёд" onClick={() => setDate((d) => shift(view, d, 1))}>
            <ChevronRight />
          </Button>
        </div>
        {/* shrink-0 + mr-auto: в узком окне на новую строку переносятся вкладки,
            а заголовок периода остаётся целым, а не обрезается многоточием. */}
        <span className="mr-auto shrink-0 text-[15px] font-semibold first-letter:uppercase">
          {periodTitle(view, date)}
        </span>
        <Segmented
          ariaLabel="Вид календаря"
          value={view}
          onChange={(v) => setView(v as CalView)}
          items={[
            { value: 'day', label: 'День' },
            { value: 'week', label: 'Неделя' },
            { value: 'month', label: 'Месяц' },
            { value: 'agenda', label: 'Список' }
          ]}
        />
        <Button size="sm" variant="outline" onClick={() => setCreateTodoOpen(true)}>
          <Plus />
          Дело
        </Button>
        <Button
          size="sm"
          disabled={calServices.length === 0}
          onClick={() => {
            const d = new Date()
            d.setMinutes(0, 0, 0)
            d.setHours(d.getHours() + 1)
            setCreate({ start: d.getTime(), end: d.getTime() + HOUR })
          }}
        >
          <Plus />
          Событие
        </Button>
      </div>

      <div className="kontur-calendar min-h-0 flex-1">
        <DnDCalendar
          localizer={localizer}
          culture="ru"
          events={events}
          views={VIEWS}
          view={view}
          onView={(v) => setView(v as CalView)}
          date={date}
          onNavigate={(d) => setDate(d)}
          toolbar={false}
          messages={MESSAGES}
          formats={FORMATS}
          step={30}
          timeslots={2}
          scrollToTime={new Date(1970, 0, 1, 8, 0)}
          dayLayoutAlgorithm="no-overlap"
          popup
          selectable
          onSelectSlot={onSelectSlot}
          onSelectEvent={(e) => openItem(e.item)}
          onDrillDown={(d) => {
            setDate(d)
            setView('day')
          }}
          eventPropGetter={eventPropGetter}
          tooltipAccessor={tooltip}
          components={COMPONENTS}
          draggableAccessor={(e) => canMove(e.item)}
          resizableAccessor={(e) => canMove(e.item) && e.item.kind === 'event' && !e.allDay}
          onEventDrop={onMove}
          onEventResize={onMove}
          style={{ height: '100%' }}
        />
      </div>

      <EventDialog
        event={selectedEvent?.kind === 'event' ? selectedEvent : null}
        envName={selectedEvent?.kind === 'event' ? envOf(selectedEvent.envId)?.name : undefined}
        envAccent={selectedEvent?.kind === 'event' ? envOf(selectedEvent.envId)?.accent : undefined}
        onClose={() => setSelectedEvent(null)}
        onUpdated={(it) => {
          setSelectedEvent(it)
          setItems((prev) => prev.map((x) => (x.id === it.id ? it : x)))
        }}
      />
      <CreateTodoDialog
        open={selectedTodo != null || createTodoOpen}
        initial={selectedTodo}
        defaultDueAt={createTodoOpen ? date.getTime() : null}
        onClose={() => {
          setSelectedTodo(null)
          setCreateTodoOpen(false)
        }}
        onSaved={(it) => {
          setItems((prev) => {
            if (!isTodoVisible(it)) return prev.filter((x) => x.id !== it.id)
            const idx = prev.findIndex((x) => x.id === it.id)
            if (idx < 0) return [...prev, it]
            return prev.map((x) => (x.id === it.id ? it : x))
          })
        }}
      />
      <CreateEventDialog
        open={create != null}
        initialStart={create?.start ?? null}
        initialEnd={create?.end ?? null}
        onClose={() => setCreate(null)}
      />

      <Dialog open={pendingMove != null} onOpenChange={(v) => !v && !moving && setPendingMove(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Перенести встречу?</DialogTitle>
            <DialogDescription>
              {pendingMove &&
                `«${pendingMove.item.title}» → ${format(pendingMove.start, 'EEEE, d MMMM, HH:mm', { locale: ru })}–${format(pendingMove.end, 'HH:mm')}. Участникам уйдёт обновление приглашения.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" disabled={moving} onClick={() => setPendingMove(null)}>
              Отмена
            </Button>
            <Button
              disabled={moving}
              onClick={() => {
                if (!pendingMove) return
                setMoving(true)
                void applyMove(pendingMove).finally(() => {
                  setMoving(false)
                  setPendingMove(null)
                })
              }}
            >
              {moving ? 'Переносим…' : 'Перенести'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
