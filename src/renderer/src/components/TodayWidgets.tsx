import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  AtSign,
  FileText,
  GitPullRequest,
  GripVertical,
  ListTodo,
  Mail,
  X,
  type LucideIcon
} from 'lucide-react'
import type { Item } from '@shared/types'
import { isTaskClosed } from '@shared/attention'
import { useStore } from '@/store'
import { TodayInsights } from './TodayInsights'
import { TodayMeetingsCarousel } from './TodayMeetingsCarousel'
import { TodosWidget } from './TodosWidget'
import { AssistantWidget } from './AssistantWidget'
import { AutomationsWidget } from './AutomationsWidget'
import { GlowingEffect } from '@/components/ui/glowing-effect'
import { AnimatedList } from '@/components/ui/animated-list'
import { WidgetHeader } from '@/components/ui/stats-card'
import { DOCK_CLEARANCE } from '@/lib/deskLayout'
import { toast } from '@/components/ui/toast'
import { WIDGET_IDS, WIDGET_TITLES, type WidgetId, type WidgetLayout } from '@shared/types'
import { cn } from '@/lib/utils'

/** Акцент иконки карточки внимания — по виду элемента. */
const KIND_COLOR: Record<string, string> = {
  task: '#f09a05',
  review: '#3b82f6',
  message: '#10b981',
  mail: '#f09a05',
  page: '#8b94a3'
}

const KIND_ICON: Record<string, LucideIcon> = {
  task: ListTodo,
  review: GitPullRequest,
  message: AtSign,
  mail: Mail,
  page: FileText
}

/** Короткое «сколько прошло» — без ветки на будущее: сюда будущие даты не попадают. */
function shortTime(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'сейчас'
  if (m < 60) return `${m} мин`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч`
  return `${Math.round(h / 24)} дн`
}

function todayLabel(): string {
  const s = new Date().toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Рамка-стекло: общий вид всех виджетов «Моего дня» на рабочем столе. */
function Glass({
  className,
  children,
  noBlur
}: {
  className?: string
  children: ReactNode
  /** Без backdrop-blur — когда поверх лежит окно (иначе Chromium ghost-рамки).
   *  Цвет/альфа всегда desktop-glass — без прыжка плотности. */
  noBlur?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'desktop-glass rounded-2xl border',
        !noBlur && 'backdrop-blur-2xl',
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * Подсвечивающаяся рамка у курсора (Aceternity Glowing Effect) вокруг виджета.
 * Виджеты стоят в вертикальный стек (друг под другом), высота — по контенту.
 *
 * Glow обязан быть выше Glass (z-10): иначе непрозрачный фон карточки
 * полностью перекрывает 1.5px border-маску эффекта. overflow-hidden тут
 * нельзя — ::after вылезает на ширину borderWidth наружу.
 *
 * Glow всегда включён: GlowingEffect сам гасит рамку, если курсор над
 * desk-window (elementFromPoint + hit-test по прямоугольникам). При открытых
 * окнах только снимаем backdrop-blur у стекла — альфа не меняется.
 */
function GlowCell({
  className,
  style,
  onDragHandle,
  onHide,
  title,
  widgetId,
  children
}: {
  className?: string
  style?: CSSProperties
  /** Нажали на «ручку» перетаскивания. */
  onDragHandle?: (e: ReactPointerEvent) => void
  onHide?: () => void
  title?: string
  /** Якорь для поиска карточки из обработчика перетаскивания. */
  widgetId?: string
  children: ReactNode
}): JSX.Element {
  const deskBusy = useStore((s) => s.windows.some((w) => !w.minimized))
  return (
    <div
      data-widget={widgetId}
      data-widget-card
      className={cn('group/widget relative rounded-2xl', className)}
      style={style}
    >
      {/* Ручка и крестик — поверх карточки и только при наведении: внутри
          виджетов живые списки и кнопки, тащить за них нельзя. */}
      {(onDragHandle || onHide) && (
        <div className="pointer-events-none absolute -top-2 right-2 z-20 flex gap-1 opacity-0 transition-opacity group-hover/widget:opacity-100">
          {onDragHandle && (
            <button
              type="button"
              aria-label={`Переместить «${title ?? 'виджет'}»`}
              onPointerDown={onDragHandle}
              className="desk-tile pointer-events-auto flex size-6 cursor-grab items-center justify-center rounded-full border bg-card text-muted-foreground active:cursor-grabbing hover:text-foreground"
            >
              <GripVertical className="size-3.5" />
            </button>
          )}
          {onHide && (
            <button
              type="button"
              aria-label={`Скрыть «${title ?? 'виджет'}»`}
              onClick={onHide}
              className="desk-tile pointer-events-auto flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {/* inactiveZone по умолчанию 0.7 — свечение гасло почти везде, кроме
          самого края карточки. Как в оригинальном демо — почти 0, чтобы
          реагировало по всей площади. */}
      <GlowingEffect
        className="z-10"
        disabled={false}
        glow
        proximity={64}
        spread={40}
        borderWidth={2}
        inactiveZone={0.01}
      />
      <Glass className="relative" noBlur={deskBusy}>
        {children}
      </Glass>
    </div>
  )
}

type AttentionKind = 'task' | 'mail' | 'note'

const KIND_LABEL: Record<AttentionKind, string> = {
  task: 'Задачи',
  mail: 'Почта',
  note: 'Упоминания'
}

/** message/page/review объединены в «Упоминания» — в отдельности их обычно по одному-два. */
function attentionKind(it: Item): AttentionKind | null {
  // Закрытые и отменённые задачи внимания не требуют — им здесь не место.
  if (it.kind === 'task') return isTaskClosed(it) ? null : 'task'
  if (it.kind === 'mail') return it.unread ? 'mail' : null
  // MM / MR / wiki: после markRead (unread+mentioned=0) пропадают из списка.
  if (it.kind === 'message' || it.kind === 'page' || it.kind === 'review') {
    return it.unread || it.mentioned ? 'note' : null
  }
  return null
}

/** Требует внимания: непрочитанные письма/упоминания и задачи, с фильтром по виду и прокруткой. */
function AttentionWidget({ bare, listHeight }: { bare?: boolean; listHeight?: number } = {}): JSX.Element {
  const { config, openItem } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [filter, setFilter] = useState<AttentionKind | null>(null)

  useEffect(() => {
    const load = (): void => {
      // Не один query(limit:500) по всему кэшу: свежие прочитанные задачи/события
      // вытесняли старые unread MM/почту из окна — виджет молча недобирал ленту.
      void Promise.all([
        window.kontur.items.query({ kinds: ['mail'], unreadOnly: true, limit: 1000 }),
        window.kontur.items.query({ kinds: ['task'], limit: 1000 }),
        window.kontur.items.query({ kinds: ['review'], limit: 500 }),
        window.kontur.items.query({ kinds: ['message', 'page'], unreadOnly: true, limit: 500 }),
        window.kontur.items.query({ kinds: ['message', 'page'], mentionedOnly: true, limit: 500 })
      ]).then((chunks) => {
        const byId = new Map<string, Item>()
        for (const list of chunks) for (const it of list) byId.set(it.id, it)
        setItems([...byId.values()])
      })
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  const all = useMemo(
    () =>
      items
        .map((it) => ({ it, kind: attentionKind(it) }))
        .filter((x): x is { it: Item; kind: AttentionKind } => x.kind != null)
        .sort((a, b) => b.it.updatedAt - a.it.updatedAt),
    [items]
  )

  const counts = useMemo(() => {
    const c: Record<AttentionKind, number> = { task: 0, mail: 0, note: 0 }
    for (const { kind } of all) c[kind]++
    return c
  }, [all])

  const shown = filter ? all.filter((x) => x.kind === filter) : all

  const Wrap = bare ? 'div' : Glass
  return (
    <Wrap className="w-full p-3">
      <WidgetHeader title="Требует внимания" count={all.length} />

      {!all.length ? (
        <p className="px-1 py-3 text-[13px] text-muted-foreground">Ничего не требует внимания</p>
      ) : (
        <>
          {/* Компактные фильтры — только те виды, которых реально есть хоть одна штука. */}
          <div className="mb-1.5 flex flex-wrap gap-1 px-1">
            <button
              type="button"
              onClick={() => setFilter(null)}
              className={cn(
                'desk-chip rounded-full px-2 py-0.5 text-[11px] transition-[box-shadow,color]',
                filter === null
                  ? 'desk-chip-on font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Все
            </button>
            {(Object.keys(KIND_LABEL) as AttentionKind[])
              .filter((k) => counts[k] > 0)
              .map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilter(filter === k ? null : k)}
                  className={cn(
                    'desk-chip rounded-full px-2 py-0.5 text-[11px] transition-[box-shadow,color]',
                    filter === k
                      ? 'desk-chip-on font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {KIND_LABEL[k]} {counts[k]}
                </button>
              ))}
          </div>

          {/* AnimatedList: spring при появлении/уходе; только вертикальный скролл. */}
          <div className="overflow-x-hidden overflow-y-auto pr-0.5" style={{ maxHeight: listHeight ?? 288 }}>
            <AnimatedList className="min-w-0 gap-1.5">
              {shown.map(({ it }) => {
                const Icon = KIND_ICON[it.kind] ?? FileText
                const accent = config?.envs.find((e) => e.id === it.envId)?.accent
                const serviceName = config?.services.find((s) => s.id === it.serviceId)?.name
                const tint = KIND_COLOR[it.kind] ?? '#64748b'
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => openItem(it)}
                    className={cn(
                      'relative flex w-full max-w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-xl px-2.5 py-2 text-left',
                      'transition-colors duration-200 ease-out',
                      'bg-foreground/[0.03] hover:bg-foreground/[0.06]',
                      'dark:bg-white/[0.04] dark:hover:bg-white/[0.07]',
                      'dark:[box-shadow:0_-12px_40px_-16px_#ffffff14_inset] dark:backdrop-blur-md',
                      'border border-transparent dark:border-white/10'
                    )}
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-xl text-white"
                      style={{ backgroundColor: tint }}
                    >
                      <Icon className="size-3.5" strokeWidth={2.25} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="min-w-0 truncate text-[13px] font-medium">{it.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {shortTime(it.updatedAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: accent }}
                        />
                        <span className="truncate">{serviceName ?? it.serviceId}</span>
                      </span>
                    </span>
                  </button>
                )
              })}
            </AnimatedList>
          </div>
        </>
      )}
    </Wrap>
  )
}

/** Зазор между карточками — один и тот же по X и по Y. */
const WIDGET_GAP = 12
/** Поле под свечение рамки (GlowingEffect рисует на 2px наружу карточки). */
const GLOW_PAD = 4
/** Шаг привязки при ручном перетаскивании (не влияет на авто-стек). */
const ROW = 12
/** Поля стола от края. */
const EDGE = 16

type Box = { x: number; y: number; w: number; h: number }

/**
 * Разложить виджеты по слотам.
 *
 * Зазор между карточками всегда `WIDGET_GAP` — и по горизонтали, и по вертикали.
 * Автоукладка пакует плотно (EDGE, затем сразу под предыдущим + gap), без
 * лишнего шага сетки. Ручной drag по-прежнему притягивает Y к ROW, а если
 * слот занят — ищет ближайшую «полку» под/над занятыми отрезками.
 *
 * Колонки — от правого края (как виджеты macOS).
 */
function placeWidgets(
  order: WidgetId[],
  heights: Record<string, number>,
  wanted: Record<string, { x: number | null; y: number | null }>,
  desk: { width: number; height: number },
  width: number
): Record<string, Box> {
  const colW = width + WIDGET_GAP
  const cols = Math.max(1, Math.floor((desk.width - EDGE * 2 + WIDGET_GAP) / colW))
  const bottom = Math.max(ROW, desk.height - DOCK_CLEARANCE - EDGE)
  /** col 0 — самая правая. */
  const xOf = (col: number): number => desk.width - EDGE - width - col * colW
  const colOf = (x: number): number =>
    Math.min(cols - 1, Math.max(0, Math.round((desk.width - EDGE - width - x) / colW)))

  // Занятые отрезки по колонкам: виджет во всю ширину колонки, значит
  // пересечение сводится к пересечению интервалов по Y.
  // `from`/`to` — края карточки (без GLOW_PAD): зазор считается visual-to-visual.
  const taken: { from: number; to: number }[][] = Array.from({ length: cols }, () => [])
  const free = (col: number, y: number, h: number): boolean => {
    if (y < EDGE || y + h > bottom) return false
    return taken[col]!.every((s) => y + h + WIDGET_GAP <= s.from || y >= s.to + WIDGET_GAP)
  }
  const occupy = (col: number, y: number, h: number): void => {
    taken[col]!.push({ from: y, to: y + h })
  }

  /** Кандидаты Y: желаемая точка + плотная упаковка под/над уже занятым. */
  const yCandidates = (col: number, preferY: number): number[] => {
    const snaps = new Set<number>()
    snaps.add(Math.max(EDGE, preferY))
    snaps.add(EDGE)
    for (const s of taken[col]!) {
      snaps.add(s.to + WIDGET_GAP)
      snaps.add(Math.max(EDGE, s.from - WIDGET_GAP))
    }
    return [...snaps].sort((a, b) => a - b)
  }

  /** Ближайший свободный слот: сначала своя колонка, потом соседние. */
  const findSlot = (col: number, preferY: number, h: number): { col: number; y: number } => {
    for (let dc = 0; dc < cols; dc++) {
      for (const c of dc === 0 ? [col] : [col + dc, col - dc]) {
        if (c < 0 || c >= cols) continue
        const ranked = yCandidates(c, preferY)
          .filter((y) => free(c, y, h))
          .sort((a, b) => Math.abs(a - preferY) - Math.abs(b - preferY) || a - b)
        if (ranked[0] != null) return { col: c, y: ranked[0] }
      }
    }
    return { col: 0, y: EDGE }
  }

  // Сначала то, что двигали руками: их пожелания важнее автоматических.
  const pinned = order.filter((id) => wanted[id]?.x != null)
  const auto = order.filter((id) => wanted[id]?.x == null)
  const out: Record<string, Box> = {}

  for (const id of [...pinned, ...auto]) {
    const h = heights[id] ?? 96
    const w = wanted[id]
    const col = w?.x != null ? colOf(w.x) : 0
    // Авто: preferY=EDGE → плотный стек сверху. Drag: притягиваем к ROW.
    const preferY =
      w?.y != null ? Math.max(EDGE, Math.round(w.y / ROW) * ROW) : EDGE
    const slot = findSlot(col, preferY, h)
    occupy(slot.col, slot.y, h)
    out[id] = { x: xOf(slot.col), y: slot.y, w: width, h }
  }
  return out
}

/**
 * «Мой день» на рабочем столе — не приложение, а виджеты, как на десктопе
 * macOS: всегда на виду, без своей иконки в доке и без возможности закрыть.
 * Лежат под обычными окнами (ниже в DOM ⇒ ниже по стеку), поэтому окно,
 * открытое поверх, перекрывает их как и положено.
 *
 * Раскладка — сетка слотов: колонка шириной с виджет, шаг по вертикали ROW.
 * Виджеты не наезжают друг на друга никогда: перетаскивание задаёт желаемый
 * слот, а `placeWidgets` подбирает ближайший свободный.
 */
export function TodayWidgets(): JSX.Element | null {
  const desk = useStore((s) => s.desktop)
  const widgets = useStore((s) => s.config?.widgets)
  const patchConfig = useStore((s) => s.patchConfig)
  const assistantDetached = useStore((s) =>
    s.windows.some(
      (w) => w.route.kind === 'page' && w.route.page === 'assistant' && !w.minimized
    )
  )
  const box = useRef<HTMLDivElement>(null)
  /** Высоты виджетов по id — от них зависит, что куда влезет. */
  const [heights, setHeights] = useState<Record<string, number>>({})
  const visibilityKey = WIDGET_IDS.map((id) => {
    const visible = widgets?.[id]?.visible !== false
    return `${id}:${visible && !(id === 'assistant' && assistantDetached) ? 1 : 0}`
  }).join('|')

  // Высота виджета — самой карточки (GlowCell), без GLOW_PAD-обёртки.
  // Иначе вертикальный зазор получается WIDGET_GAP + 2×GLOW_PAD, а горизонтальный
  // остаётся WIDGET_GAP — визуально «по вертикали шире».
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const next: Record<string, number> = {}
      for (const c of Array.from(el.children) as HTMLElement[]) {
        const id = c.dataset.widget
        if (!id) continue
        const card = c.querySelector<HTMLElement>('[data-widget-card]')
        next[id] = card?.offsetHeight ?? c.offsetHeight
      }
      setHeights((prev) => {
        const same =
          Object.keys(next).length === Object.keys(prev).length &&
          Object.entries(next).every(([k, v]) => prev[k] === v)
        return same ? prev : next
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    for (const c of Array.from(el.children)) {
      ro.observe(c)
      const card = (c as HTMLElement).querySelector('[data-widget-card]')
      if (card) ro.observe(card)
    }
    return () => ro.disconnect()
  }, [visibilityKey])
  /** Виджет, который тащат прямо сейчас: позиция живёт в state, не в конфиге. */
  const [drag, setDrag] = useState<{ id: WidgetId; x: number; y: number } | null>(null)

  if (desk.width < 460) return null

  const width = Math.round(Math.max(260, Math.min(360, desk.width * 0.34)))
  const maxHeight = Math.max(160, desk.height - DOCK_CLEARANCE - EDGE * 2)
  // Длинный список «Требует внимания» не должен сам по себе занимать колонку.
  const listHeight = Math.max(120, Math.min(288, Math.round(maxHeight * 0.45)))

  const layout = (id: WidgetId): WidgetLayout =>
    widgets?.[id] ?? { visible: true, x: null, y: null }

  const save = (id: WidgetId, patch: Partial<WidgetLayout>): void => {
    const base = widgets ?? (Object.fromEntries(
      WIDGET_IDS.map((w) => [w, { visible: true, x: null, y: null }])
    ) as Record<WidgetId, WidgetLayout>)
    void patchConfig({ widgets: { ...base, [id]: { ...layout(id), ...patch } } })
  }

  /**
   * Крестик убирает виджет со стола — но так, чтобы было понятно, куда он
   * делся и как вернуть: тост говорит это прямо и даёт кнопку отмены.
   */
  const hide = (id: WidgetId): void => {
    save(id, { visible: false })
    toast.message(`Виджет «${WIDGET_TITLES[id]}» убран со стола`, {
      description: 'Вернуть можно здесь или в Настройках → Общее → Виджеты рабочего стола.',
      duration: 8000,
      action: { label: 'Вернуть', onClick: () => save(id, { visible: true }) }
    })
  }

  // Ассистент существует либо карточкой на столе, либо отдельным окном —
  // заглушку-дубликат на его прежнем месте не оставляем.
  const visible = WIDGET_IDS.filter(
    (id) => layout(id).visible && !(id === 'assistant' && assistantDetached)
  )

  // Виджет под мышью идёт за курсором и в укладке не участвует: иначе он
  // прыгал бы по слотам во время перетаскивания, а соседи расступались под
  // позицию, которую пользователь ещё не выбрал.
  const laidOut = visible.filter((id) => id !== drag?.id)
  const wanted = Object.fromEntries(
    laidOut.map((id) => [id, { x: layout(id).x, y: layout(id).y }])
  )
  const boxes = placeWidgets(laidOut, heights, wanted, desk, width)
  if (drag) boxes[drag.id] = { x: drag.x, y: drag.y, w: width, h: heights[drag.id] ?? 96 }

  /** Тащим за ручку: позиция считается от угла рабочего стола. */
  const startDrag = (id: WidgetId) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const cell = (e.currentTarget as HTMLElement).closest('[data-widget]') as HTMLElement | null
    const root = cell?.closest('[data-desktop-root]') as HTMLElement | null
    if (!cell || !root) return
    const c = cell.getBoundingClientRect()
    const r = root.getBoundingClientRect()
    let x = c.x - r.x + GLOW_PAD
    let y = c.y - r.y + GLOW_PAD
    setDrag({ id, x, y })
    const move = (ev: PointerEvent): void => {
      x += ev.movementX
      y += ev.movementY
      setDrag({ id, x, y })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      // В конфиг кладём пожелание; окончательный слот всё равно подберёт
      // укладка — и при следующем запуске, и после смены размера стола.
      save(id, { x: Math.round(x), y: Math.round(y) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const content: Record<WidgetId, JSX.Element> = {
    day: (
      <div className="px-4 py-3">
        <h1 className="text-[20px] leading-tight font-semibold tracking-tight">Мой день</h1>
        <p className="text-[13px] text-muted-foreground">{todayLabel()}</p>
      </div>
    ),
    insights: <TodayInsights bare variant="card" />,
    meetings: <TodayMeetingsCarousel glass bare />,
    todos: <TodosWidget bare />,
    assistant: <AssistantWidget bare />,
    automations: <AutomationsWidget bare />,
    attention: <AttentionWidget bare listHeight={listHeight} />
  }

  return (
    <div ref={box} className="pointer-events-none absolute inset-0">
      {visible.map((id) => {
        const b = boxes[id]
        if (!b) return null
        const dragging = drag?.id === id
        return (
          <div
            key={id}
            data-widget={id}
            // Переезд между слотами без анимации: пока карточки плавно едут,
            // они проходят друг сквозь друга, а требование простое — виджеты
            // не наезжают никогда. Содержимое подгружается асинхронно, так что
            // такие перестроения случаются и сами по себе.
            className="absolute p-1"
            style={{
              left: b.x - GLOW_PAD,
              top: b.y - GLOW_PAD,
              width: width + GLOW_PAD * 2,
              zIndex: dragging ? 2 : 1
            }}
          >
            <GlowCell
              className="pointer-events-auto"
              style={{ width }}
              widgetId={id}
              title={WIDGET_TITLES[id]}
              onDragHandle={startDrag(id)}
              onHide={() => hide(id)}
            >
              {content[id]}
            </GlowCell>
          </div>
        )
      })}
    </div>
  )
}
