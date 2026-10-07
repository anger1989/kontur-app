import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  AtSign,
  CalendarDays,
  FileText,
  GitPullRequest,
  ListTodo,
  Mail,
  Sun,
  type LucideIcon
} from 'lucide-react'
import type { Item } from '@shared/types'
import { countsAsMeeting, meetingSlotKey } from '@shared/attention'
import { useStore } from '@/store'
import { TodayMeetingsCarousel } from '@/components/TodayMeetingsCarousel'
import { TodayInsights } from '@/components/TodayInsights'
import { EventDialog } from '@/components/EventDialog'
import { cn } from '@/lib/utils'

/**
 * Виды элементов ленты: подпись, иконка и порядок секций.
 * Порядок — по убыванию «требует действия»: сначала то, что на мне.
 */
const KINDS: { kind: string; label: string; icon: LucideIcon }[] = [
  { kind: 'task', label: 'Задачи', icon: ListTodo },
  { kind: 'review', label: 'На ревью', icon: GitPullRequest },
  { kind: 'message', label: 'Упоминания', icon: AtSign },
  { kind: 'mail', label: 'Письма', icon: Mail },
  { kind: 'event', label: 'Ближайшие встречи', icon: CalendarDays },
  { kind: 'page', label: 'Страницы', icon: FileText }
]
const KIND_META = new Map(KINDS.map((k) => [k.kind, k]))

/** Сколько строк показываем в секции до «показать ещё». */
const SECTION_LIMIT = 6

/**
 * Короткое время: для прошлого — сколько прошло, для будущего — дата.
 *
 * Строка используется и для времени последнего изменения (всегда прошлое:
 * письма, задачи, упоминания), и для начала встречи (в этой ленте — всегда
 * будущее, сегодняшние уже разобраны в карусели сверху). Без ветки на
 * будущее отрицательная разница проваливалась в `m < 1` и встреча через
 * неделю показывалась как «сейчас».
 */
function shortTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) {
    return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
  }
  const m = Math.round(diff / 60000)
  if (m < 1) return 'сейчас'
  if (m < 60) return `${m} мин`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} дн` : new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}

/** «Четверг, 2 октября» — с заглавной. */
function todayLabel(): string {
  const s = new Date().toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function Today(): JSX.Element {
  const { config, openItem } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [kindFilter, setKindFilter] = useState<string | null>(null)
  const [envFilter, setEnvFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selectedEvent, setSelectedEvent] = useState<Item | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.kontur.items.query({ limit: 500 }).then((list) => {
        // Письма — только непрочитанные; сегодняшние встречи живут в карусели
        // сверху и в ленте не дублируются.
        const day0 = (() => {
          const d = new Date()
          d.setHours(0, 0, 0, 0)
          return d.getTime()
        })()
        const day1 = day0 + 86_400_000
        // Копии встреч из второго контура — одной строкой, как в счётчиках.
        const seenSlots = new Set<string>()
        setItems(
          list.filter((i) => {
            if (i.kind === 'mail') return i.unread
            if (i.kind === 'message' || i.kind === 'page' || i.kind === 'review') {
              return i.unread || i.mentioned
            }
            if (i.kind === 'event') {
              if (i.startsAt == null || !countsAsMeeting(i)) return false
              const slot = meetingSlotKey(i)
              if (seenSlots.has(slot)) return false
              seenSlots.add(slot)
              // Сегодняшние живут в карусели сверху.
              if (i.startsAt >= day0 && i.startsAt < day1) return false
              // Дальше недели не показываем: повторяющиеся встречи развёрнуты
              // до конца горизонта и иначе засыпают ленту экземплярами на
              // полгода вперёд.
              return i.startsAt >= day1 && i.startsAt < day0 + 8 * 86_400_000
            }
            return true
          })
        )
      })
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  const envs = (config?.envs ?? []).filter((e) => e.enabled)

  /** Отбор по контуру применяется до подсчёта видов, чтобы счётчики не врали. */
  const scoped = useMemo(
    () => (envFilter ? items.filter((i) => i.envId === envFilter) : items),
    [items, envFilter]
  )

  const byKind = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const it of scoped) {
      const arr = map.get(it.kind) ?? []
      arr.push(it)
      map.set(it.kind, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => b.updatedAt - a.updatedAt)
    return map
  }, [scoped])

  const visibleKinds = KINDS.filter(
    (k) => (byKind.get(k.kind)?.length ?? 0) > 0 && (!kindFilter || kindFilter === k.kind)
  )


  return (
    <div className="flex h-full min-h-0 flex-col px-4 pt-5 pb-4 sm:px-6 lg:px-8">
      {/* Шапка: дата слева, капасити дня — в той же строке, справа */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Мой день</h1>
          <span className="text-muted-foreground">{todayLabel()}</span>
        </div>
        <TodayInsights />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <TodayMeetingsCarousel />

        {scoped.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Sun className="size-6 text-muted-foreground" />
            <p className="font-medium text-muted-foreground">Пока пусто</p>
            <p className="max-w-md text-[13px] text-muted-foreground/80">
              Здесь появятся назначенные задачи, MR на вашем ревью, упоминания и письма — как только
              контуры будут подняты и сервисы синхронизируются. Подключение контуров — в настройках.
            </p>
          </div>
        ) : (
          <>
            {/* Фильтры: вид — основной способ выбора, контур — вторичный */}
            <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
              <Chip label="Всё" count={scoped.length} active={!kindFilter} onClick={() => setKindFilter(null)} />
              {KINDS.filter((k) => (byKind.get(k.kind)?.length ?? 0) > 0).map((k) => (
                <Chip
                  key={k.kind}
                  icon={k.icon}
                  label={k.label}
                  count={byKind.get(k.kind)!.length}
                  active={kindFilter === k.kind}
                  onClick={() => setKindFilter(kindFilter === k.kind ? null : k.kind)}
                />
              ))}

              {envs.length > 1 && (
                <>
                  <span className="mx-1 h-4 w-px bg-border" />
                  {envs.map((e) => (
                    <Chip
                      key={e.id}
                      label={e.short}
                      accent={e.accent}
                      active={envFilter === e.id}
                      onClick={() => setEnvFilter(envFilter === e.id ? null : e.id)}
                    />
                  ))}
                </>
              )}
            </div>

            {/* Лента секциями по видам — вместо плоского списка на 27 страниц */}
            {visibleKinds.map((k) => {
              const all = byKind.get(k.kind)!
              const open = expanded[k.kind]
              const shown = open ? all : all.slice(0, SECTION_LIMIT)
              return (
                <section key={k.kind} className="mb-5">
                  <div className="mb-1.5 flex items-center gap-2">
                    <k.icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                      {k.label}
                    </h2>
                    <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                      {all.length}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  <div className="space-y-px">
                    {shown.map((it) => (
                      <Row
                        key={it.id}
                        item={it}
                        icon={KIND_META.get(it.kind)?.icon ?? FileText}
                        serviceName={config?.services.find((s) => s.id === it.serviceId)?.name}
                        accent={config?.envs.find((e) => e.id === it.envId)?.accent}
                        onOpen={() => (it.kind === 'event' ? setSelectedEvent(it) : openItem(it))}
                      />
                    ))}
                  </div>

                  {all.length > SECTION_LIMIT && (
                    <button
                      type="button"
                      onClick={() => setExpanded((s) => ({ ...s, [k.kind]: !open }))}
                      className="mt-1 rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {open ? 'Свернуть' : `Показать ещё ${all.length - SECTION_LIMIT}`}
                    </button>
                  )}
                </section>
              )
            })}

          </>
        )}
      </div>

      <EventDialog
        event={selectedEvent}
        envName={selectedEvent ? config?.envs.find((e) => e.id === selectedEvent.envId)?.name : undefined}
        envAccent={selectedEvent ? config?.envs.find((e) => e.id === selectedEvent.envId)?.accent : undefined}
        onClose={() => setSelectedEvent(null)}
        onUpdated={(it) => setSelectedEvent(it)}
      />
    </div>
  )
}

/**
 * Строка ленты: слева иконка вида, в центре заголовок и источник,
 * справа время в своей колонке — так список читается по вертикали.
 */
function Row({
  item,
  icon: Icon,
  serviceName,
  accent,
  onOpen
}: {
  item: Item
  icon: LucideIcon
  serviceName?: string
  accent?: string
  onOpen: () => void
}): JSX.Element {
  const unread = item.unread || item.mentioned
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-background">
        <Icon className="size-3.5" />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn('block truncate text-[13px]', unread ? 'font-semibold' : 'font-medium')}
        >
          {item.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: accent }} />
          <span className="truncate">{serviceName ?? item.serviceId}</span>
          {item.state && (
            <>
              <span className="opacity-50">·</span>
              <span className="truncate">{item.state}</span>
            </>
          )}
          {item.author && (
            <>
              <span className="opacity-50">·</span>
              <span className="truncate">{item.author}</span>
            </>
          )}
        </span>
      </span>

      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {shortTime(item.startsAt ?? item.updatedAt)}
      </span>
    </button>
  )
}

function Chip({
  icon: Icon,
  label,
  count,
  accent,
  active,
  onClick
}: {
  icon?: LucideIcon
  label: string
  count?: number
  accent?: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active ? 'border-transparent bg-foreground text-background' : 'hover:bg-accent'
      )}
    >
      {accent && <span className="size-2 rounded-full" style={{ background: accent }} />}
      {Icon && <Icon className="size-3.5" />}
      <span>{label}</span>
      {count != null && (
        <span className={cn('tabular-nums', active ? 'opacity-70' : 'text-muted-foreground')}>
          {count}
        </span>
      )}
    </button>
  )
}
