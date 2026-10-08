import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { motion } from 'motion/react'
import {
  ArrowLeft,
  BookmarkPlus,
  House,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  RefreshCw,
  X
} from 'lucide-react'
import { toast } from '@/components/ui/toast'
import { nativeViewId, showServiceView, useStore, windowTitle, type DeskWindow } from '@/store'
import { Button } from '@/components/ui/button'
import { clampServiceRect, isOccludedByHigher, maximizedRect } from '@/lib/deskLayout'
import { ServiceIcon } from './ServiceIcon'
import { ServiceHost } from './ServiceHost'
import { Today } from '@/pages/Today'
import { Mail } from '@/pages/Mail'
import { Calendar } from '@/pages/Calendar'
import { Tasks } from '@/pages/Tasks'
import { Search } from '@/pages/Search'
import { Notes } from '@/pages/Notes'
import { Files } from '@/pages/Files'
import { Bookmarks } from '@/pages/Bookmarks'
import { Browser } from '@/pages/Browser'
import { Planner } from '@/pages/Planner'
import { Settings } from '@/pages/Settings'
import { TerminalPage } from '@/pages/Terminal'
import { AssistantPage } from '@/pages/Assistant'
import { cn } from '@/lib/utils'

const MIN_WIDTH = 420
const MIN_HEIGHT = 280

/** macOS-like spring для maximize / genie. */
const SPRING = { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.82 }
const SNAP = { duration: 0 }

/** Тащим за окном мышь, пока не отпустят — без лишней либы, чистые Pointer Events. */
function trackDrag(onMove: (dx: number, dy: number) => void, onEnd?: () => void): void {
  const move = (e: PointerEvent): void => onMove(e.movementX, e.movementY)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onEnd?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function tickViewBounds(): void {
  window.dispatchEvent(new Event('kontur:view-bounds-tick'))
}

function PageContent({ win }: { win: DeskWindow }): JSX.Element | null {
  if (win.route.kind !== 'page') return null
  const route = win.route
  const clearFocus = (): void => useStore.getState().clearWindowItem(win.id)
  switch (route.page) {
    case 'today':
      return <Today />
    case 'mail':
      return <Mail focusItemId={route.itemId} onFocused={clearFocus} />
    case 'calendar':
      return <Calendar focusItemId={route.itemId} onFocused={clearFocus} />
    case 'tasks':
      return <Tasks />
    case 'planner':
      return <Planner focusItemId={route.itemId} onFocused={clearFocus} />
    case 'search':
      return <Search />
    case 'notes':
      return <Notes />
    case 'files':
      return <Files />
    case 'bookmarks':
      return <Bookmarks />
    // Браузер рисуется выше, рядом с ServiceHost: ему нужны frozen/maximized,
    // которых у остальных страниц нет (под ним живёт нативный вебвью).
    case 'browser':
      return null
    case 'settings':
      return <Settings />
    case 'terminal':
      return <TerminalPage />
    case 'assistant':
      return <AssistantPage />
  }
}

export function Window({
  winId,
  desktopSize
}: {
  winId: string
  desktopSize: { width: number; height: number }
}): JSX.Element | null {
  const win = useStore((s) => s.windows.find((w) => w.id === winId))
  const isTop = useStore((s) => {
    const w = s.windows.find((x) => x.id === winId)
    if (!w || w.minimized) return false
    const topZ = Math.max(0, ...s.windows.filter((x) => !x.minimized).map((x) => x.z))
    return w.z === topZ
  })
  // CSS z-index — не сырой win.z (windowSeq растёт без ограничения весь сеанс и
  // за пару десятков переключений фокуса легко перевалит за z-50 у модалок/Select,
  // те окажутся под окном). Берём ранг среди открытых окон — всегда маленькое число.
  const zIndex = useStore((s) => {
    const open = [...s.windows].filter((x) => !x.minimized).sort((a, b) => a.z - b.z)
    const idx = open.findIndex((x) => x.id === winId)
    return idx >= 0 ? idx + 1 : 1
  })
  const config = useStore((s) => s.config)
  // Нативный view поверх любого DOM — если выше есть пересекающееся окно,
  // вебвью нижнего нельзя держать (иначе рисуется поверх чужого titlebar).
  const occluded = useStore((s) => {
    const w = s.windows.find((x) => x.id === winId)
    if (!w || w.minimized || !nativeViewId(w.route, s.browser)) return true
    return isOccludedByHigher(
      w,
      s.windows.filter((x) => !x.minimized)
    )
  })
  /** Нативный слой этого окна: вкладка сервиса или активная вкладка браузера. */
  const viewId = useStore((s) => {
    const w = s.windows.find((x) => x.id === winId)
    return w ? nativeViewId(w.route, s.browser) : null
  })
  const closeWindow = useStore((s) => s.closeWindow)
  const focusWindow = useStore((s) => s.focusWindow)
  const minimizeWindow = useStore((s) => s.minimizeWindow)
  const clearFromDock = useStore((s) => s.clearFromDock)
  const toggleMaximize = useStore((s) => s.toggleMaximize)
  const updateWindowRect = useStore((s) => s.updateWindowRect)
  const arranged = useStore((s) => s.arranged)
  const arrangeKind = useStore((s) => s.arrangeKind)
  /** Peek — клик выбирает окно; tile — обычная работа в плитке. */
  const peekMode = arranged && arrangeKind === 'peek'
  const rectAtDragStart = useRef({ x: 0, y: 0, width: 0, height: 0 })
  const [snap, setSnap] = useState(false)
  const [genieOut, setGenieOut] = useState(false)
  /** Вебвью только после genie-in / maximize spring — иначе bounds плывут. */
  const [serviceReady, setServiceReady] = useState(() => !win?.fromDock)
  /** Загрузка нативного вебвью — спиннер в titlebar (DOM выше WebContentsView). */
  const [viewLoading, setViewLoading] = useState(false)

  useEffect(() => {
    if (!viewId) {
      setViewLoading(false)
      return
    }
    let cancelled = false
    void window.kontur.view.isLoading(viewId).then((on) => {
      if (!cancelled) setViewLoading(on)
    })
    const off = window.kontur.view.onLoading((id, loading) => {
      if (id === viewId) setViewLoading(loading)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [viewId])

  if (!win) return null

  const isService = win.route.kind === 'service'
  const isTerminal =
    win.route.kind === 'page' &&
    (win.route.page === 'terminal' || win.route.page === 'assistant')
  const isBrowser = win.route.kind === 'page' && win.route.page === 'browser'
  /**
   * Окно держит нативный WebContentsView. Для таких окон действуют свои
   * правила: не заезжать на док (вебвью рисуется поверх него) и прятать слой
   * на время анимаций разворота и сворачивания.
   */
  const hostsView = isService || isBrowser
  const service = isService
    ? config?.services.find((s) => s.id === (win.route as { serviceId: string }).serviceId)
    : undefined
  const env = service ? config?.envs.find((e) => e.id === service.envId) : undefined
  const title = windowTitle(win.route, config)
  // Хост держим смонтированным и при перекрытии: иначе unmount → hide → пустое
  // окно и мигание при возврате фокуса. Нативный view прячется, сверху freeze.
  const showServiceHost = isService && serviceReady && !genieOut
  const maximizeSize = maximizedRect(desktopSize)

  const dockX = Math.round(desktopSize.width / 2 - 24)
  const dockY = Math.round(desktopSize.height - 52)

  const onTitlePointerDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0 || genieOut) return
    focusWindow(win.id)
    // Peek: клик выбирает окно; тащить нельзя. Tile — можно двигать.
    if (win.maximized || peekMode) return
    setSnap(true)
    rectAtDragStart.current = { x: win.x, y: win.y, width: win.width, height: win.height }
    trackDrag(
      (dx, dy) => {
        const r = rectAtDragStart.current
        r.x += dx
        r.y += dy
        if (hostsView) {
          const c = clampServiceRect(r, desktopSize, MIN_WIDTH, MIN_HEIGHT)
          r.x = c.x
          r.y = c.y
        } else {
          r.x = Math.min(Math.max(r.x, -r.width + 120), desktopSize.width - 40)
          r.y = Math.min(Math.max(r.y, 0), desktopSize.height - 36)
        }
        updateWindowRect(win.id, { x: r.x, y: r.y })
      },
      () => setSnap(false)
    )
  }

  const beginResize =
    (edges: { right?: boolean; bottom?: boolean; left?: boolean; top?: boolean }) =>
    (e: ReactPointerEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      if (genieOut || peekMode) return
      focusWindow(win.id)
      setSnap(true)
      rectAtDragStart.current = { x: win.x, y: win.y, width: win.width, height: win.height }
      trackDrag(
        (dx, dy) => {
          const r = rectAtDragStart.current
          if (edges.right) r.width = Math.max(MIN_WIDTH, r.width + dx)
          if (edges.bottom) r.height = Math.max(MIN_HEIGHT, r.height + dy)
          if (edges.left) {
            const next = Math.max(MIN_WIDTH, r.width - dx)
            r.x += r.width - next
            r.width = next
          }
          if (edges.top) {
            const next = Math.max(MIN_HEIGHT, r.height - dy)
            r.y += r.height - next
            r.height = next
          }
          if (hostsView) {
            const c = clampServiceRect(r, desktopSize, MIN_WIDTH, MIN_HEIGHT)
            updateWindowRect(win.id, c)
          } else {
            updateWindowRect(win.id, { x: r.x, y: r.y, width: r.width, height: r.height })
          }
        },
        () => setSnap(false)
      )
    }

  const runMaximize = (): void => {
    setSnap(false)
    if (hostsView && viewId) {
      void window.kontur.view.hide(viewId)
      setServiceReady(false)
    }
    toggleMaximize(win.id, maximizeSize)
  }

  const runMinimize = (): void => {
    if (genieOut) return
    if (hostsView && viewId) void window.kontur.view.hide(viewId)
    setServiceReady(false)
    setSnap(false)
    setGenieOut(true)
  }

  return (
    <motion.div
      data-desk-window={win.id}
      className={cn(
        // Тень на внешней оболочке без overflow-hidden — иначе box-shadow клипится.
        'absolute',
        !win.maximized &&
          'shadow-[0_2px_8px_rgba(0,0,0,0.18),0_12px_40px_-4px_rgba(0,0,0,0.35),0_24px_64px_-12px_rgba(0,0,0,0.28)]',
        genieOut && 'pointer-events-none'
      )}
      style={{ zIndex }}
      initial={
        win.fromDock
          ? {
              left: dockX,
              top: dockY,
              width: 48,
              height: 48,
              opacity: 0.55,
              scale: 0.2,
              borderRadius: 22
            }
          : false
      }
      animate={
        genieOut
          ? {
              left: dockX,
              top: dockY,
              width: 48,
              height: 48,
              opacity: 0,
              scale: 0.12,
              borderRadius: 22
            }
          : {
              left: win.x,
              top: win.y,
              width: win.width,
              height: win.height,
              opacity: 1,
              scale: 1,
              borderRadius: win.maximized ? 0 : 12
            }
      }
      transition={snap ? SNAP : SPRING}
      onUpdate={() => {
        if (!snap && !genieOut) tickViewBounds()
      }}
      onAnimationComplete={() => {
        if (genieOut) {
          minimizeWindow(win.id)
          return
        }
        if (win.fromDock) clearFromDock(win.id)
        setServiceReady(true)
        tickViewBounds()
        if (hostsView && viewId && !occluded) showServiceView(viewId)
      }}
      onPointerDown={() => {
        if (!genieOut) focusWindow(win.id)
      }}
    >
      {/* Плотная заливка без backdrop-blur: поверх виджетов «Моего дня»
          (тоже blur + GlowingEffect) Chromium рисует ghost-рамки с радугой. */}
      <div
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden border border-white/15 bg-card text-card-foreground dark:border-white/10',
          isTop && 'ring-1 ring-foreground/10'
        )}
        style={{ borderRadius: 'inherit' }}
      >
      <div
        className={cn(
          'no-drag relative flex h-9 shrink-0 items-center gap-2 border-b border-white/10 bg-muted/40 px-3',
          peekMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
        )}
        onPointerDown={onTitlePointerDown}
        onDoubleClick={() => {
          if (!peekMode) runMaximize()
        }}
      >
        {/* Как в macOS: глиф внутри кружка проявляется только при наведении на всю тройку. */}
        <div className="group flex items-center gap-1.5">
          <button
            type="button"
            title="Закрыть"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => closeWindow(win.id)}
            className="flex size-3 items-center justify-center rounded-full bg-[#ff5f57]"
          >
            <X className="size-2 text-[#4d0000] opacity-0 group-hover:opacity-100" strokeWidth={3} />
          </button>
          <button
            type="button"
            title="Свернуть"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={runMinimize}
            className="flex size-3 items-center justify-center rounded-full bg-[#febc2e]"
          >
            <Minus className="size-2 text-[#5c3c00] opacity-0 group-hover:opacity-100" strokeWidth={3} />
          </button>
          <button
            type="button"
            title={win.maximized ? 'Восстановить' : 'Развернуть'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={runMaximize}
            className="flex size-3 items-center justify-center rounded-full bg-[#28c840]"
          >
            <Maximize2 className="size-1.5 text-[#004d00] opacity-0 group-hover:opacity-100" strokeWidth={4} />
          </button>
        </div>

        {isService && (
          <span className="size-2 shrink-0 rounded-full" style={{ background: env?.accent }} />
        )}
        {isService && <ServiceIcon serviceId={service?.id ?? ''} kind={service?.kind ?? ''} size={14} />}
        {isService && viewLoading && (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-center text-[12px] font-medium select-none">
          {title}
        </span>

        {isService && service && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Назад"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void window.kontur.view.back(service.id)}
            >
              <ArrowLeft className="size-3" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="На главную"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void window.kontur.view.home(service.id)}
            >
              <House className="size-3" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Обновить"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void window.kontur.view.reload(service.id)}
            >
              <RefreshCw className={cn('size-3', viewLoading && 'animate-spin')} />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Скопировать адрес"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                void (async () => {
                  const url = await window.kontur.view.url(service.id)
                  if (!url) {
                    toast.error('Адрес страницы недоступен')
                    return
                  }
                  try {
                    await navigator.clipboard.writeText(url)
                    toast.success('Адрес скопирован')
                  } catch {
                    toast.error('Не удалось скопировать')
                  }
                })()
              }}
            >
              <Link2 className="size-3" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title="Добавить в закладки"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                void window.kontur.bookmarks
                  .addFromService(service.id)
                  .then((b) => toast.success(`В закладках: ${b.title}`))
                  .catch((e: unknown) => {
                    toast.error(`Не удалось добавить закладку: ${e instanceof Error ? e.message : String(e)}`)
                  })
              }}
            >
              <BookmarkPlus className="size-3" />
            </Button>
          </div>
        )}
        {/* Полоска прогресса под titlebar — WebContentsView рисуется ниже и её не кроет. */}
        {isService && viewLoading && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden"
            aria-hidden
          >
            <div className="kontur-view-loading-bar h-full w-1/3 bg-primary" />
          </div>
        )}
      </div>

      {/* overflow-auto, не hidden: Settings/Search/Notes не держат свой скролл-контейнер
          и полагались на родителя (так было и в App.tsx до переезда на окна) — Today/
          Mail/Calendar/Tasks со своим h-full + overflow-y-auto внутри это не трогает.
          pr/pb = ширина хэндлов ресайза: иначе скроллбар у края перекрыт cursor-*-resize.
          Терминал — full-bleed тёмный холст без скролла родителя. */}
      <div
        className={cn(
          'relative min-h-0 flex-1',
          isTerminal
            ? 'overflow-hidden bg-neutral-900'
            : isBrowser
              ? 'overflow-hidden bg-background'
              : 'overflow-auto bg-background',
          // Браузер сам отвечает за зазор под хэндлы ресайза (BrowserHost):
          // его хром обязан доходить до краёв окна, как у настоящего браузера.
          !win.maximized && !isBrowser && 'pr-2 pb-2'
        )}
      >
        {isBrowser ? (
          <Browser
            frozen={occluded}
            maximized={win.maximized}
            focused={isTop}
            rect={`${win.x},${win.y},${win.width},${win.height}`}
          />
        ) : win.route.kind === 'page' ? (
          <PageContent win={win} />
        ) : showServiceHost ? (
          <ServiceHost
            serviceId={win.route.serviceId}
            frozen={occluded}
            layout={{
              x: win.x,
              y: win.y,
              width: win.width,
              height: win.height,
              maximized: win.maximized
            }}
          />
        ) : (
          // Ещё не готов (genie/maximize) или свернули.
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/30 text-muted-foreground">
            <ServiceIcon serviceId={service?.id ?? ''} kind={service?.kind ?? ''} size={28} />
          </div>
        )}
      </div>

      {!win.maximized && (
        <>
          {/*
            Ресайз с любого края/угла. z выше контента; для вебвью ServiceHost
            оставляет inset со всех сторон — иначе WebContentsView перехватывает pointer.
            Полосы w/h-2 совпадают с pr/pb контента выше — скроллбар не под ними.
          */}
          <div
            onPointerDown={beginResize({ top: true })}
            className="no-drag absolute top-0 right-3.5 left-3.5 z-20 h-1.5 cursor-ns-resize"
          />
          <div
            onPointerDown={beginResize({ bottom: true })}
            className="no-drag absolute right-3.5 bottom-0 left-3.5 z-20 h-2 cursor-ns-resize"
          />
          <div
            onPointerDown={beginResize({ left: true })}
            className="no-drag absolute top-3.5 bottom-3.5 left-0 z-20 w-2 cursor-ew-resize"
          />
          <div
            onPointerDown={beginResize({ right: true })}
            className="no-drag absolute top-3.5 right-0 bottom-3.5 z-20 w-2 cursor-ew-resize"
          />
          <div
            onPointerDown={beginResize({ left: true, top: true })}
            className="no-drag absolute top-0 left-0 z-30 size-3.5 cursor-nwse-resize"
          />
          <div
            onPointerDown={beginResize({ right: true, top: true })}
            className="no-drag absolute top-0 right-0 z-30 size-3.5 cursor-nesw-resize"
          />
          <div
            onPointerDown={beginResize({ left: true, bottom: true })}
            className="no-drag absolute bottom-0 left-0 z-30 size-3.5 cursor-nesw-resize"
          />
          <div
            onPointerDown={beginResize({ right: true, bottom: true })}
            className="no-drag absolute right-0 bottom-0 z-30 size-3.5 cursor-nwse-resize"
          />
        </>
      )}
      </div>
    </motion.div>
  )
}
