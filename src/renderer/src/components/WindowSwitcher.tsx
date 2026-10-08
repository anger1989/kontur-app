import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Bookmark,
  CalendarDays,
  FileText,
  Globe,
  Kanban,
  ListTodo,
  Mail,
  NotebookPen,
  Search,
  Settings,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'
import {
  nativeViewId,
  notifyPopoverOpenChange,
  useStore,
  windowTitle,
  type AppPage,
  type DeskWindow
} from '@/store'
import { HorizontalDepthFade } from '@/components/ui/horizontal-depth-fade'
import { ServiceIcon } from './ServiceIcon'

/** После последнего ⌘` — подтвердить, если модификатор уже отпущен (webview IPC). */
const SETTLE_MS = 850

const PAGE_ICON: Record<AppPage, LucideIcon> = {
  today: FileText,
  mail: Mail,
  calendar: CalendarDays,
  tasks: Kanban,
  planner: ListTodo,
  search: Search,
  notes: NotebookPen,
  files: FileText,
  bookmarks: Bookmark,
  browser: Globe,
  settings: Settings,
  terminal: TerminalSquare
}

function FallbackIcon({ win }: { win: DeskWindow }): JSX.Element {
  const route = win.route
  if (route.kind === 'service') {
    const svc = useStore.getState().config?.services.find((s) => s.id === route.serviceId)
    return <ServiceIcon serviceId={route.serviceId} kind={svc?.kind ?? ''} size={36} />
  }
  const Icon = PAGE_ICON[route.page] ?? FileText
  return <Icon className="size-9 text-muted-foreground" strokeWidth={1.75} />
}

/**
 * Cmd+`-подобный переключатель окон: горизонтальная лента миниатюр
 * (Horizontal Depth Fade). Нативные вебвью прячем на время оверлея.
 */
export function WindowSwitcher(): JSX.Element | null {
  const switcher = useStore((s) => s.windowSwitcher)
  const windows = useStore((s) => s.windows)
  const config = useStore((s) => s.config)
  const confirm = useStore((s) => s.confirmWindowSwitcher)
  const cancel = useStore((s) => s.cancelWindowSwitcher)
  const cycle = useStore((s) => s.cycleWindow)

  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openRef = useRef(false)

  const ordered = useMemo(() => {
    if (!switcher) return [] as DeskWindow[]
    return switcher.ids
      .map((id) => windows.find((w) => w.id === id))
      .filter((w): w is DeskWindow => Boolean(w && !w.minimized))
  }, [switcher, windows])

  const activeIndex = useMemo(() => {
    if (!switcher || !ordered.length) return 0
    const id = switcher.ids[switcher.index]
    const i = ordered.findIndex((w) => w.id === id)
    return i >= 0 ? i : 0
  }, [switcher, ordered])

  const bumpSettle = (): void => {
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(() => {
      settleRef.current = null
      useStore.getState().confirmWindowSwitcher()
    }, SETTLE_MS)
  }

  // Сразу спрятать вебвью + settle (не ждать capture — иначе ⌘` «висит»).
  useEffect(() => {
    if (!switcher) {
      if (openRef.current) {
        openRef.current = false
        notifyPopoverOpenChange(false)
      }
      if (settleRef.current) {
        clearTimeout(settleRef.current)
        settleRef.current = null
      }
      setThumbs({})
      return
    }

    if (!openRef.current) {
      openRef.current = true
      notifyPopoverOpenChange(true)
    }
    bumpSettle()

    let cancelled = false
    const ids = switcher.ids
    const st = useStore.getState()

    void (async () => {
      const next: Record<string, string | null> = {}
      await Promise.all(
        ids.map(async (winId) => {
          const win = st.windows.find((w) => w.id === winId)
          if (!win) {
            next[winId] = null
            return
          }
          const viewId = nativeViewId(win.route, st.browser)
          if (!viewId) {
            next[winId] = null
            return
          }
          next[winId] = await window.kontur.view.capture(viewId)
        })
      )
      if (cancelled) return
      setThumbs(next)
    })()

    return () => {
      cancelled = true
    }
    // Только на смену «сессии» switcher (открытие / новый набор ids).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcher?.ids.join('|')])

  // Каждый шаг по ленте — перезапуск settle.
  useEffect(() => {
    if (!switcher) return
    bumpSettle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcher?.index])

  // Esc / Enter / стрелки. Keyup ⌘ — в Desktop (всегда смонтирован).
  useEffect(() => {
    if (!switcher) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        cycle(1)
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        cycle(-1)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [switcher, confirm, cancel, cycle])

  // Unmount safety.
  useEffect(() => {
    return () => {
      if (openRef.current) {
        openRef.current = false
        notifyPopoverOpenChange(false)
      }
      if (settleRef.current) clearTimeout(settleRef.current)
    }
  }, [])

  const items = ordered.map((win) => ({
    id: win.id,
    src: thumbs[win.id],
    alt: windowTitle(win.route, config),
    label: windowTitle(win.route, config),
    fallback: <FallbackIcon win={win} />
  }))

  const activeTitle =
    ordered[activeIndex] != null
      ? windowTitle(ordered[activeIndex]!.route, config)
      : ''

  return (
    <AnimatePresence>
      {switcher && ordered.length >= 2 ? (
        <motion.div
          key="window-switcher"
          className="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) confirm()
          }}
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-md" />
          <motion.div
            className="relative z-[1] w-[min(920px,92vw)] rounded-3xl border border-white/12 bg-black/35 px-4 pb-5 pt-6 shadow-2xl dark:bg-black/50"
            initial={{ scale: 0.96, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, y: 6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HorizontalDepthFade
              items={items}
              activeIndex={activeIndex}
              onSelect={(i) => {
                const id = ordered[i]?.id
                if (!id) return
                useStore.setState({
                  windowSwitcher: {
                    ids: switcher.ids,
                    index: switcher.ids.indexOf(id)
                  }
                })
                // Клик по плитке — сразу выбрать.
                queueMicrotask(() => useStore.getState().confirmWindowSwitcher())
              }}
              itemWidth={260}
              itemHeight={164}
              gap={16}
              brightnessBoost={14}
              scaleEffect={0.075}
              className="px-2"
            />
            <p className="mt-4 truncate text-center text-[14px] font-medium text-white/90">
              {activeTitle}
            </p>
            <p className="mt-1 text-center text-[11px] text-white/45">
              ⌘` / ⌘⇧` · стрелки · отпустите ⌘ · Esc отмена
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
