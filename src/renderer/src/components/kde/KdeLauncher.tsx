import { useMemo, useState, type JSX } from 'react'
import { ChevronRight, Keyboard, LogOut, Pin, PinOff, Search, Settings2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SETTINGS_APP, usePinnedApps, useShellApps, type ShellApp } from '@/lib/shellApps'
import { useStore } from '@/store'

/**
 * Меню «Пуск» (Kickoff) панели KDE.
 *
 * Сверху поиск, дальше приложения Kontur одним списком, а сервисы — группами
 * по контурам, которые раскрываются вбок подменю: иначе список уезжает на два
 * экрана, как только в контурах заведено с десяток сервисов.
 *
 * Булавка в строке закрепляет пункт на панели. В подвале — «Выход»,
 * завершающий работу Kontur, как кнопка выхода из сеанса в Plasma.
 */
export function KdeLauncher(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const apps = useShellApps()
  const openWindow = useStore((s) => s.openWindow)
  const setHotkeysOpen = useStore((s) => s.setHotkeysOpen)
  const profile = useStore((s) => s.config?.profile)
  const { isPinned, toggle } = usePinnedApps()

  const q = query.trim().toLowerCase()

  /** Приложения Kontur — всегда плоским списком. */
  const pages = useMemo(
    () => [...apps.filter((a) => a.groupKey === 'pages'), SETTINGS_APP],
    [apps]
  )

  /** Сервисы — группами: общие и по контурам. */
  const serviceGroups = useMemo(() => {
    const out: { key: string; title: string; items: ShellApp[] }[] = []
    for (const app of apps) {
      if (app.groupKey === 'pages') continue
      const last = out[out.length - 1]
      if (last && last.key === app.groupKey) last.items.push(app)
      else out.push({ key: app.groupKey, title: app.groupTitle, items: [app] })
    }
    return out
  }, [apps])

  /** В поиске группы не нужны — отдаём всё одним списком. */
  const found = useMemo(() => {
    if (!q) return []
    return [...pages, ...serviceGroups.flatMap((g) => g.items)].filter(
      (a) => a.title.toLowerCase().includes(q) || a.groupTitle.toLowerCase().includes(q)
    )
  }, [pages, serviceGroups, q])

  const launch = (app: ShellApp): void => {
    setOpen(false)
    setQuery('')
    setOpenGroup(null)
    openWindow(app.route)
  }

  /**
   * Строка меню. Булавку показываем кнопкой по наведению, а не контекстным
   * меню: вложенный поповер внутри открытого «Пуска» закрывал бы его целиком.
   */
  const row = (app: ShellApp, opts?: { subtitle?: string }): JSX.Element => {
    const pinned = isPinned(app.key)
    return (
      <div
        key={app.key}
        className="group/row flex items-center text-[12.5px] text-kde-fg hover:bg-kde-accent hover:text-white"
      >
        <button
          type="button"
          onClick={() => launch(app)}
          title={app.title}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3 text-left"
        >
          <span className="grid size-5 shrink-0 place-items-center">{app.icon({ size: 18 })}</span>
          <span className="min-w-0 flex-1 truncate">
            {app.title}
            {opts?.subtitle && (
              <span className="ml-1.5 text-[11px] opacity-70">{opts.subtitle}</span>
            )}
          </span>
          {app.accent && (
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: app.accent }}
              aria-hidden
            />
          )}
          {app.count ? (
            <span className="shrink-0 rounded-[3px] bg-kde-accent px-1 text-[10px] leading-4 font-semibold text-white tabular-nums group-hover/row:bg-white/25">
              {app.count > 99 ? '99+' : app.count}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => toggle(app.key)}
          title={pinned ? 'Открепить от панели' : 'Закрепить на панели'}
          aria-label={pinned ? 'Открепить от панели' : 'Закрепить на панели'}
          aria-pressed={pinned}
          className={cn(
            'mr-1.5 ml-1 grid size-6 shrink-0 place-items-center rounded-[3px] hover:bg-white/25',
            pinned ? 'opacity-90' : 'opacity-0 group-hover/row:opacity-70'
          )}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      </div>
    )
  }

  const name = profile?.displayName?.trim() || profile?.username?.trim() || 'Kontur'
  const initials = name.slice(0, 1).toUpperCase()

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) {
          setQuery('')
          setOpenGroup(null)
        }
      }}
    >
      <PopoverTrigger
        className={cn(
          'no-drag grid h-11 w-11 shrink-0 place-items-center',
          'text-kde-fg transition-colors hover:bg-kde-hover',
          open && 'bg-kde-active'
        )}
        aria-label="Меню приложений"
        title="Меню приложений"
      >
        <span className="grid size-6 place-items-center rounded-[3px] bg-brand text-[13px] font-bold text-white">
          К
        </span>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={0}
        alignOffset={0}
        className="kde-surface w-[320px] rounded-[4px] border-kde-line p-0 shadow-[0_18px_48px_-18px_rgb(0_0_0/0.55)]"
      >
        <div className="flex items-center gap-2.5 border-b border-kde-line px-3 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">
            {initials}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-kde-fg">{name}</div>
            <div className="truncate text-[11px] text-kde-dim">
              {profile?.username?.trim() || 'Рабочее место Kontur'}
            </div>
          </div>
        </div>

        <div className="border-b border-kde-line p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-kde-dim" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const first = q ? found[0] : pages[0]
                if (first) launch(first)
              }}
              placeholder="Поиск приложений и сервисов"
              className="h-8 rounded-[3px] pl-7 text-[12px]"
            />
          </div>
        </div>

        {q ? (
          <div className="max-h-[340px] overflow-y-auto py-1">
            {found.length ? (
              found.map((app) =>
                row(app, { subtitle: app.groupKey === 'pages' ? undefined : app.groupTitle })
              )
            ) : (
              <div className="px-3 py-6 text-center text-[12px] text-kde-dim">Ничего не найдено</div>
            )}
          </div>
        ) : (
          <>
            <div className="max-h-[260px] overflow-y-auto py-1">{pages.map((app) => row(app))}</div>
            {/* Группы — вне скролла: overflow-y клипал бы подменю, уходящее вбок. */}
            {serviceGroups.length > 0 && (
              <div className="border-t border-kde-line py-1">
                {serviceGroups.map((group) => (
                  <ServiceGroupRow
                    key={group.key}
                    title={group.title}
                    count={group.items.length}
                    accent={group.items[0]?.accent}
                    open={openGroup === group.key}
                    onOpen={() => setOpenGroup(group.key)}
                    onClose={() => setOpenGroup((cur) => (cur === group.key ? null : cur))}
                  >
                    {group.items.map((app) => row(app))}
                  </ServiceGroupRow>
                ))}
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-1 border-t border-kde-line px-2 py-1.5">
          <LauncherAction
            icon={<Settings2 className="size-3.5" />}
            label="Настройки"
            onClick={() => launch(SETTINGS_APP)}
          />
          <LauncherAction
            icon={<Keyboard className="size-3.5" />}
            label="Клавиши"
            onClick={() => {
              setOpen(false)
              setHotkeysOpen(true)
            }}
          />
          <div className="min-w-2 flex-1" />
          <LauncherAction
            icon={<LogOut className="size-3.5" />}
            label="Выход"
            title="Завершить работу Kontur"
            onClick={() => {
              setOpen(false)
              void window.kontur.app.closeWindow()
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Строка группы сервисов с подменю вбок. Подменю лежит внутри строки, поэтому
 * курсор, уехавший на него, всё ещё «над» строкой и меню не захлопывается.
 * Прижато низом к строке — список растёт вверх, в сторону экрана, а не за его
 * нижний край.
 */
function ServiceGroupRow({
  title,
  count,
  accent,
  open,
  onOpen,
  onClose,
  children
}: {
  title: string
  count: number
  accent?: string
  open: boolean
  onOpen: () => void
  onClose: () => void
  children: JSX.Element[]
}): JSX.Element {
  return (
    <div className="relative" onMouseEnter={onOpen} onMouseLeave={onClose}>
      <button
        type="button"
        onClick={() => (open ? onClose() : onOpen())}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-kde-fg',
          open ? 'bg-kde-accent text-white' : 'hover:bg-kde-accent hover:text-white'
        )}
      >
        {accent ? (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: accent }}
            aria-hidden
          />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-kde-dim" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 text-[11px] opacity-70 tabular-nums">{count}</span>
        <ChevronRight className="size-3.5 shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-0 left-full z-10 ml-1 max-h-[340px] w-[240px] overflow-y-auto rounded-[4px] border border-kde-line bg-[rgb(var(--kde-surface))] py-1 shadow-[0_18px_48px_-18px_rgb(0_0_0/0.55)]">
          {children}
        </div>
      )}
    </div>
  )
}

function LauncherAction({
  icon,
  label,
  title,
  onClick
}: {
  icon: JSX.Element
  label: string
  title?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className="flex min-w-0 shrink items-center gap-1.5 rounded-[3px] px-2 py-1 text-[11.5px] text-kde-fg hover:bg-kde-accent hover:text-white"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
