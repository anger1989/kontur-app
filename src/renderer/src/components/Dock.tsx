import { type JSX, type ReactNode } from 'react'
import { useStore } from '@/store'
import { routeKey, useShellApps } from '@/lib/shellApps'
import { Dock as DockBar, type DockItem } from '@/components/ui/dock'

/** Строка-бейдж поверх маленькой иконки дока — счётчик уместнее точки на 40px. */
function Badge({ children, count }: { children: ReactNode; count?: number }): JSX.Element {
  return (
    <span className="relative flex h-full w-full items-center justify-center">
      {children}
      {count ? (
        <span className="absolute -top-1.5 -right-2 rounded-full bg-primary px-1 text-[9px] leading-[14px] font-semibold text-primary-foreground tabular-nums">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Док рабочего стола: страницы приложения + сервисы по контурам.
 * Клик открывает/поднимает окно; точка — окно открыто; подъём — окно в фокусе.
 *
 * Сам список пунктов — общий с панелью KDE (см. lib/shellApps).
 */
export function Dock(): JSX.Element {
  const openWindow = useStore((s) => s.openWindow)
  const deskWidth = useStore((s) => s.desktop.width)
  const apps = useShellApps()
  // Ключи открытых роутов — стабильны при драге окон (меняются только x/y).
  const openKeys = useStore((s) => s.windows.map((w) => routeKey(w.route)).sort().join('|'))
  // Верхнее несвёрнутое окно — только его иконка приподнята.
  const focusedKey = useStore((s) => {
    const top = [...s.windows].filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]
    return top ? routeKey(top.route) : ''
  })

  const open = new Set(openKeys.split('|'))

  const items: DockItem[] = apps.map((app, i) => {
    const prev = apps[i - 1]
    return {
      title: app.envShort ? `${app.envShort} · ${app.title}` : app.title,
      icon: (
        <Badge count={app.groupKey === 'pages' ? app.count : undefined}>
          {app.icon({
            size: 32,
            className: 'h-full w-full text-neutral-700 dark:text-white/95'
          })}
        </Badge>
      ),
      open: open.has(app.key),
      focused: focusedKey === app.key,
      // Разделитель между страницами приложения и каждой группой сервисов.
      separatorBefore: Boolean(prev) && prev!.groupKey !== app.groupKey,
      onClick: () => openWindow(app.route)
    }
  })

  const setDockElevated = useStore((s) => s.setDockElevated)

  return (
    // z-[1000]: окна получают z-index из windowSeq (обычные маленькие числа) —
    // без явного большого значения развёрнутое окно перекрыло бы док и
    // визуально, и по кликам (Desktop не изолирует стекинг-контекст).
    // WebContentsView всё равно выше DOM — полосу дока клипает useViewBounds;
    // на hover поднимаем клип (dockElevated), чтобы magnification не уходил под вебвью.
    <div className="no-drag pointer-events-none absolute inset-x-0 bottom-3 z-[1000] flex justify-center overflow-visible">
      <div
        className="pointer-events-auto overflow-visible"
        onMouseEnter={() => setDockElevated(true)}
        onMouseLeave={() => setDockElevated(false)}
      >
        {/* Запас по 16px с каждого края, чтобы док не упирался в стенки стола. */}
        <DockBar items={items} maxWidth={Math.max(240, deskWidth - 32)} />
      </div>
    </div>
  )
}
