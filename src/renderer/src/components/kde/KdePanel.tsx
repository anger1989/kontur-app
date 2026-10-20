import { useEffect, useState, type JSX } from 'react'
import { AppWindow, LayoutGrid, Minus, MonitorDown, Pin, PinOff, X } from 'lucide-react'
import type { TunnelState } from '@shared/types'
import { useStore, windowTitle, type DeskWindow, type Route } from '@/store'
import { cn } from '@/lib/utils'
import { managedVpnEnvs } from '@/lib/envTunnel'
import { SETTINGS_APP, routeKey, usePinnedApps, useShellApps, type ShellApp } from '@/lib/shellApps'
import { EnvStatusMenu, EnvTrayConnectBridge } from '@/components/EnvStatusMenu'
import { KdeLauncher } from './KdeLauncher'
import { KdeContextMenu, type KdeMenuEntry } from './KdeContextMenu'

/**
 * Нижняя панель KDE Plasma: «Пуск», закреплённые пункты, кнопки открытых окон,
 * системный лоток, часы и узкая полоса «Показать рабочий стол» у самого края.
 *
 * Это альтернатива связке «строка меню сверху + док снизу» (TitleBar + Dock);
 * какая оболочка рисуется, решает Настройки → Общее → «Вид интерфейса».
 */
export function KdePanel(): JSX.Element {
  const config = useStore((s) => s.config)
  const statuses = useStore((s) => s.statuses)
  const windows = useStore((s) => s.windows)
  const openWindow = useStore((s) => s.openWindow)
  const focusWindow = useStore((s) => s.focusWindow)
  const minimizeWindow = useStore((s) => s.minimizeWindow)
  const closeWindow = useStore((s) => s.closeWindow)
  const arrangeWindows = useStore((s) => s.arrangeWindows)
  const peekDesktop = useStore((s) => s.peekDesktop)
  const arranged = useStore((s) => s.arranged)
  const desktop = useStore((s) => s.desktop)
  const apps = useShellApps()
  const { pinned, toggle } = usePinnedApps()
  const [layout, setLayout] = useState<{ short: string; name: string } | null>(null)

  useEffect(() => {
    void window.kontur.keyboard.layout().then((l) => setLayout({ short: l.short, name: l.name }))
    return window.kontur.keyboard.onLayoutChange((l) => setLayout({ short: l.short, name: l.name }))
  }, [])

  const topId = [...windows].filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]?.id ?? null
  const envs = managedVpnEnvs(config?.envs)

  const known = [...apps, SETTINGS_APP]
  const appFor = (key: string): ShellApp | undefined => known.find((a) => a.key === key)

  /** Иконка пункта: та же, что в «Пуске»; для неизвестной страницы — общая. */
  const iconFor = (key: string, size = 16): JSX.Element => {
    const app = appFor(key)
    if (app) return app.icon({ size })
    return <AppWindow size={size} strokeWidth={1.75} />
  }

  const titleFor = (key: string): string => {
    const app = appFor(key)
    if (app) return app.envShort ? `${app.envShort} · ${app.title}` : app.title
    const win = windows.find((w) => routeKey(w.route) === key)
    return win ? windowTitle(win.route, config) : key
  }

  const windowFor = (key: string): DeskWindow | undefined =>
    windows.find((w) => routeKey(w.route) === key)

  /** Клик по пункту: активное окно сворачиваем, остальное поднимаем или открываем. */
  const activate = (key: string, route: Route | undefined): void => {
    const win = windowFor(key)
    if (!win) {
      if (route) openWindow(route)
      return
    }
    if (!win.minimized && win.id === topId) minimizeWindow(win.id)
    else focusWindow(win.id)
  }

  /** Пункты контекстного меню — общие для закреплённых иконок и кнопок окон. */
  const menuFor = (key: string): KdeMenuEntry[] => {
    const win = windowFor(key)
    const isPinnedKey = pinned.includes(key)
    const entries: KdeMenuEntry[] = [
      {
        label: isPinnedKey ? 'Открепить от панели' : 'Закрепить на панели',
        icon: isPinnedKey ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />,
        onSelect: () => toggle(key)
      }
    ]
    if (!win) return entries
    return [
      ...entries,
      {
        label: win.minimized ? 'Развернуть окно' : 'Свернуть окно',
        icon: <Minus className="size-3.5" />,
        separatorBefore: true,
        onSelect: () => (win.minimized ? focusWindow(win.id) : minimizeWindow(win.id))
      },
      {
        label: 'Закрыть окно',
        icon: <X className="size-3.5" />,
        danger: true,
        onSelect: () => closeWindow(win.id)
      }
    ]
  }

  const stateOf = (key: string): 'active' | 'minimized' | 'idle' | 'closed' => {
    const win = windowFor(key)
    if (!win) return 'closed'
    if (win.minimized) return 'minimized'
    return win.id === topId ? 'active' : 'idle'
  }

  // Закреплённое окно уже представлено своей иконкой — второй кнопки не нужно.
  const taskWindows = windows.filter((w) => !pinned.includes(routeKey(w.route)))
  // Сервис могли удалить из настроек — его закладку на панели не рисуем.
  const pinnedVisible = pinned.filter((key) => appFor(key) || windowFor(key))

  return (
    // z-[1000] — как у дока: окна получают небольшие z-index из windowSeq и
    // без этого развёрнутое окно перекрыло бы панель и по кликам тоже.
    // Полосу панели вырезает из нативных вебвью useViewBounds (KDE_PANEL_CLEARANCE).
    <footer className="kde-surface kde-panel drag absolute inset-x-0 bottom-0 z-[1000] flex h-11 items-stretch">
      <KdeLauncher />

      {pinnedVisible.length > 0 && (
        <div className="no-drag flex shrink-0 items-stretch border-l border-kde-line">
          {pinnedVisible.map((key) => {
            const app = appFor(key)
            return (
              <KdeContextMenu key={key} entries={menuFor(key)}>
                {({ onContextMenu }) => (
                  <button
                    type="button"
                    data-state={stateOf(key)}
                    title={`${titleFor(key)} — правый клик открывает меню`}
                    aria-label={titleFor(key)}
                    onContextMenu={onContextMenu}
                    onClick={() => activate(key, app?.route)}
                    className="kde-task grid h-11 w-11 place-items-center text-kde-fg transition-colors hover:bg-kde-hover"
                  >
                    <span className="grid size-[18px] place-items-center">{iconFor(key, 18)}</span>
                  </button>
                )}
              </KdeContextMenu>
            )
          })}
        </div>
      )}

      <div className="no-drag flex min-w-0 flex-1 items-stretch gap-px overflow-hidden px-1">
        {taskWindows.map((win) => {
          const key = routeKey(win.route)
          return (
            <KdeContextMenu key={win.id} entries={menuFor(key)}>
              {({ onContextMenu }) => (
                <button
                  type="button"
                  data-state={stateOf(key)}
                  title={`${windowTitle(win.route, config)} — правый клик открывает меню`}
                  onContextMenu={onContextMenu}
                  onClick={() => activate(key, win.route)}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeWindow(win.id)
                  }}
                  className={cn(
                    'kde-task flex h-11 min-w-0 flex-1 basis-[180px] items-center gap-2 px-2.5 text-left',
                    'text-[12px] text-kde-fg transition-colors hover:bg-kde-hover',
                    'max-w-[200px]'
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center">{iconFor(key)}</span>
                  <span className="min-w-0 flex-1 truncate">{windowTitle(win.route, config)}</span>
                </button>
              )}
            </KdeContextMenu>
          )
        })}
      </div>

      <div className="no-drag flex shrink-0 items-center gap-1 px-1.5">
        <TrayButton
          title={arranged ? 'Вернуть окна как было' : 'Разложить окна'}
          active={arranged}
          onClick={() => arrangeWindows(desktop)}
        >
          <LayoutGrid className="size-4" strokeWidth={1.75} />
        </TrayButton>

        {layout && (
          <span
            className="inline-flex min-w-[1.75rem] items-center justify-center rounded-[3px] border border-kde-line px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-kde-fg"
            title={`Раскладка: ${layout.name}`}
          >
            {layout.short}
          </span>
        )}

        {envs.length > 0 && (
          <div className="flex items-center gap-1.5 border-l border-kde-line pl-2">
            {envs.map((env) => {
              const tunnel = (statuses.find((s) => s.envId === env.id)?.tunnel ??
                'unknown') as TunnelState
              return <EnvStatusMenu key={env.id} env={env} tunnel={tunnel} />
            })}
          </div>
        )}

        <PanelClock />
      </div>

      {/* Breeze: узкая полоса у самого края — «Показать рабочий стол». */}
      <button
        type="button"
        title="Показать рабочий стол"
        aria-label="Показать рабочий стол"
        onClick={() => peekDesktop(desktop)}
        className="no-drag group flex w-4 shrink-0 items-center justify-center border-l border-kde-line hover:bg-kde-hover"
      >
        <MonitorDown className="size-3 text-kde-dim group-hover:text-kde-fg" strokeWidth={1.75} />
      </button>
      <EnvTrayConnectBridge />
    </footer>
  )
}

function TrayButton({
  title,
  active,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-[3px] text-kde-dim hover:bg-kde-hover hover:text-kde-fg',
        active && 'bg-kde-active text-kde-fg'
      )}
    >
      {children}
    </button>
  )
}

/** Цифровые часы Breeze: время строкой выше, дата — строкой ниже. */
function PanelClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' })

  return (
    <time
      dateTime={now.toISOString()}
      title={now.toLocaleString('ru-RU')}
      className="ml-1 flex flex-col items-center justify-center px-2 leading-none tabular-nums select-none"
    >
      <span className="text-[12.5px] font-semibold text-kde-fg">{time}</span>
      <span className="mt-0.5 text-[10px] text-kde-dim">{date}</span>
    </time>
  )
}
