import { useEffect, useMemo, useState, type JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Item } from '@shared/types'
import { countsAsMeeting, dedupeMeetings } from '@shared/attention'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StatsCard, type StatsBar } from '@/components/ui/stats-card'

const DAY = 86_400_000
const HOUR = 3_600_000
/** В капасити не тащим сутки целиком — иначе all-day/многодневные раздувают сумму. */
const MAX_MEETING_MS = 8 * HOUR
const DAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

function startOfDay(ts = Date.now()): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function isWeekend(ts: number): boolean {
  const d = new Date(ts).getDay()
  return d === 0 || d === 6
}

/**
 * Последние `n` рабочих дней включительно от `from` (сегодня → назад, сб/вс
 * пропускаем). Порядок хронологический: старые слева.
 */
function lastWorkdays(n: number, from = startOfDay()): number[] {
  const out: number[] = []
  let t = from
  // Запас по календарю: 7 раб. дней ≈ ≤ 11 календарных.
  for (let i = 0; out.length < n && i < n * 3; i++) {
    if (!isWeekend(t)) out.push(t)
    t -= DAY
  }
  return out.reverse()
}

/**
 * Ближайшие `n` рабочих дней, начиная с сегодняшнего (сб/вс пропускаем).
 *
 * Встречи смотрят вперёд, а не назад: прошедший день уже не разгрузить, а
 * завтрашний — вполне. Ровно пять рабочих дней берём ещё и потому, что это
 * единственная длина, при которой подписи заведомо не повторяются: в неделе
 * пять рабочих дней, и любые пять подряд дают пять разных названий. У
 * прежнего скользящего окна на семь дней в ряду стояли два «вт» и две «ср»,
 * и понять, где какая неделя, было нельзя.
 */
function nextWorkdays(n: number, from = startOfDay()): number[] {
  const out: number[] = []
  let t = from
  for (let i = 0; out.length < n && i < n * 3; i++) {
    if (!isWeekend(t)) out.push(t)
    t += DAY
  }
  return out
}

function dayLabel(ts: number): string {
  return DAY_LABELS[(new Date(ts).getDay() + 6) % 7]!
}

function parseCat(body: string): 'new' | 'indeterminate' | 'done' {
  const line = body.split('\n').find((l) => l.startsWith('cat:'))
  const k = line?.slice(4)
  if (k === 'indeterminate' || k === 'done' || k === 'new') return k
  return 'new'
}

function parseSp(body: string): number | null {
  const line = body.split('\n').find((l) => l.startsWith('sp:'))
  if (!line) return null
  const n = +line.slice(3)
  return Number.isFinite(n) ? n : null
}

function parseResolved(body: string): number | null {
  const line = body.split('\n').find((l) => l.startsWith('res:'))
  if (!line) return null
  const n = +line.slice(4)
  return Number.isFinite(n) ? n : null
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function fmtSp(n: number | null): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/** «1 встреча / 2 встречи / 5 встреч» — без этого подпись под цифрой врёт. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Счётчики по дням в точки графика: высота в процентах от самого высокого дня. */
function barsFrom(
  values: number[],
  labels: string[],
  unit: string,
  /** Какая точка «сегодня». По умолчанию — последняя. */
  currentIndex?: number
): StatsBar[] {
  const max = Math.max(1, ...values)
  const current = currentIndex ?? values.length - 1
  return values.map((v, i) => ({
    name: labels[i] ?? '',
    value: Math.round((v / max) * 100),
    label: String(v),
    current: i === current,
    title: `${labels[i] ?? ''}: ${v} ${unit}`
  }))
}

function fmtHours(ms: number): string {
  const h = ms / HOUR
  if (h < 1) return `${Math.round(h * 60)} мин`
  return `${h.toFixed(1).replace(/\.0$/, '')} ч`
}

/** All-day / многодневные: явный маркер или длительность ≥ 20ч. */
function isAllDayLike(e: Item): boolean {
  if (e.body.split('\n').some((l) => l === 'allday:1')) return true
  if (e.startsAt == null || e.endsAt == null) return false
  return e.endsAt - e.startsAt >= 20 * HOUR
}

/**
 * Запись календаря, которой не место в капасити: отменённая, отклонённая,
 * приглашение-дубль или событие на весь день.
 */
function isSkippedMeeting(e: Item): boolean {
  if (!countsAsMeeting(e)) return true
  return isAllDayLike(e)
}

function meetingDuration(e: Item): number {
  if (e.startsAt == null) return 0
  const end = e.endsAt ?? e.startsAt + HOUR
  return Math.min(MAX_MEETING_MS, Math.max(0, end - e.startsAt))
}

/** Объединение интервалов — доля дня без двойного счёта пересечений. */
function unionMs(items: Item[], from: number, to: number): number {
  const ranges = items
    .map((e) => {
      if (e.startsAt == null) return null
      const a = Math.max(from, e.startsAt)
      const b = Math.min(to, e.endsAt ?? e.startsAt + HOUR)
      if (b <= a) return null
      return [a, Math.min(b, a + MAX_MEETING_MS)] as [number, number]
    })
    .filter((r): r is [number, number] => r != null)
    .sort((x, y) => x[0] - y[0])

  if (!ranges.length) return 0

  let total = 0
  let [curA, curB] = ranges[0]!
  for (let i = 1; i < ranges.length; i++) {
    const [a, b] = ranges[i]!
    if (a <= curB) curB = Math.max(curB, b)
    else {
      total += curB - curA
      curA = a
      curB = b
    }
  }
  total += curB - curA
  return total
}

/** Мини-бары: закрытия по рабочим дням. */
function MiniBars({
  values,
  labels,
  accent
}: {
  values: number[]
  labels: string[]
  accent?: string
}): JSX.Element {
  const max = Math.max(1, ...values)
  return (
    <div className="flex h-16 items-end gap-1">
      {values.map((v, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div className="flex h-12 w-full items-end justify-center">
            <div
              className="w-full max-w-[18px] rounded-sm bg-primary/70 transition-[height]"
              style={{
                height: `${Math.max(v > 0 ? 12 : 2, (v / max) * 100)}%`,
                background: accent
              }}
              title={`${labels[i]}: ${v}`}
            />
          </div>
          <span className="text-[9px] text-muted-foreground uppercase">{labels[i]}</span>
        </div>
      ))}
    </div>
  )
}

function Stat({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** Одна цифра полоски: значение крупнее, подпись рядом — строка читается слитно. */
function Metric({
  value,
  label,
  tone
}: {
  value: string
  label: string
  tone?: 'warn'
}): JSX.Element {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span
        className={cn(
          'text-[14px] font-semibold tabular-nums',
          tone === 'warn' && 'text-[var(--warning)]'
        )}
      >
        {value}
      </span>
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">{label}</span>
    </span>
  )
}

function Divider(): JSX.Element {
  return <span className="h-3.5 w-px shrink-0 bg-border" />
}

/** Спарклайн-бары закрытий за 7 раб. дней — тренд без осей и подписей. */
function Spark({ values }: { values: number[] }): JSX.Element {
  const max = Math.max(1, ...values)
  return (
    <span className="flex h-4 shrink-0 items-end gap-[3px]" title="Закрытия за 7 раб. дней">
      {values.map((v, i) => (
        <span
          key={i}
          className="w-[4px] rounded-[1px] bg-primary/60"
          style={{ height: `${Math.max(v > 0 ? 25 : 8, (v / max) * 100)}%` }}
        />
      ))}
    </span>
  )
}

/** Компактный линейный спарклайн (встречи на ближайшие раб. дни) — в полоску виджета. */
function LineSpark({ values, labels }: { values: number[]; labels: string[] }): JSX.Element {
  const max = Math.max(1, ...values)
  const w = 72
  const h = 16
  const n = values.length
  const pts = values.map((v, i) => {
    const x = n <= 1 ? w / 2 : (i / (n - 1)) * w
    const y = h - 1.5 - (v / max) * (h - 3)
    return [x, y] as const
  })
  const polyline = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <span className="inline-flex shrink-0" title={`Встречи на 5 раб. дней вперёд · ${total}`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polyline}
          className="text-primary/70"
        />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={values[i]! > 0 ? 1.6 : 1.1}
            className={values[i]! > 0 ? 'fill-primary' : 'fill-muted-foreground/40'}
          >
            <title>{`${labels[i]}: ${values[i]}`}</title>
          </circle>
        ))}
      </svg>
    </span>
  )
}

/** Линейный график встреч на ближайшие рабочие дни — в модалке «Подробнее». */
function MiniLine({ values, labels }: { values: number[]; labels: string[] }): JSX.Element {
  const max = Math.max(1, ...values)
  const w = 280
  const h = 64
  const padX = 10
  const padTop = 14
  const padBot = 4
  const plotH = h - padTop - padBot
  const n = values.length
  const pts = values.map((v, i) => {
    const x = padX + (n <= 1 ? 0 : (i / (n - 1)) * (w - padX * 2))
    const y = padTop + plotH - (v / max) * plotH
    return [x, y] as const
  })
  const polyline = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const area =
    `${padX},${padTop + plotH} ` +
    polyline +
    ` ${w - padX},${padTop + plotH}`

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" aria-hidden>
        <line
          x1={padX}
          y1={padTop + plotH}
          x2={w - padX}
          y2={padTop + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        <polygon points={area} className="fill-primary/15" />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polyline}
          className="text-primary"
        />
        {pts.map(([x, y], i) => (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={3}
              className={values[i]! > 0 ? 'fill-primary' : 'fill-muted-foreground/50'}
            >
              <title>{`${labels[i]}: ${values[i]}`}</title>
            </circle>
            {values[i]! > 0 && (
              <text
                x={x}
                y={y - 7}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {values[i]}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="mt-0.5 flex justify-between px-1.5">
        {labels.map((l, i) => (
          <span key={i} className="text-[9px] text-muted-foreground uppercase">
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Компактная сводка капасити: сторипоинты, закрытия, встречи.
 * Считается локально из уже синхронизированных items.
 */
/** Все цифры «Моего дня» из задач и событий. Чистый расчёт, без React. */
function computeInsights(tasks: Item[], events: Item[]) {
  const now = Date.now()
  const day0 = startOfDay(now)
  // Закрытия задач — окно назад (в будущем их просто нет), встречи — вперёд
  // от сегодня (см. nextWorkdays).
  const workdays = lastWorkdays(7, day0)
  const dayLabels = workdays.map(dayLabel)
  const aheadDays = nextWorkdays(5, day0)
  const aheadLabels = aheadDays.map(dayLabel)
  // Сегодня — первый день ряда, кроме выходных: тогда ряд начинается с пн.
  const todayIndex = aheadDays.findIndex((d) => d === day0)
  const d14 = now - 14 * DAY

  const open = tasks.filter((t) => parseCat(t.body) !== 'done')
  const done = tasks.filter((t) => parseCat(t.body) === 'done')
  const done14 = done.filter((t) => {
    const r = parseResolved(t.body) ?? t.updatedAt
    return r >= d14
  })

  const openSp = open.map((t) => parseSp(t.body)).filter((n): n is number => n != null)
  const doneSp = done14.map((t) => parseSp(t.body)).filter((n): n is number => n != null)

  // dedupe: одна и та же личная встреча приезжает из обоих контуров, и без
  // склейки день выглядел вдвое плотнее, чем он есть.
  const meetingsIn = (from: number, to: number): Item[] =>
    dedupeMeetings(
      events.filter(
        (e) =>
          e.startsAt != null &&
          e.startsAt >= from &&
          e.startsAt < to &&
          !isSkippedMeeting(e)
      )
    )

  const closedPerDay = workdays.map((from) => {
    const to = from + DAY
    return done.filter((t) => {
      const r = parseResolved(t.body) ?? t.updatedAt
      return r >= from && r < to
    }).length
  })

  const meetingsPerDay = aheadDays.map((from) => meetingsIn(from, from + DAY).length)

  const todayMeetings = meetingsIn(day0, day0 + DAY)
  const weekMeetings = aheadDays.flatMap((from) => meetingsIn(from, from + DAY))
  const todayMs = todayMeetings.reduce((s, e) => s + meetingDuration(e), 0)
  const weekMs = weekMeetings.reduce((s, e) => s + meetingDuration(e), 0)
  const avgMeeting = weekMeetings.length ? weekMs / weekMeetings.length : null
  // Доля дня — по объединению интервалов, без двойного счёта пересечений.
  const todayBusy = unionMs(todayMeetings, day0, day0 + DAY)

  return {
    openCount: open.length,
    openSpSum: openSp.reduce((a, b) => a + b, 0),
    openSpAvg: mean(openSp),
    openSpMed: median(openSp),
    done14: done14.length,
    doneSpAvg: mean(doneSp),
    doneSpMed: median(doneSp),
    closedPerDay,
    meetingsPerDay,
    dayLabels,
    aheadLabels,
    /** Индекс сегодняшнего дня в ряду; -1 — сегодня выходной. */
    todayIndex,
    todayMeetings: todayMeetings.length,
    todayMs,
    weekMeetings: weekMeetings.length,
    weekMs,
    avgMeeting,
    todayBusy,
    hasTasks: tasks.length > 0,
    hasEvents: events.length > 0,
    hasSp: openSp.length + doneSp.length > 0
  }
}

/** Результат расчёта — его же показывает модалка с подробностями. */
type InsightStats = ReturnType<typeof computeInsights>

/** Подробности капасити. Одна и та же модалка для строки и для карточки. */
function CapacityDialog({
  open,
  onOpenChange,
  stats,
  spHint
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  stats: InsightStats
  spHint: string
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Капасити дня</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="SP среднее" value={fmtSp(stats.doneSpAvg ?? stats.openSpAvg)} hint={spHint} />
            <Stat
              label="SP медиана"
              value={fmtSp(stats.doneSpMed ?? stats.openSpMed)}
              hint={stats.openSpMed != null ? `открытые · ${fmtSp(stats.openSpMed)}` : undefined}
            />
            <Stat
              label="Встречи · 5 раб. дней"
              value={String(stats.weekMeetings)}
              hint={fmtHours(stats.weekMs)}
            />
            <Stat
              label="Ср. длительность"
              value={stats.avgMeeting != null ? fmtHours(stats.avgMeeting) : '—'}
            />
          </div>
          {stats.hasEvents && (
            <div>
              <div className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                Встречи · ближайшие 5 рабочих дней
              </div>
              <MiniLine values={stats.meetingsPerDay} labels={stats.aheadLabels} />
            </div>
          )}
          {stats.hasTasks && (
            <div>
              <div className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                Закрытия · 7 раб. дней
              </div>
              <MiniBars values={stats.closedPerDay} labels={stats.dayLabels} />
            </div>
          )}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Доля дня считается от 8-часового рабочего дня по объединению интервалов —
            пересекающиеся встречи не учитываются дважды. All-day и отклонённые встречи в
            капасити не попадают.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Поля, от которых зависит computeInsights — markRead письма их не трогает. */
function taskInsightKey(it: Item): string {
  return `${it.id}\0${it.updatedAt}\0${it.state ?? ''}\0${it.body}`
}

function eventInsightKey(it: Item): string {
  return `${it.id}\0${it.startsAt}\0${it.endsAt}\0${it.state ?? ''}\0${it.body}`
}

function sameInsightItems(prev: Item[], next: Item[], key: (it: Item) => string): boolean {
  if (prev.length !== next.length) return false
  const a = prev.map(key).sort()
  const b = next.map(key).sort()
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function TodayInsights({
  bare,
  variant = 'strip'
}: {
  /** Лежит в чужой рамке (виджет рабочего стола) — свою не рисуем. */
  bare?: boolean
  /**
   * `strip` — узкая строка цифр рядом с заголовком страницы «Мой день».
   * `card` — карточка виджета: большая цифра, пояснение и столбики по дням.
   */
  variant?: 'strip' | 'card'
} = {}): JSX.Element | null {
  const config = useStore((s) => s.config)
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<Item[]>([])
  const [events, setEvents] = useState<Item[]>([])

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      // itemsChanged общий (в т.ч. markRead mail) — без сравнения снимок
      // tasks/events каждый тик setState'ил карточку и дёргал стол.
      void window.kontur.items.query({ kinds: ['task'], limit: 500 }).then((list) => {
        if (cancelled) return
        setTasks((prev) => (sameInsightItems(prev, list, taskInsightKey) ? prev : list))
      })
      void window.kontur.items.query({ kinds: ['event'], limit: 2000 }).then((list) => {
        if (cancelled) return
        setEvents((prev) => (sameInsightItems(prev, list, eventInsightKey) ? prev : list))
      })
    }
    load()
    const off = window.kontur.items.onChange(load)
    return (): void => {
      cancelled = true
      off()
    }
  }, [])

  const spFieldHint = useMemo(() => {
    const jira = (config?.services ?? []).filter((s) => s.kind === 'jira' && s.enabled)
    if (!jira.length) return 'jira не подключена'
    const fields = jira.map((s) => s.options.storyPointsField?.trim()).filter(Boolean)
    if (fields.some((f) => f && f !== '__none__')) return 'field-ok'
    return 'field-pending'
  }, [config])

  const stats = useMemo(() => computeInsights(tasks, events), [tasks, events])

  if (!stats.hasTasks && !stats.hasEvents) return null

  const spHint = stats.hasSp
    ? 'по закрытым · 14д'
    : spFieldHint === 'field-ok'
      ? 'SP не проставлены'
      : 'после синка Jira'

  const loadPct =
    stats.todayBusy > 0 ? Math.min(100, Math.round((stats.todayBusy / (8 * HOUR)) * 100)) : 0

  /**
   * Карточка-виджет: одна главная цифра вместо четырёх равноправных.
   * Главная — та, на которую человек реагирует: сколько дня съели встречи.
   * Если встреч в системе нет вовсе, показывать там нечего — тогда главной
   * становится работа по задачам.
   */
  const card = stats.hasEvents
    ? {
        title: 'Капасити дня',
        value: loadPct,
        postfix: '%',
        description: (
          <>
            дня на митинги · {stats.todayMeetings}{' '}
            {plural(stats.todayMeetings, 'встреча', 'встречи', 'встреч')} сегодня
            {stats.todayMs > 0 ? ` · ${fmtHours(stats.todayMs)}` : ''}
          </>
        ),
        bars: barsFrom(stats.meetingsPerDay, stats.aheadLabels, 'встр.', stats.todayIndex),
        // Встречи — про направление («неделя забивается»), а не про сравнение
        // отдельных дней: линия это показывает, частокол столбиков — нет.
        chartKind: 'line' as const,
        footer: stats.hasTasks
          ? `${stats.openCount} в работе · ${stats.done14} закрыто за 14 дней`
          : null
      }
    : {
        title: 'Задачи',
        value: stats.openCount,
        postfix: '',
        description: <>в работе · {stats.done14} закрыто за 14 дней</>,
        bars: barsFrom(stats.closedPerDay, stats.dayLabels, 'закр.'),
        chartKind: 'bars' as const,
        footer: stats.hasSp ? `${fmtSp(stats.openSpSum)} SP в работе` : null
      }

  if (variant === 'card') {
    return (
      <>
        <StatsCard
          bare={bare}
          title={card.title}
          value={card.value}
          valuePostfix={card.postfix}
          description={card.description}
          chartData={card.bars}
          chartKind={card.chartKind}
          footer={card.footer}
          onActionClick={() => setOpen(true)}
        />
        <CapacityDialog
          open={open}
          onOpenChange={setOpen}
          stats={stats}
          spHint={spHint}
        />
      </>
    )
  }

  return (
    <>
      {/* Одна строка рядом с заголовком: четыре цифры, которые отвечают на
          «как загружен день», и тренд закрытий. Остальное — в модалке. */}
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5',
          !bare && 'desktop-glass rounded-xl border backdrop-blur-2xl'
        )}
      >
        <Metric
          value={String(stats.openCount)}
          label={stats.hasSp ? `в работе · ${fmtSp(stats.openSpSum)} SP` : 'в работе'}
        />
        <Divider />
        <Metric value={String(stats.done14)} label="закрыто за 14д" />
        <Divider />
        <Metric
          value={String(stats.todayMeetings)}
          label={`встреч сегодня · ${fmtHours(stats.todayMs)}`}
        />
        <Divider />
        <Metric
          value={`${loadPct}%`}
          label="дня на митинги"
          tone={loadPct >= 80 ? 'warn' : undefined}
        />
        {stats.hasEvents && (
          <>
            <Divider />
            <LineSpark values={stats.meetingsPerDay} labels={stats.aheadLabels} />
          </>
        )}
        {stats.hasTasks && (
          <>
            <Divider />
            <Spark values={stats.closedPerDay} />
          </>
        )}

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="desk-chip flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-[box-shadow,color] hover:text-foreground"
        >
          Подробнее
          <ChevronRight className="size-3" />
        </button>
      </div>

      <CapacityDialog open={open} onOpenChange={setOpen} stats={stats} spHint={spHint} />
    </>
  )
}
