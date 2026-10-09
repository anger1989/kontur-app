import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  Globe,
  House,
  Loader2,
  Plus,
  RefreshCw,
  SquareCode,
  X
} from 'lucide-react'
import type { BrowserTabState } from '@shared/types'
import { useStore } from '@/store'
import { toast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BrowserHost } from '@/components/BrowserHost'
import { cn } from '@/lib/utils'

/**
 * Встроенный браузер: полоса вкладок, адресная строка и место под страницу.
 *
 * Страницы — нативные `WebContentsView` в main (см. serviceViews.ts), здесь
 * только хром. Вкладка принадлежит контуру: она ходит в сеть его сессией,
 * видит его куки и его туннель, поэтому у каждой вкладки есть точка цвета
 * контура, а новую можно открыть сразу в нужном.
 */

/**
 * Вкладки делят полосу поровну: до `TAB_MAX_WIDTH`, пока их мало, и не уже
 * `TAB_MIN_WIDTH` — дальше полоса начинает прокручиваться, а не крошить
 * подписи в многоточие.
 */
const TAB_MIN_WIDTH = 132
const TAB_MAX_WIDTH = 220

function TabIcon({ tab }: { tab: BrowserTabState }): JSX.Element {
  if (tab.loading) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  if (tab.favicon) {
    return <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" draggable={false} />
  }
  return <Globe className="size-3.5 shrink-0 text-muted-foreground" />
}

export function Browser({
  frozen = false,
  maximized = false,
  focused = false,
  rect
}: {
  /** Поверх лежит другое окно — живую страницу держать нельзя. */
  frozen?: boolean
  maximized?: boolean
  /** Окно браузера — верхнее: только тогда работают его горячие клавиши. */
  focused?: boolean
  rect?: string
}): JSX.Element {
  const tabs = useStore((s) => s.browser.tabs)
  const activeId = useStore((s) => s.browser.activeId)
  const envs = useStore((s) => s.config?.envs ?? [])
  const openWindow = useStore((s) => s.openWindow)
  const active = tabs.find((t) => t.id === activeId) ?? null

  const stripRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  /** Первая вкладка заводится один раз на жизнь компонента (StrictMode монтирует дважды). */
  const askedFirstTab = useRef(false)
  const [envPickerOpen, setEnvPickerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  const enabledEnvs = envs.filter((e) => e.enabled)
  const activeEnvId = active?.envId

  useEffect(() => {
    if (tabs.length > 0 || askedFirstTab.current) return
    askedFirstTab.current = true
    void window.kontur.browser.newTab()
  }, [tabs.length])

  // Адрес из вкладки не затирает то, что человек печатает прямо сейчас.
  useEffect(() => {
    if (editing) return
    setDraft(active?.url ?? '')
  }, [active?.url, editing])

  const newTab = (envId?: string): void => {
    void window.kontur.browser.newTab({ envId: envId ?? activeEnvId, afterId: activeId ?? undefined })
  }

  const submitAddress = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setEditing(false)
      setDraft(active?.url ?? '')
      addressRef.current?.blur()
      return
    }
    if (e.key !== 'Enter' || !activeId) return
    setEditing(false)
    void window.kontur.browser.navigate(activeId, draft)
    addressRef.current?.blur()
  }

  /** Горячие клавиши, пока фокус в хроме. Внутри страницы их ловит main. */
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      if (e.code === 'KeyT') {
        e.preventDefault()
        newTab()
      } else if (e.code === 'KeyW' && activeId) {
        e.preventDefault()
        void window.kontur.browser.closeTab(activeId)
      } else if (e.code === 'KeyL') {
        e.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if (e.code === 'KeyR' && activeId) {
        e.preventDefault()
        void window.kontur.browser.reload(activeId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, activeId, activeEnvId])

  /**
   * Перетаскивание вкладки. Порядок меняем сразу по ходу движения — так видно,
   * куда вкладка встанет, и не нужен ни призрак, ни отдельный слой для drag.
   */
  const startTabDrag = (id: string) => (e: ReactPointerEvent): void => {
    if (e.button !== 0) return
    const strip = stripRef.current
    if (!strip) return
    const startX = e.clientX
    let dragging = false
    const move = (ev: PointerEvent): void => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return
      dragging = true
      const nodes = [...strip.querySelectorAll('[data-tab-id]')] as HTMLElement[]
      let to = nodes.length - 1
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect()
        if (ev.clientX < r.x + r.width / 2) {
          to = i
          break
        }
      }
      void window.kontur.browser.moveTab(id, to)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addBookmark = (): void => {
    if (!activeId) return
    void window.kontur.browser
      .bookmark(activeId)
      .then((b) => toast.success(`В закладках: ${b.title}`))
      .catch((err: unknown) => {
        toast.error(`Не удалось добавить закладку: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Полоса вкладок ─────────────────────────────────────────── */}
      {/* «+» сразу за последней вкладкой (не у правого края окна). */}
      <div className="flex h-9 w-full shrink-0 items-end gap-0.5 border-b border-white/10 bg-muted/40 px-1.5 pb-1">
        <div
          ref={stripRef}
          className="flex min-w-0 items-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            // Ширина по числу вкладок; при нехватке места — скролл, «+» остаётся рядом.
            maxWidth: `min(calc(100% - 2.5rem), ${Math.max(tabs.length, 1) * TAB_MAX_WIDTH + Math.max(tabs.length - 1, 0) * 4}px)`
          }}
        >
            {tabs.map((tab) => {
              const env = envs.find((e) => e.id === tab.envId)
              const isActive = tab.id === activeId
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  onPointerDown={startTabDrag(tab.id)}
                  onAuxClick={(e) => {
                    // Средняя кнопка закрывает вкладку — как в любом браузере.
                    if (e.button === 1) void window.kontur.browser.closeTab(tab.id)
                  }}
                  className={cn(
                    'group/tab flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-lg px-2',
                    'transition-[box-shadow,background-color,color]',
                    isActive
                      ? 'desk-tile text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                  )}
                  style={{
                    flex: `1 1 ${TAB_MAX_WIDTH}px`,
                    minWidth: TAB_MIN_WIDTH,
                    maxWidth: TAB_MAX_WIDTH
                  }}
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    title={env?.name ?? tab.envId}
                    style={{ background: env?.accent }}
                  />
                  <TabIcon tab={tab} />
                  <button
                    type="button"
                    title={`${tab.title}\n${tab.url}`}
                    onClick={() => void window.kontur.browser.activateTab(tab.id)}
                    className="min-w-0 flex-1 truncate text-left text-[12px]"
                  >
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    aria-label="Закрыть вкладку"
                    onClick={() => void window.kontur.browser.closeTab(tab.id)}
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground',
                      'opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-foreground/10 hover:text-foreground',
                      isActive && 'opacity-70'
                    )}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
        </div>

        <div className="mb-0.5 flex shrink-0 items-center">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Новая вкладка (⌘T)"
            onClick={() => newTab()}
          >
            <Plus className="size-3.5" />
          </Button>
          {/* Больше одного контура — даём выбрать, в каком открыть вкладку:
              от контура зависят и куки, и туннель, и прокси. */}
          {enabledEnvs.length > 1 && (
            <Popover open={envPickerOpen} onOpenChange={setEnvPickerOpen}>
              <PopoverTrigger asChild>
                <Button type="button" size="icon-xs" variant="ghost" title="Новая вкладка в контуре">
                  <ChevronDown className="size-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-1">
                <p className="px-2 py-1.5 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                  Новая вкладка в контуре
                </p>
                {enabledEnvs.map((env) => (
                  <button
                    key={env.id}
                    type="button"
                    onClick={() => {
                      setEnvPickerOpen(false)
                      newTab(env.id)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: env.accent }}
                    />
                    <span className="min-w-0 flex-1 truncate">{env.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {/* ── Адресная строка ────────────────────────────────────────── */}
      <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-white/10 bg-muted/20 px-1.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="Назад (⌘[)"
          disabled={!active?.canGoBack}
          onClick={() => activeId && void window.kontur.browser.back(activeId)}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="Вперёд (⌘])"
          disabled={!active?.canGoForward}
          onClick={() => activeId && void window.kontur.browser.forward(activeId)}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={active?.loading ? 'Остановить' : 'Обновить (⌘R)'}
          disabled={!activeId}
          onClick={() => {
            if (!activeId) return
            if (active?.loading) void window.kontur.browser.stop(activeId)
            else void window.kontur.browser.reload(activeId)
          }}
        >
          {active?.loading ? <X className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="На стартовую"
          disabled={!activeId}
          onClick={() => activeId && void window.kontur.browser.home(activeId)}
        >
          <House className="size-3.5" />
        </Button>

        {/* Поле «вдавлено» внутрь панели — та же лепка, что у нажатых пилюль
            виджетов: так видно, что это ввод, а не кнопка. */}
        <div className="desk-chip-on flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1">
          {active && (
            <span
              className="size-1.5 shrink-0 rounded-full"
              title={envs.find((e) => e.id === active.envId)?.name ?? active.envId}
              style={{ background: envs.find((e) => e.id === active.envId)?.accent }}
            />
          )}
          <input
            ref={addressRef}
            aria-label="Адрес или поиск"
            value={draft}
            disabled={!activeId}
            spellCheck={false}
            placeholder="Адрес или поиск"
            onChange={(e) => {
              setEditing(true)
              setDraft(e.target.value)
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setEditing(false)}
            onKeyDown={submitAddress}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="Добавить в закладки"
          disabled={!activeId}
          onClick={addBookmark}
        >
          <BookmarkPlus className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="Закладки"
          onClick={() => openWindow({ kind: 'page', page: 'bookmarks' })}
        >
          <Bookmark className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="DevTools — отдельное окно · ⌥⌘I закрыть"
          disabled={!activeId}
          onClick={() => activeId && void window.kontur.browser.devTools(activeId)}
        >
          <SquareCode className="size-3.5" />
        </Button>
        {active?.loading && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden"
            aria-hidden
          >
            <div className="kontur-view-loading-bar h-full w-1/3 bg-primary" />
          </div>
        )}
      </div>

      {/* ── Страница ───────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <BrowserHost tabId={activeId} frozen={frozen} maximized={maximized} rect={rect} />
      </div>
    </div>
  )
}
