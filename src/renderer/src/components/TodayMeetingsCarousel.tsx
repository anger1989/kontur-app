import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Item } from '@shared/types'
import { countsAsMeeting, dedupeMeetings } from '@shared/attention'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import { EventDialog, timeLabel } from '@/components/EventDialog'
import { WidgetHeader } from '@/components/ui/stats-card'
import { cn } from '@/lib/utils'

const startOfDay = (ts: number): number => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function isPast(ev: Item, now: number): boolean {
  const end = ev.endsAt ?? ev.startsAt
  return end != null && end < now
}

function isLive(ev: Item, now: number): boolean {
  return (
    ev.startsAt != null &&
    ev.startsAt <= now &&
    (ev.endsAt == null || ev.endsAt >= now)
  )
}

/**
 * Горизонтальная карусель встреч на сегодня — сверху «Моего дня».
 * Скроллится к текущей/следующей; прошедшие — тусклые.
 *
 * `glass` — виджет прямо на рабочем столе (см. TodayWidgets): своя рамка
 * в стекле, а не просто отступ внутри страницы.
 */
export function TodayMeetingsCarousel({
  glass,
  bare
}: { glass?: boolean; bare?: boolean } = {}): JSX.Element | null {
  const { config } = useStore()
  const [events, setEvents] = useState<Item[]>([])
  const [selected, setSelected] = useState<Item | null>(null)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const scroller = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const userScrolled = useRef(false)
  const lastFocusId = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.kontur.items.query({ kinds: ['event'], limit: 2000 }).then((list) => {
        if (cancelled) return
        const day0 = startOfDay(Date.now())
        const day1 = day0 + 86_400_000
        // Отменённые, отклонённые и приглашения-дубли на сегодня уже не
        // влияют — в карусели дня они только сбивают: встреча отменена, а
        // карточка висит как живая. Копии из разных контуров склеиваем.
        const today = dedupeMeetings(
          list
            .filter(
              (it) =>
                it.startsAt != null &&
                countsAsMeeting(it) &&
                it.startsAt >= day0 &&
                it.startsAt < day1
            )
            .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0))
        )
        setEvents((prev) => {
          if (
            prev.length === today.length &&
            prev.every(
              (e, i) =>
                e.id === today[i]!.id &&
                e.startsAt === today[i]!.startsAt &&
                e.endsAt === today[i]!.endsAt &&
                e.state === today[i]!.state &&
                e.title === today[i]!.title
            )
          ) {
            return prev
          }
          return today
        })
      })
    }
    load()
    const off = window.kontur.items.onChange(load)
    return (): void => {
      cancelled = true
      off()
    }
  }, [])

  // Тикаем раз в минуту — смена «сейчас / прошло / далее» и автоскролл.
  useEffect(() => {
    const tick = (): void => setNow(Date.now())
    const id = window.setInterval(tick, 30_000)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const updateArrows = (): void => {
    const el = scroller.current
    if (!el) return
    setCanPrev(el.scrollLeft > 4)
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }

  useEffect(() => {
    updateArrows()
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      updateArrows()
      userScrolled.current = true
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(updateArrows)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [events])

  const focusId = useMemo(() => {
    const live = events.find((e) => isLive(e, now))
    if (live) return live.id
    const upcoming = events.find((e) => !isPast(e, now))
    return upcoming?.id ?? events[events.length - 1]?.id ?? null
  }, [events, now])

  // Сдвигаем карусель к текущей/следующей, когда фокус сменился или список подгрузился.
  useEffect(() => {
    if (!focusId) return
    const changed = lastFocusId.current !== focusId
    lastFocusId.current = focusId
    // Первый раз и при смене «сейчас» — всегда; иначе не перебиваем ручной скролл.
    if (!changed && userScrolled.current) return
    userScrolled.current = false
    const card = cardRefs.current.get(focusId)
    const sc = scroller.current
    if (!card || !sc) return
    // Небольшой defer — refs после paint.
    const t = window.setTimeout(() => {
      const left = card.offsetLeft - 8
      sc.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
      updateArrows()
    }, 40)
    return () => window.clearTimeout(t)
  }, [focusId, events])

  // Секцией на странице — нет встреч, нет и секции, там и так много всего.
  // Виджетом на столе — он постоянный, пропадать и появляться не должен.
  if (events.length === 0 && !glass) return null

  const scrollBy = (dir: -1 | 1): void => {
    const el = scroller.current
    if (!el) return
    userScrolled.current = true
    el.scrollBy({ left: dir * Math.min(320, el.clientWidth * 0.8), behavior: 'smooth' })
  }

  return (
    <section
      className={cn(
        glass && !bare && 'desktop-glass rounded-2xl border backdrop-blur-2xl',
        glass ? 'p-3' : 'mb-6'
      )}
    >
      {/* Стрелки появляются, только если список действительно не помещается. */}
      {glass ? (
        <WidgetHeader title="Встречи сегодня" count={events.length}>
          {(canPrev || canNext) && (
            <>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={!canPrev}
                onClick={() => scrollBy(-1)}
                aria-label="Назад"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={!canNext}
                onClick={() => scrollBy(1)}
                aria-label="Вперёд"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </>
          )}
        </WidgetHeader>
      ) : (
        <div className="mb-2 flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" />
          <h2 className="text-[13px] font-semibold tracking-tight">Сегодня · {events.length}</h2>
          {(canPrev || canNext) && (
            <div className="ml-auto flex items-center gap-0.5">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={!canPrev}
                onClick={() => scrollBy(-1)}
                aria-label="Назад"
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={!canNext}
                onClick={() => scrollBy(1)}
                aria-label="Вперёд"
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      )}

      {events.length === 0 ? (
        <p className="py-3 text-center text-[12px] text-muted-foreground">Сегодня встреч нет</p>
      ) : (
      <div
        ref={scroller}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {events.map((ev) => {
          const env = config?.envs.find((e) => e.id === ev.envId)
          const t0 = ev.startsAt != null ? timeLabel(ev.startsAt) : ''
          const t1 = ev.endsAt != null ? timeLabel(ev.endsAt) : ''
          const live = isLive(ev, now)
          const past = isPast(ev, now)
          const soon = ev.id === focusId && !live
          const durMs = ev.startsAt != null && ev.endsAt != null ? ev.endsAt - ev.startsAt : 0
          const duration =
            durMs > 0
              ? durMs >= 3_600_000
                ? `${(durMs / 3_600_000).toFixed(1).replace(/\.0$/, '')} ч`
                : `${Math.round(durMs / 60_000)} мин`
              : ''
          const loc = (ev.body.split('\n')[0] ?? '').trim()
          const locPreview = loc && !/^https?:\/\//i.test(loc) ? loc : ''

          return (
            <button
              key={ev.id}
              type="button"
              ref={(node) => {
                if (node) cardRefs.current.set(ev.id, node)
                else cardRefs.current.delete(ev.id)
              }}
              onClick={() => setSelected(ev)}
              style={{ borderLeftColor: past ? undefined : (env?.accent ?? undefined) }}
              className={cn(
                'flex w-[clamp(240px,24vw,330px)] min-h-[108px] shrink-0 snap-start flex-col gap-1.5',
                'rounded-xl border border-l-[3px] bg-card px-4 py-3 text-left',
                'transition-[opacity,background-color,border-color]',
                'hover:bg-accent/50',
                // Объём — только у актуальных карточек: прошедшие намеренно
                // «плоские и выцветшие», лепка тут только мешала бы.
                !past && 'desk-tile',
                live && 'border-primary/40 bg-primary/5',
                soon && !past && 'border-foreground/20',
                past && 'border-transparent bg-transparent opacity-45 hover:opacity-75'
              )}
            >
              <div className="flex items-baseline gap-1.5 tabular-nums">
                <span className={cn('text-[15px] font-semibold tracking-tight', past && 'text-muted-foreground')}>
                  {t0}
                </span>
                {t1 && <span className="text-[11px] text-muted-foreground">– {t1}</span>}
                {live && (
                  <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    сейчас
                  </span>
                )}
                {soon && !live && (
                  <span className="ml-auto rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                    далее
                  </span>
                )}
                {past && !live && (
                  <span className="ml-auto text-[10px] text-muted-foreground">прошло</span>
                )}
              </div>
              <div
                className={cn(
                  'line-clamp-2 text-[13.5px] leading-snug font-medium',
                  past && 'text-muted-foreground'
                )}
              >
                {ev.title}
              </div>

              <div className="mt-auto flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: env?.accent ?? 'var(--muted-foreground)' }}
                />
                {[duration, locPreview, env?.short].filter(Boolean).map((part, i) => (
                  <span key={i} className="flex items-center gap-1.5 truncate">
                    {i > 0 && <span className="opacity-50">·</span>}
                    <span className="truncate">{part}</span>
                  </span>
                ))}
              </div>
            </button>
          )
        })}
      </div>
      )}

      <EventDialog
        event={selected}
        envName={selected ? config?.envs.find((e) => e.id === selected.envId)?.name : undefined}
        envAccent={selected ? config?.envs.find((e) => e.id === selected.envId)?.accent : undefined}
        onClose={() => setSelected(null)}
        onUpdated={(it) => {
          setSelected(it)
          setEvents((prev) => prev.map((x) => (x.id === it.id ? it : x)))
        }}
      />
    </section>
  )
}
