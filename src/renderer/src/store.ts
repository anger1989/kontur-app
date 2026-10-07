import { create } from 'zustand'
import { toast } from '@/components/ui/toast'
import type {
  AppConfig,
  BrowserState,
  EnvStatus,
  Item,
  NavTarget,
  ServiceConfig,
  ThemePref
} from '@shared/types'
import { DOCK_CLEARANCE, fitRect, isOccludedByHigher, peekRects } from '@/lib/deskLayout'

export type AppPage =
  | 'today'
  | 'mail'
  | 'calendar'
  | 'tasks'
  | 'planner'
  | 'notes'
  | 'files'
  | 'bookmarks'
  | 'browser'
  | 'search'
  | 'settings'
  | 'terminal'

export type Route =
  | { kind: 'page'; page: AppPage; itemId?: string }
  | { kind: 'service'; serviceId: string; url?: string }

/**
 * Плавающее окно рабочего стола.
 *
 * Сервисы — нативный `WebContentsView` (см. ServiceHost). Несколько сервисных
 * окон живые, пока не пересекаются с окном выше по z (иначе нативный слой
 * рисуется поверх чужого titlebar). Окна страниц между собой — обычный DOM.
 */
export interface DeskWindow {
  id: string
  route: Route
  x: number
  y: number
  width: number
  height: number
  z: number
  minimized: boolean
  maximized: boolean
  /** Геометрия до разворота — чтобы было куда вернуться. */
  restoreRect?: { x: number; y: number; width: number; height: number }
  /** Только что сняли minimize — анимация появления из дока. */
  fromDock?: boolean
}

export const PAGE_TITLES: Record<AppPage, string> = {
  today: 'Мой день',
  mail: 'Почта',
  calendar: 'Календарь',
  tasks: 'Задачи',
  planner: 'Планировщик',
  search: 'Поиск',
  notes: 'Заметки',
  files: 'Файлы',
  bookmarks: 'Закладки',
  browser: 'Браузер',
  settings: 'Настройки',
  terminal: 'Терминал'
}

interface State {
  config: AppConfig | null
  statuses: EnvStatus[]
  resolvedTheme: 'light' | 'dark'
  ready: boolean

  /** Открытые окна рабочего стола. */
  windows: DeskWindow[]
  /** Счётчик для каскадного смещения новых окон и для z-order. */
  windowSeq: number
  /** Вебвью (сервис или вкладка браузера), который сейчас реально показан. */
  activeServiceId: string | null
  /**
   * Вкладки встроенного браузера. Источник правды — main (там живут их
   * WebContentsView), здесь копия для отрисовки хрома и для того, чтобы
   * понимать, какой нативный слой держит окно браузера.
   */
  browser: BrowserState
  /** Окна уведены с стола (плитка Exposé или peek «показать стол»). */
  arranged: boolean
  /** Текущий размер рабочего стола — от него считаются виджеты и док. */
  desktop: { width: number; height: number }

  load: () => Promise<void>
  /**
   * Стол изменил размер (окно приложения растянули или сжали): запомнить и
   * вписать окна в новые границы.
   */
  setDesktopSize: (size: { width: number; height: number }) => void
  /**
   * Разложить открытые окна плиткой без пересечений, либо — если уже
   * уведены — вернуть всё как было. Один уровень отмены.
   */
  arrangeWindows: (desktopSize: { width: number; height: number }) => void
  /**
   * Как «Показать рабочий стол» в macOS: окна уезжают к краям (peek),
   * повторный вызов возвращает снимок.
   */
  peekDesktop: (desktopSize: { width: number; height: number }) => void
  /** Открыть раздел/сервис окном. Если такое окно уже есть — просто поднять его. */
  openWindow: (route: Route) => void
  closeWindow: (id: string) => void
  /** Поднять окно наверх (и снять минимизацию, если была). */
  focusWindow: (id: string) => void
  minimizeWindow: (id: string) => void
  toggleMaximize: (id: string, bounds: { width: number; height: number }) => void
  clearFromDock: (id: string) => void
  updateWindowRect: (id: string, rect: Partial<Pick<DeskWindow, 'x' | 'y' | 'width' | 'height'>>) => void
  /** Окно отработало переход к itemId (проскроллило/открыло модалку) — снять deep-link, чтобы не повторялся. */
  clearWindowItem: (id: string) => void
  /** Клик по элементу / уведомлению — всегда внутри приложения. */
  openItem: (item: Item) => void
  applyNav: (target: NavTarget) => void
  /** Состояние браузера приехало из main. */
  setBrowserState: (state: BrowserState) => void
  setTheme: (pref: ThemePref) => Promise<void>
  saveService: (s: ServiceConfig) => Promise<void>
  reorderServices: (envId: string, orderedIds: string[]) => Promise<void>
  patchConfig: (p: Partial<AppConfig>) => Promise<void>
  refreshStatuses: () => Promise<void>
}

function canEmbed(service: ServiceConfig | undefined): service is ServiceConfig {
  return Boolean(
    service && (service.mode === 'embed' || service.mode === 'both') && service.baseUrl
  )
}

/** Маршрут для элемента: письма/встречи — свои экраны, остальное — вебвью сервиса. */
export function routeForItem(item: Item, config: AppConfig | null): Route {
  const service = config?.services.find((s) => s.id === item.serviceId)

  if (item.kind === 'mail') return { kind: 'page', page: 'mail', itemId: item.id }
  if (item.kind === 'event') return { kind: 'page', page: 'calendar', itemId: item.id }
  if (item.kind === 'todo') return { kind: 'page', page: 'planner', itemId: item.id }

  if (canEmbed(service)) {
    if (
      item.kind === 'message' ||
      item.kind === 'task' ||
      item.kind === 'review' ||
      item.kind === 'page'
    ) {
      return { kind: 'service', serviceId: service.id, url: item.url || undefined }
    }
  }

  if (item.kind === 'task' || item.kind === 'review') {
    return { kind: 'page', page: 'tasks', itemId: item.id }
  }
  return { kind: 'page', page: 'today', itemId: item.id }
}

const PAGES = new Set<AppPage>([
  'today',
  'mail',
  'calendar',
  'tasks',
  'planner',
  'notes',
  'files',
  'bookmarks',
  'browser',
  'search',
  'settings',
  'terminal'
])

/**
 * Живой сервис контура нельзя открыть, пока health-check не подтвердил сеть.
 * Письма/календарь из кэша — можно; VPN мог быть поднят и вне приложения.
 */
function assertEnvUp(envId: string, state: Pick<State, 'config' | 'statuses'>): boolean {
  const env = state.config?.envs.find((e) => e.id === envId)
  // Общие сервисы (Mattermost, Толк…) не зависят от VPN-контура.
  if (!env || env.id === 'shared' || env.vpn.kind === 'none') {
    if (!env?.healthCheckUrl) return true
  }
  const st = state.statuses.find((s) => s.envId === envId)
  const tunnel = st?.tunnel ?? 'unknown'
  // Блокируем только явный down. checking/unknown — не мешаем.
  if (tunnel !== 'down') return true

  const name = env?.name ?? envId
  toast.error(`Контур «${name}» не поднят`, {
    description:
      st?.lastError ??
      'VPN недоступен или проверка адреса не проходит. Подключите туннель (в приложении или в клиенте VPN) и дождитесь статуса «онлайн» в шапке.',
    duration: 8000
  })
  return false
}

/** Одно окно на раздел/сервис — открыли письмо из другого сервиса, а не плодим дубль. */
function routeKey(r: Route): string {
  return r.kind === 'page' ? `page:${r.page}` : `service:${r.serviceId}`
}

/** Заголовок окна в его собственной шапке. */
export function windowTitle(r: Route, config: AppConfig | null): string {
  if (r.kind === 'page') return PAGE_TITLES[r.page]
  const svc = config?.services.find((s) => s.id === r.serviceId)
  return svc?.name ?? 'Сервис'
}

/** Каскад новых окон: сдвиг по диагонали, с переносом, чтобы не уезжать за экран. */
function cascadePosition(seq: number): { x: number; y: number } {
  const step = seq % 8
  return { x: 70 + step * 28, y: 50 + step * 24 }
}

const DEFAULT_WIN_SIZE = { width: 880, height: 620 }

/** Снимок геометрии перед раскладкой плиткой — чтобы было куда вернуться. */
interface ArrangeSnapshot {
  id: string
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}
/** Не в сторе: это техническое состояние одной кнопки, реактивность ему не нужна. */
let arrangeSnapshot: ArrangeSnapshot[] | null = null

/** Сессия окон рабочего стола — переживает перезапуск приложения. */
const SESSION_WINDOWS_KEY = 'kontur.desk.windows.v1'

interface SavedWindow {
  route: Route
  x: number
  y: number
  width: number
  height: number
  z: number
  minimized: boolean
  maximized: boolean
  restoreRect?: { x: number; y: number; width: number; height: number }
}

/** Без itemId: иначе при старте снова всплывут модалки писем/встреч. */
function stripDeepLink(route: Route): Route {
  if (route.kind === 'page' && route.itemId) {
    return { kind: 'page', page: route.page }
  }
  return route
}

function readSavedWindows(): SavedWindow[] {
  try {
    const raw = localStorage.getItem(SESSION_WINDOWS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as SavedWindow[]) : []
  } catch {
    return []
  }
}

function persistWindows(state: State): void {
  // Во время Exposé / «показать стол» геометрия временная — пишем снимок.
  const snap = arrangeSnapshot
  const payload: SavedWindow[] = state.windows.map((w) => {
    const s = state.arranged ? snap?.find((x) => x.id === w.id) : undefined
    return {
      route: stripDeepLink(w.route),
      x: s?.x ?? w.x,
      y: s?.y ?? w.y,
      width: s?.width ?? w.width,
      height: s?.height ?? w.height,
      z: w.z,
      minimized: w.minimized,
      maximized: s?.maximized ?? w.maximized,
      restoreRect: w.restoreRect
    }
  })
  try {
    localStorage.setItem(SESSION_WINDOWS_KEY, JSON.stringify(payload))
  } catch {
    /* quota / private mode */
  }
}

function sanitizeRoute(route: Route, config: AppConfig | null): Route | null {
  if (route.kind === 'page') {
    if (!PAGES.has(route.page)) return null
    return stripDeepLink(route)
  }
  const svc = config?.services.find((s) => s.id === route.serviceId)
  if (!svc || !svc.enabled) return null
  // Только embed/both живут в окне; launcher/api — без вебвью.
  if (svc.mode !== 'embed' && svc.mode !== 'both') return null
  return {
    kind: 'service',
    serviceId: route.serviceId,
    ...(route.url ? { url: route.url } : {})
  }
}

function restoreSessionWindows(
  set: (partial: Partial<State>) => void,
  get: () => State
): void {
  const saved = readSavedWindows()
  if (!saved.length) return
  const config = get().config
  const desk = get().desktop
  const windows: DeskWindow[] = []
  let maxZ = 0

  for (const s of saved) {
    const route = sanitizeRoute(s.route, config)
    if (!route) continue
    if (windows.some((w) => routeKey(w.route) === routeKey(route))) continue

    const base = fitRect(
      {
        x: Number.isFinite(s.x) ? s.x : 70,
        y: Number.isFinite(s.y) ? s.y : 50,
        width: Number.isFinite(s.width) ? s.width : DEFAULT_WIN_SIZE.width,
        height: Number.isFinite(s.height) ? s.height : DEFAULT_WIN_SIZE.height
      },
      desk
    )
    const maximized = Boolean(s.maximized)
    const z = Number.isFinite(s.z) ? s.z : windows.length + 1
    windows.push({
      id: `${routeKey(route)}:restored`,
      route,
      x: maximized ? 0 : base.x,
      y: maximized ? 0 : base.y,
      width: maximized ? desk.width : base.width,
      height: maximized ? desk.height : base.height,
      z,
      minimized: Boolean(s.minimized),
      maximized,
      restoreRect: s.restoreRect ? fitRect(s.restoreRect, desk) : undefined
    })
    maxZ = Math.max(maxZ, z)
  }

  if (!windows.length) return
  set({ windows, windowSeq: Math.max(get().windowSeq, maxZ) })
  reconcileActiveService(get)
}

/** Сетка без пересечений: столбцов ≈ √N. Ячейки сжимаются, чтобы всё влезло (Mission Control). */
function tileRects(
  n: number,
  desktop: { width: number; height: number }
): { x: number; y: number; width: number; height: number }[] {
  const margin = 20
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))
  const usableHeight = Math.max(160, desktop.height - DOCK_CLEARANCE)
  const cellW = Math.max(200, (desktop.width - margin * (cols + 1)) / cols)
  const cellH = Math.max(140, (usableHeight - margin * (rows + 1)) / rows)
  return Array.from({ length: n }, (_, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      x: margin + col * (cellW + margin),
      y: margin + row * (cellH + margin),
      width: cellW,
      height: cellH
    }
  })
}

/** Вернуть геометрию из снимка перед Exposé. */
function restoreFromArrange(
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): boolean {
  if (!arrangeSnapshot) return false
  const snap = arrangeSnapshot
  arrangeSnapshot = null
  set({
    windows: get().windows.map((w) => {
      const s = snap.find((x) => x.id === w.id)
      return s ? { ...w, x: s.x, y: s.y, width: s.width, height: s.height, maximized: s.maximized } : w
    }),
    arranged: false
  })
  return true
}

/**
 * Какой нативный `WebContentsView` держит это окно.
 *
 * Вебвью бывает не только у сервиса: окно браузера показывает свою активную
 * вкладку. Для всей механики ниже (показ, freeze под чужим окном, возврат
 * после попапа) разницы между ними нет — важен только id слоя.
 */
export function nativeViewId(route: Route, browser: BrowserState): string | null {
  if (route.kind === 'service') return route.serviceId
  if (route.kind === 'page' && route.page === 'browser') return browser.activeId
  return null
}

/** Окна с живым WebContentsView (не перекрыты окном выше по z). */
function liveViewIds(get: () => State): string[] {
  const open = get().windows.filter((w) => !w.minimized)
  const browser = get().browser
  return open
    .filter((w) => !isOccludedByHigher(w, open))
    .sort((a, b) => a.z - b.z)
    .map((w) => nativeViewId(w.route, browser))
    .filter((id): id is string => id != null)
}

/** Сколько попапов/модалок сейчас открыто поверх стола (см. notifyPopoverOpenChange). */
let popoverDepth = 0
/** reconcile на следующий кадр — при драге DOM поверх вебвью прячем view без лагов React. */
let reconcileRaf = 0

function scheduleReconcile(get: () => State): void {
  if (reconcileRaf) return
  reconcileRaf = requestAnimationFrame(() => {
    reconcileRaf = 0
    reconcileActiveService(get)
  })
}

/** Есть ли сейчас поверх стола Dialog/Select/Popover (вебвью должны быть спрятаны). */
export function isPopoverOpen(): boolean {
  return popoverDepth > 0
}

/**
 * Поднять top-сервис / восстановить visible set. Не трогаем сервисы, которые
 * рядом с верхним React-окном и не пересекаются с ним — они остаются живыми.
 *
 * `route.url` у сервисного окна — одноразовый запрос перехода («открой вот эту
 * встречу/задачу»), а не адрес, к которому окно надо возвращать. Отдаём его в
 * main один раз и стираем: иначе каждый фокус окна (любой клик, каждое начало
 * перетаскивания) снова слал исходную ссылку, main видел, что вкладка уже на
 * другой странице (перешли по ссылке, назад, редирект встречи Толка), и
 * перезагружал её — вебвью «переоткрывался» при каждом драге.
 */
function reconcileActiveService(get: () => State): void {
  const top = [...get().windows]
    .filter((w) => !w.minimized)
    .sort((a, b) => b.z - a.z)[0]
  const nextViewId = top ? nativeViewId(top.route, get().browser) : null

  if (nextViewId !== get().activeServiceId) {
    useStore.setState({ activeServiceId: nextViewId })
  }

  // Пока открыта модалка/селект, нативные слои обязаны быть спрятаны — иначе они
  // рисуются поверх неё. Переход (route.url) не теряем: он применится, когда
  // попап закроется и notifyPopoverOpenChange вызовет reconcile снова.
  if (popoverDepth > 0) return

  const live = liveViewIds(get)
  const liveSet = new Set(live)
  // Перекрытые — freeze сразу (кадр+hide на main). Хост подхватит тот же кадр.
  for (const w of get().windows) {
    if (w.minimized) continue
    const id = nativeViewId(w.route, get().browser)
    if (id && !liveSet.has(id)) void window.kontur.view.freeze(id)
  }

  if (nextViewId) {
    // Одноразовый переход бывает только у сервисного окна (см. комментарий выше).
    const url = top!.route.kind === 'service' ? top!.route.url : undefined
    // Остальные живые — назад (после попапа они спрятаны), верхний — последним, поверх.
    const others = live.filter((id) => id !== nextViewId)
    if (others.length) void window.kontur.view.restore(others)
    void window.kontur.view.show(nextViewId, url)
    if (url) {
      useStore.setState({
        windows: get().windows.map((w) =>
          w.id === top!.id ? { ...w, route: { kind: 'service', serviceId: nextViewId } } : w
        )
      })
    }
  } else if (live.length > 0) {
    void window.kontur.view.restore(live)
  }
}

/**
 * Показать вебвью конкретного сервиса — для ServiceHost/Window. Пока поверх
 * открыт попап, не показываем: reconcile вернёт его сам после закрытия.
 */
export function showServiceView(serviceId: string): void {
  if (popoverDepth > 0) return
  void window.kontur.view.show(serviceId)
}

/**
 * Select/Dialog/Popover открываются порталом в document.body — это должно
 * быть поверх всего. Но нативный WebContentsView всегда рисует НАД любым DOM.
 * Прячем все вебвью на время попапа, потом возвращаем в z-порядке.
 *
 * Вызовы обязаны быть парными: Dialog считает себя по монтированию контента
 * (ui/dialog.tsx), а не по onOpenChange — тот не срабатывает, когда модалку
 * закрывает сам код (`open={false}`), и счётчик навсегда застревал > 0.
 */
export function notifyPopoverOpenChange(open: boolean): void {
  if (open) {
    popoverDepth += 1
    if (popoverDepth === 1) void window.kontur.view.hide()
    return
  }
  // StrictMode в dev: effect → cleanup → effect снова в одном тике.
  // Синхронный −1 довёл бы depth до 0 и reconcile показал бы вебвью поверх
  // ещё не успевшей смонтироваться модалки. Откладываем −1: remount успеет +1.
  queueMicrotask(() => {
    popoverDepth = Math.max(0, popoverDepth - 1)
    if (popoverDepth === 0) reconcileActiveService(() => useStore.getState())
  })
}

export const useStore = create<State>((set, get) => ({
  config: null,
  statuses: [],
  resolvedTheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  ready: false,
  windows: [],
  windowSeq: 0,
  activeServiceId: null,
  browser: { tabs: [], activeId: null },
  arranged: false,
  desktop: { width: 1024, height: 700 },

  setDesktopSize: (size) => {
    const width = Math.round(size.width)
    const height = Math.round(size.height)
    // Первый кадр и свёрнутое окно приложения дают 0×0. Принять такой размер —
    // значит схлопнуть все окна до минимума, а обратно они уже не вырастут.
    if (width < 2 || height < 2) return
    const prev = get().desktop
    if (prev.width === width && prev.height === height) return
    // Пока окна уведены (Exposé / «показать стол»), их геометрия — временная:
    // тронуть её сейчас значит потерять снимок, к которому мы возвращаемся.
    if (get().arranged) {
      set({ desktop: { width, height } })
      return
    }

    let moved = false
    const windows = get().windows.map((w) => {
      if (w.minimized) return w
      if (w.maximized) {
        if (w.x === 0 && w.y === 0 && w.width === width && w.height === height) return w
        moved = true
        return { ...w, x: 0, y: 0, width, height }
      }
      const fit = fitRect(w, { width, height })
      if (fit.x === w.x && fit.y === w.y && fit.width === w.width && fit.height === w.height) {
        return w
      }
      moved = true
      // restoreRect тоже вписываем: иначе выход из maximize вернёт окно за край.
      const restoreRect = w.restoreRect ? fitRect(w.restoreRect, { width, height }) : undefined
      return { ...w, ...fit, restoreRect }
    })

    set({ desktop: { width, height }, ...(moved ? { windows } : {}) })
    if (moved) reconcileActiveService(get)
  },

  arrangeWindows: (desktopSize) => {
    if (restoreFromArrange(set, get)) return

    const open = get().windows.filter((w) => !w.minimized)
    if (!open.length) return

    arrangeSnapshot = open.map((w) => ({
      id: w.id,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      maximized: w.maximized
    }))
    // Стабильный порядок по z — как в Mission Control: нижние слева, верхние справа.
    const ordered = [...open].sort((a, b) => a.z - b.z)
    const rects = tileRects(ordered.length, desktopSize)
    set({
      windows: get().windows.map((w) => {
        const i = ordered.findIndex((o) => o.id === w.id)
        if (i < 0) return w
        return { ...w, ...rects[i], maximized: false }
      }),
      arranged: true
    })
  },

  peekDesktop: (desktopSize) => {
    if (restoreFromArrange(set, get)) return

    const open = get().windows.filter((w) => !w.minimized)
    if (!open.length) return

    arrangeSnapshot = open.map((w) => ({
      id: w.id,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      maximized: w.maximized
    }))
    const ordered = [...open].sort((a, b) => a.z - b.z)
    const rects = peekRects(
      ordered.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      desktopSize
    )
    set({
      windows: get().windows.map((w) => {
        const i = ordered.findIndex((o) => o.id === w.id)
        if (i < 0) return w
        const r = rects[i]!
        return { ...w, x: r.x, y: r.y, width: r.width, height: r.height, maximized: false }
      }),
      arranged: true
    })
  },

  load: async () => {
    const firstBoot = !get().ready
    const [config, statuses, browser] = await Promise.all([
      window.kontur.config.get(),
      window.kontur.env.status(),
      // Вкладки живут в main и переживают перезагрузку рендерера (HMR в dev,
      // возврат из блокировки) — забираем их готовый список, а не заводим заново.
      window.kontur.browser.state()
    ])
    const resolvedTheme =
      config.theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : config.theme
    set({ config, statuses, browser, resolvedTheme, ready: true })
    // Рабочий стол не пустует даже без открытых окон — «Мой день» лежит там виджетами (TodayWidgets).
    // Окна прошлой сессии — только при первом load; config.onChange не должен сбрасывать стол.
    if (firstBoot) restoreSessionWindows(set, get)
  },

  openWindow: (route) => {
    // Новое окно / поднятие из дока — сначала выходим из Exposé, иначе снимок ломается.
    restoreFromArrange(set, get)

    if (route.kind === 'service') {
      const service = get().config?.services.find((s) => s.id === route.serviceId)
      if (service?.mode === 'launcher') {
        const appPath = service.options.appPath?.trim()
        if (!appPath) {
          toast.error(`Укажите путь к приложению в настройках «${service.name}»`)
          return
        }
        void window.kontur.app.openApp(appPath).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error(`Не удалось открыть ${service.name}: ${msg || appPath}`)
        })
        return
      }
      // Вебвью сервиса требует живой сети контура — иначе белый экран/таймаут.
      if (service && !assertEnvUp(service.envId, get())) return
    }

    const key = routeKey(route)
    const existing = get().windows.find((w) => routeKey(w.route) === key)
    const z = get().windowSeq + 1

    if (existing) {
      const fromDock = existing.minimized
      set({
        windows: get().windows.map((w) =>
          w.id === existing.id
            ? { ...w, route, minimized: false, z, fromDock: fromDock || undefined }
            : w
        ),
        windowSeq: z
      })
    } else {
      const pos = cascadePosition(get().windows.length)
      const win: DeskWindow = {
        id: `${key}:${Date.now()}`,
        route,
        ...pos,
        ...DEFAULT_WIN_SIZE,
        z,
        minimized: false,
        maximized: false
      }
      set({ windows: [...get().windows, win], windowSeq: z })
    }
    reconcileActiveService(get)
  },

  closeWindow: (id) => {
    // Если закрыли последнее окно в Exposé — сбрасываем снимок.
    const left = get().windows.filter((w) => w.id !== id && !w.minimized)
    if (arrangeSnapshot && left.length === 0) {
      arrangeSnapshot = null
      set({ windows: get().windows.filter((w) => w.id !== id), arranged: false })
    } else {
      set({ windows: get().windows.filter((w) => w.id !== id) })
    }
    reconcileActiveService(get)
  },

  focusWindow: (id) => {
    // Клик по окну в Exposé — выбрать его и вернуть всех на места.
    restoreFromArrange(set, get)
    const z = get().windowSeq + 1
    const prev = get().windows.find((w) => w.id === id)
    const fromDock = Boolean(prev?.minimized)
    set({
      windows: get().windows.map((w) =>
        w.id === id ? { ...w, z, minimized: false, fromDock: fromDock || w.fromDock } : w
      ),
      windowSeq: z
    })
    reconcileActiveService(get)
  },

  minimizeWindow: (id) => {
    restoreFromArrange(set, get)
    set({
      windows: get().windows.map((w) =>
        w.id === id ? { ...w, minimized: true, fromDock: undefined } : w
      )
    })
    reconcileActiveService(get)
  },

  clearFromDock: (id) => {
    set({
      windows: get().windows.map((w) =>
        w.id === id && w.fromDock ? { ...w, fromDock: undefined } : w
      )
    })
  },

  toggleMaximize: (id, desktopSize) => {
    restoreFromArrange(set, get)
    set({
      windows: get().windows.map((w) => {
        if (w.id !== id) return w
        if (w.maximized) {
          const r = w.restoreRect ?? { x: w.x, y: w.y, width: w.width, height: w.height }
          return { ...w, ...r, maximized: false, restoreRect: undefined }
        }
        return {
          ...w,
          maximized: true,
          restoreRect: { x: w.x, y: w.y, width: w.width, height: w.height },
          x: 0,
          y: 0,
          width: desktopSize.width,
          height: desktopSize.height
        }
      })
    })
  },

  updateWindowRect: (id, rect) => {
    const windows = get().windows
    const i = windows.findIndex((w) => w.id === id)
    if (i < 0) return
    const prev = windows[i]!
    const next = { ...prev, ...rect }
    if (
      next.x === prev.x &&
      next.y === prev.y &&
      next.width === prev.width &&
      next.height === prev.height
    ) {
      return
    }
    // Меняем только одну ссылку — остальные окна не ре-рендерятся по селектору.
    const copy = windows.slice()
    copy[i] = next
    set({ windows: copy })
    // DOM-окно поверх вебвью: WebContentsView всегда выше любого DOM —
    // прячем перекрытые view на этом же кадре, не ждя React/capturePage.
    scheduleReconcile(get)
  },

  clearWindowItem: (id) => {
    set({
      windows: get().windows.map((w) =>
        w.id === id && w.route.kind === 'page' ? { ...w, route: { kind: 'page', page: w.route.page } } : w
      )
    })
  },

  openItem: (item) => {
    const route = routeForItem(item, get().config)
    // Письма/календарь/задачи из кэша можно смотреть офлайн; живой сервис — нет.
    if (route.kind === 'service' && !assertEnvUp(item.envId, get())) return
    if (item.unread || item.mentioned) {
      void window.kontur.items.markRead(item.id)
    }
    get().openWindow(route)
  },

  setBrowserState: (state) => {
    const prev = get().browser
    set({ browser: state })
    // Активная вкладка сменилась — нативный слой окна браузера теперь другой,
    // и порядок показа/freeze надо пересчитать (main сам переключает только
    // видимость, но не знает про окна рабочего стола).
    if (prev.activeId !== state.activeId) reconcileActiveService(get)
  },

  applyNav: (target) => {
    if (target.kind === 'service') {
      const service = get().config?.services.find((s) => s.id === target.serviceId)
      if (service && !assertEnvUp(service.envId, get())) return
      get().openWindow({ kind: 'service', serviceId: target.serviceId, url: target.url })
      return
    }
    const page = (PAGES.has(target.page as AppPage) ? target.page : 'today') as AppPage
    get().openWindow({ kind: 'page', page, itemId: target.itemId })
  },

  setTheme: async (pref) => {
    const resolved = await window.kontur.theme.set(pref)
    const config = get().config
    set({ resolvedTheme: resolved, config: config ? { ...config, theme: pref } : config })
  },

  saveService: async (service) => {
    const config = await window.kontur.config.upsertService(service)
    set({ config })
  },

  reorderServices: async (envId, orderedIds) => {
    const config = await window.kontur.config.reorderServices(envId, orderedIds)
    set({ config })
  },

  patchConfig: async (patch) => {
    const config = await window.kontur.config.patch(patch)
    set({ config })
  },

  refreshStatuses: async () => {
    set({ statuses: await window.kontur.env.status() })
  }
}))

/** Автосейв окон: debounce + flush при уходе со страницы / скрытии окна. */
let persistTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, prev) => {
  if (state.windows === prev.windows && state.arranged === prev.arranged) return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => persistWindows(useStore.getState()), 250)
})

if (typeof window !== 'undefined') {
  const flush = (): void => {
    clearTimeout(persistTimer)
    persistWindows(useStore.getState())
  }
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

/** Цвет контура, которому принадлежит сервис. */
export function accentOf(config: AppConfig | null, envId: string): string {
  return config?.envs.find((e) => e.id === envId)?.accent ?? 'var(--focus)'
}
