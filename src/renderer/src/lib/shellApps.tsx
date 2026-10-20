import { useEffect, useState, type JSX } from 'react'
import {
  Bookmark,
  CalendarDays,
  Globe,
  Kanban,
  ListTodo,
  Mail,
  NotebookPen,
  Settings2,
  TerminalSquare
} from 'lucide-react'
import { computeAttention } from '@shared/attention'
import { ServiceIcon } from '@/components/ServiceIcon'
import { useStore, type Route } from '@/store'

/**
 * Единый список «приложений» рабочего места.
 *
 * Его показывают две оболочки сразу: док macOS (Dock.tsx) и панель KDE с меню
 * «Пуск» (components/kde). Список должен быть один — иначе при добавлении
 * сервиса он появляется только в одном из видов интерфейса.
 */

export interface ShellApp {
  /** `page:mail` / `service:…` — он же ключ окна в сторе. */
  key: string
  title: string
  /** Группа для разделителей в доке и заголовков в «Пуске». */
  groupKey: string
  groupTitle: string
  route: Route
  /** Непрочитанное / открытое — бейдж на иконке. */
  count?: number
  /** Цвет контура — точка рядом с пунктом в «Пуске». */
  accent?: string
  /** Короткое имя контура — префикс в подсказке дока. */
  envShort?: string
  icon: (opts: { size: number; className?: string }) => JSX.Element
}

export interface AttentionBadges {
  mailUnread: number
  todayActive: number
  calendarToday: number
  tasksOpen: number
  todosOpen: number
  byService: Map<string, number>
}

const EMPTY_BADGES: AttentionBadges = {
  mailUnread: 0,
  todayActive: 0,
  calendarToday: 0,
  tasksOpen: 0,
  todosOpen: 0,
  byService: new Map()
}

/** Счётчики требующего внимания — пересобираются на каждое изменение ленты. */
export function useAttentionBadges(): AttentionBadges {
  const [badges, setBadges] = useState<AttentionBadges>(EMPTY_BADGES)

  useEffect(() => {
    const load = (): void => {
      void window.kontur.items.query({ limit: 2000 }).then((list) => setBadges(computeAttention(list)))
    }
    load()
    return window.kontur.items.onChange(load)
  }, [])

  return badges
}

/**
 * Закреплённые на панели KDE пункты.
 *
 * Хранятся в конфиге ключами маршрутов, так что переживают перезапуск и
 * одинаково понятны панели и «Пуску».
 */
export function usePinnedApps(): {
  pinned: string[]
  isPinned: (key: string) => boolean
  toggle: (key: string) => void
} {
  const pinned = useStore((s) => s.config?.kdePinned)
  const patchConfig = useStore((s) => s.patchConfig)
  const list = pinned ?? []

  return {
    pinned: list,
    isPinned: (key) => list.includes(key),
    toggle: (key) => {
      const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
      void patchConfig({ kdePinned: next })
    }
  }
}

export function routeKey(route: Route): string {
  return route.kind === 'page' ? `page:${route.page}` : `service:${route.serviceId}`
}

/** Пункт «Настройки» — в macOS он живёт в строке меню, в KDE в «Пуске». */
export const SETTINGS_APP: ShellApp = {
  key: 'page:settings',
  title: 'Настройки',
  groupKey: 'system',
  groupTitle: 'Система',
  route: { kind: 'page', page: 'settings' },
  icon: ({ size, className }) => <Settings2 size={size} className={className} />
}

/**
 * Страницы приложения и сервисы контуров в порядке дока: сначала почта и
 * календарь (если подключены), потом локальные страницы, затем общие сервисы
 * и сервисы каждого контура в порядке из настроек.
 */
export function useShellApps(): ShellApp[] {
  const config = useStore((s) => s.config)
  const badges = useAttentionBadges()

  const page = (route: Route, title: string, groupTitle = 'Приложения'): Omit<ShellApp, 'icon'> => ({
    key: routeKey(route),
    title,
    groupKey: 'pages',
    groupTitle,
    route
  })

  const hasComms = (config?.services ?? []).some(
    (s) => (s.kind === 'mail' || s.kind === 'calendar') && s.enabled
  )
  const anyTasks = (config?.services ?? []).some((s) => s.kind === 'jira' && s.enabled)
  const envs = (config?.envs ?? []).filter((e) => e.enabled)

  const apps: ShellApp[] = [
    // «Мой день» живёт виджетами прямо на столе (TodayWidgets) — отдельным
    // приложением его не открывают ни в доке, ни в «Пуске».
    ...(hasComms
      ? [
          {
            ...page({ kind: 'page', page: 'mail' }, 'Почта'),
            count: badges.mailUnread,
            icon: ({ size, className }: { size: number; className?: string }) => (
              <Mail size={size} className={className} />
            )
          },
          {
            ...page({ kind: 'page', page: 'calendar' }, 'Календарь'),
            count: badges.calendarToday,
            icon: ({ size, className }: { size: number; className?: string }) => (
              <CalendarDays size={size} className={className} />
            )
          }
        ]
      : []),
    ...(anyTasks
      ? [
          {
            ...page({ kind: 'page', page: 'tasks' }, 'Задачи'),
            count: badges.tasksOpen,
            icon: ({ size, className }: { size: number; className?: string }) => (
              <Kanban size={size} className={className} />
            )
          }
        ]
      : []),
    {
      ...page({ kind: 'page', page: 'planner' }, 'Планировщик'),
      count: badges.todosOpen,
      icon: ({ size, className }) => <ListTodo size={size} className={className} />
    },
    {
      ...page({ kind: 'page', page: 'notes' }, 'Заметки'),
      icon: ({ size, className }) => <NotebookPen size={size} className={className} />
    },
    {
      ...page({ kind: 'page', page: 'bookmarks' }, 'Закладки'),
      icon: ({ size, className }) => <Bookmark size={size} className={className} />
    },
    {
      ...page({ kind: 'page', page: 'browser' }, 'Браузер'),
      icon: ({ size, className }) => <Globe size={size} className={className} />
    },
    {
      ...page({ kind: 'page', page: 'terminal' }, 'Терминал'),
      icon: ({ size, className }) => <TerminalSquare size={size} className={className} />
    },
    // Общие сервисы (Mattermost, Толк…) — порядок как в настройках (`order`).
    ...(config?.services ?? [])
      .filter(
        (s) => s.envId === 'shared' && s.enabled && s.kind !== 'mail' && s.kind !== 'calendar'
      )
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
      .map((s) => ({
        key: `service:${s.id}`,
        title: s.name,
        groupKey: 'shared',
        groupTitle: 'Общие сервисы',
        route: { kind: 'service', serviceId: s.id } as Route,
        count: badges.byService.get(s.id),
        icon: ({ size }: { size: number; className?: string }) => (
          <ServiceIcon serviceId={s.id} kind={s.kind} size={size} />
        )
      })),
    // Сервисы по контурам — почта и календарь уже вынесены отдельными пунктами.
    ...envs
      .filter((e) => e.id !== 'shared')
      .flatMap((env) =>
        (config?.services ?? [])
          .filter(
            (s) => s.envId === env.id && s.enabled && s.kind !== 'mail' && s.kind !== 'calendar'
          )
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
          .map((s) => ({
            key: `service:${s.id}`,
            title: s.name,
            groupKey: env.id,
            groupTitle: env.name,
            route: { kind: 'service', serviceId: s.id } as Route,
            count: badges.byService.get(s.id),
            accent: env.accent,
            envShort: env.short,
            icon: ({ size }: { size: number; className?: string }) => (
              <ServiceIcon serviceId={s.id} kind={s.kind} size={size} />
            )
          }))
      )
  ]

  return apps
}
