import { useEffect, useState, type JSX } from 'react'
import { Keyboard, LayoutGrid, Settings2, type LucideIcon } from 'lucide-react'
import { useStore } from '@/store'
import { EnvStatusMenu, EnvTrayConnectBridge } from '@/components/EnvStatusMenu'
import type { TunnelState } from '@shared/types'
import { cn } from '@/lib/utils'
import { managedVpnEnvs } from '@/lib/envTunnel'
import { Clock } from '@/components/Clock'
import { Button } from '@/components/ui/button'
import { HoverBorderRing } from '@/components/ui/hover-border-gradient'

function TrayButton({
  title,
  icon: Icon,
  active,
  onClick
}: {
  title: string
  icon: LucideIcon
  active?: boolean
  onClick: () => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? 'secondary' : 'ghost'}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="size-7 border-transparent text-muted-foreground shadow-none hover:bg-brand-soft hover:text-brand"
    >
      <Icon className="size-4" strokeWidth={1.75} />
      <HoverBorderRing active={hovered || Boolean(active)} tone="amber" width={1} />
    </Button>
  )
}

/**
 * Верхняя полоса — как строка меню в macOS, а не панель приложения.
 *
 * Крошки, кнопки «назад/обновить» и прочее переехали в шапки самих окон
 * (см. Window.tsx) — здесь зона перетаскивания под светофор, трей с
 * «Разложить окна»/«Настройки» сразу после него, статус контуров и часы.
 */
export function TitleBar(): JSX.Element {
  const config = useStore((s) => s.config)
  const statuses = useStore((s) => s.statuses)
  const openWindow = useStore((s) => s.openWindow)
  const arrangeWindows = useStore((s) => s.arrangeWindows)
  const setHotkeysOpen = useStore((s) => s.setHotkeysOpen)
  const arranged = useStore((s) => s.arranged)
  const hasOpenWindows = useStore((s) => s.windows.some((w) => !w.minimized))
  const [now, setNow] = useState(() => new Date())
  const [layout, setLayout] = useState<{ short: string; name: string } | null>(null)
  /** Fullscreen — нативный светофор скрыт, кнопки уезжают влево. При zoom/maximize светофор остаётся. */
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    void window.kontur.keyboard.layout().then((l) => setLayout({ short: l.short, name: l.name }))
    return window.kontur.keyboard.onLayoutChange((l) => setLayout({ short: l.short, name: l.name }))
  }, [])

  useEffect(() => {
    return window.kontur.app.onMaximizedChange(setFullScreen)
  }, [])

  const date = now.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })

  // Только VPN-контуры — «Общие» в шапку статуса не тащим.
  const envs = managedVpnEnvs(config?.envs)

  /** Размер стола берём в момент клика — тот же приём, что раньше был в Dock.tsx. */
  const runArrange = (): void => {
    const el = document.querySelector('[data-desktop-root]')
    const r = el?.getBoundingClientRect()
    if (!r) return
    arrangeWindows({ width: r.width, height: r.height })
  }

  return (
    // Светофор нативный (trafficLightPosition x:14 y:14): ~66px справа от края.
    // В fullscreen он пропадает — pl сжимаем. Zoom/maximize (двойной клик
    // по шапке) светофор оставляет — отступ не трогаем, иначе иконки залезают под него.
    <header
      className={cn(
        'drag flex h-10 shrink-0 items-center border-b border-brand/10 bg-sidebar/78 pr-4 shadow-[inset_0_1px_rgb(255_255_255/0.06),inset_0_-1px_rgb(245_158_11/0.08),0_8px_28px_-20px_rgb(245_158_11/0.5)] backdrop-blur-2xl transition-[padding] duration-200',
        fullScreen ? 'pl-3' : 'pl-[80px]'
      )}
    >
      <div className="no-drag flex items-center gap-1">
        <TrayButton
          title="Настройки"
          icon={Settings2}
          onClick={() => openWindow({ kind: 'page', page: 'settings' })}
        />
        {hasOpenWindows && (
          <TrayButton
            title={arranged ? 'Вернуть как было' : 'Разложить окна'}
            icon={LayoutGrid}
            active={arranged}
            onClick={runArrange}
          />
        )}
        <TrayButton
          title="Горячие клавиши"
          icon={Keyboard}
          onClick={() => setHotkeysOpen(true)}
        />
      </div>
      <div className="flex-1" />
      <div className="no-drag flex items-center gap-3 text-[12px] tabular-nums select-none">
        {layout && (
          <span
            className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-sidebar-foreground"
            title={`Раскладка: ${layout.name}`}
          >
            {layout.short}
          </span>
        )}
        {envs.length > 0 && (
          <div className="flex items-center gap-2">
            {layout && <span className="text-muted-foreground/40">·</span>}
            {envs.map((env) => {
              const tunnel = (statuses.find((s) => s.envId === env.id)?.tunnel ?? 'unknown') as TunnelState
              return <EnvStatusMenu key={env.id} env={env} tunnel={tunnel} />
            })}
            <span className="text-muted-foreground/40">·</span>
          </div>
        )}
        {!envs.length && layout && <span className="text-muted-foreground/40">·</span>}
        <span className="text-muted-foreground">{date}</span>
        <span className="text-muted-foreground/40">·</span>
        <Clock />
      </div>
      <EnvTrayConnectBridge />
    </header>
  )
}
