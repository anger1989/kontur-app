import { useEffect, useState, type JSX } from 'react'
import { LayoutGrid, Settings2, type LucideIcon } from 'lucide-react'
import { useStore } from '@/store'
import { EnvStatusMenu, EnvTrayConnectBridge } from '@/components/EnvStatusMenu'
import type { TunnelState } from '@shared/types'
import { cn } from '@/lib/utils'
import { HoverBorderRing } from '@/components/ui/hover-border-gradient'
import { managedVpnEnvs } from '@/lib/envTunnel'

/**
 * Кнопка трея в шапке. Не ghost-Button: у того непрозрачный bg-background
 * (на полупрозрачной шапке виден квадратиком) и подпрыгивание на hover —
 * в строке рядом со светофором иконки должны стоять ровно, как в macOS.
 */
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
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'relative flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-foreground/10 hover:text-foreground',
        active && 'bg-foreground/10 text-foreground'
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      <HoverBorderRing active={hovered} />
    </button>
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
  const arranged = useStore((s) => s.arranged)
  const hasOpenWindows = useStore((s) => s.windows.some((w) => !w.minimized))
  const [now, setNow] = useState(() => new Date())
  const [layout, setLayout] = useState<{ short: string; name: string } | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    void window.kontur.keyboard.layout().then((l) => setLayout({ short: l.short, name: l.name }))
    return window.kontur.keyboard.onLayoutChange((l) => setLayout({ short: l.short, name: l.name }))
  }, [])

  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
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
    // Светофор нативный (trafficLightPosition x:14 y:14 в main/index.ts): заканчивается
    // около 66px, центр по вертикали — 20px. pl-[80px] + внутренний отступ кнопки дают
    // ~20px до первой иконки. Нижняя линия — inset-тенью, а не border-b: бордер
    // съедает 1px высоты, и центр иконок уезжал на 19.5px мимо центра светофора.
    <header className="drag flex h-10 shrink-0 items-center bg-sidebar/55 pr-4 pl-[80px] shadow-[inset_0_-1px_0_rgb(255_255_255/0.1)] backdrop-blur-2xl">
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
      </div>
      <div className="flex-1" />
      <div className="no-drag flex items-center gap-3 text-[12px] tabular-nums select-none">
        {layout && (
          <span
            className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-white/10 bg-foreground/5 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-foreground"
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
        <span className="text-muted-foreground">
          {date} · {time}
        </span>
      </div>
      <EnvTrayConnectBridge />
    </header>
  )
}
