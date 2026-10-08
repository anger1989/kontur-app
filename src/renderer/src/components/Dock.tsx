import { useEffect, useState, type JSX } from 'react'
import {
  Bookmark,
  CalendarDays,
  Globe,
  Kanban,
  ListTodo,
  Mail,
  NotebookPen,
  Sparkles,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'
import { computeAttention } from '@shared/attention'
import { useStore, type Route } from '@/store'
import { ServiceIcon } from './ServiceIcon'
import { Dock as DockBar, type DockItem } from '@/components/ui/dock'

/** Строка-бейдж поверх маленькой иконки дока — счётчик уместнее точки на 40px. */
function Badge({ icon: Icon, count }: { icon: LucideIcon; count?: number }): JSX.Element {
  return (
    <span className="relative flex h-full w-full items-center justify-center">
      <Icon className="h-full w-full text-neutral-700 dark:text-white/95" />
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
 */
export function Dock(): JSX.Element {
  const config = useStore((s) => s.config)
  const openWindow = useStore((s) => s.openWindow)
  const deskWidth = useStore((s) => s.desktop.width)
  // Ключи открытых роутов — стабильны при драге окон (меняются только x/y).
  const openKeys = useStore((s) =>
    s.windows
      .map((w) =>
        w.route.kind === 'page' ? `page:${w.route.page}` : `service:${w.route.serviceId}`
      )
      .sort()
      .join('|')
  )
  // Верхнее несвёрнутое окно — только его иконка приподнята.
  const focusedKey = useStore((s) => {
    const top = [...s.windows]
      .filter((w) => !w.minimized)
      .sort((a, b) => b.z - a.z)[0]
    if (!top) return ''
    return top.route.kind === 'page'
      ? `page:${top.route.page}`
      : `service:${top.route.serviceId}`
  })
  const [badges, setBadges] = useState({
    mailUnread: 0,
    todayActive: 0,
    calendarToday: 0,
    tasksOpen: 0,
    todosOpen: 0,
    byService: new Map<string, number>()
  })

  useEffect(() => {
    const load = (): void => {
      void window.kontur.items.query({ limit: 2000 }).then((list) => setBadges(computeAttention(list)))
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  const routeKey = (route: Route): string =>
    route.kind === 'page' ? `page:${route.page}` : `service:${route.serviceId}`

  const isOpen = (route: Route): boolean => openKeys.split('|').includes(routeKey(route))
  const isFocused = (route: Route): boolean => focusedKey === routeKey(route)

  const page = (
    p:
      | 'today'
      | 'mail'
      | 'calendar'
      | 'tasks'
      | 'planner'
      | 'notes'
      | 'files'
      | 'bookmarks'
      | 'browser'
      | 'settings'
      | 'terminal'
      | 'assistant'
  ): Route => ({
    kind: 'page',
    page: p
  })

  const hasComms = (config?.services ?? []).some(
    (s) => (s.kind === 'mail' || s.kind === 'calendar') && s.enabled
  )
  const anyTasks = (config?.services ?? []).some((s) => s.kind === 'jira' && s.enabled)
  const envs = (config?.envs ?? []).filter((e) => e.enabled)

  const items: DockItem[] = [
    // «Мой день» теперь живёт виджетами прямо на рабочем столе (см. Desktop.tsx) —
    // открывать его окном как приложение больше не нужно, иконки в доке нет.
    ...(hasComms
      ? [
          {
            title: 'Почта',
            icon: <Badge icon={Mail} count={badges.mailUnread} />,
            open: isOpen(page('mail')),
            focused: isFocused(page('mail')),
            onClick: () => openWindow(page('mail'))
          },
          {
            title: 'Календарь',
            icon: <Badge icon={CalendarDays} count={badges.calendarToday} />,
            open: isOpen(page('calendar')),
            focused: isFocused(page('calendar')),
            onClick: () => openWindow(page('calendar'))
          }
        ]
      : []),
    ...(anyTasks
      ? [
          {
            title: 'Задачи',
            icon: <Badge icon={Kanban} count={badges.tasksOpen} />,
            open: isOpen(page('tasks')),
            focused: isFocused(page('tasks')),
            onClick: () => openWindow(page('tasks'))
          }
        ]
      : []),
    {
      title: 'Планировщик',
      icon: <Badge icon={ListTodo} count={badges.todosOpen} />,
      open: isOpen(page('planner')),
      focused: isFocused(page('planner')),
      onClick: () => openWindow(page('planner'))
    },
    {
      title: 'Заметки',
      icon: <NotebookPen className="h-full w-full text-neutral-700 dark:text-white/95" />,
      open: isOpen(page('notes')),
      focused: isFocused(page('notes')),
      onClick: () => openWindow(page('notes'))
    },
    {
      title: 'Закладки',
      icon: <Bookmark className="h-full w-full text-neutral-700 dark:text-white/95" />,
      open: isOpen(page('bookmarks')),
      focused: isFocused(page('bookmarks')),
      onClick: () => openWindow(page('bookmarks'))
    },
    {
      title: 'Браузер',
      icon: <Globe className="h-full w-full text-neutral-700 dark:text-white/95" />,
      open: isOpen(page('browser')),
      focused: isFocused(page('browser')),
      onClick: () => openWindow(page('browser'))
    },
    {
      title: 'Терминал',
      icon: <TerminalSquare className="h-full w-full text-neutral-700 dark:text-white/95" />,
      open: isOpen(page('terminal')),
      focused: isFocused(page('terminal')),
      onClick: () => openWindow(page('terminal'))
    },
    {
      title: 'Ассистент',
      icon: <Sparkles className="h-full w-full text-neutral-700 dark:text-white/95" />,
      open: isOpen(page('assistant')),
      focused: isFocused(page('assistant')),
      onClick: () => openWindow(page('assistant'))
    },
    // Общие сервисы (Mattermost, Толк…) — порядок как в настройках (`order`).
    ...(() => {
      const shared = (config?.services ?? [])
        .filter(
          (s) =>
            s.envId === 'shared' && s.enabled && s.kind !== 'mail' && s.kind !== 'calendar'
        )
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
      return shared.map((s, i) => {
        const route: Route = { kind: 'service', serviceId: s.id }
        return {
          title: s.name,
          icon: <ServiceIcon serviceId={s.id} kind={s.kind} size={32} />,
          open: isOpen(route),
          focused: isFocused(route),
          separatorBefore: i === 0,
          onClick: () => openWindow(route)
        }
      })
    })(),
    // Сервисы по контурам — почта/календарь уже вынесены отдельными иконками выше.
    ...envs
      .filter((e) => e.id !== 'shared')
      .flatMap((env, envIdx) =>
        (config?.services ?? [])
          .filter(
            (s) =>
              s.envId === env.id && s.enabled && s.kind !== 'mail' && s.kind !== 'calendar'
          )
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
          .map((s, i) => {
            const route: Route = { kind: 'service', serviceId: s.id }
            return {
              title: `${env.short} · ${s.name}`,
              icon: <ServiceIcon serviceId={s.id} kind={s.kind} size={32} />,
              open: isOpen(route),
              focused: isFocused(route),
              separatorBefore: envIdx === 0 ? i === 0 : i === 0,
              onClick: () => openWindow(route)
            }
          })
      )
  ]

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
