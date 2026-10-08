import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { Loader2, Lock, LockOpen, Plug, PlugZap, RefreshCw, Settings2, Unplug } from 'lucide-react'
import type { EnvConfig, TunnelState } from '@shared/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { managedVpnEnvs, TUNNEL_LABEL, useEnvTunnelActions } from '@/lib/envTunnel'
import { useStore } from '@/store'

/** VPN-замочек цвета контура: закрытый = up, открытый = down. */
function EnvLock({
  accent,
  tunnel
}: {
  accent: string
  tunnel: TunnelState
}): JSX.Element {
  const up = tunnel === 'up'
  const Icon = up ? Lock : LockOpen
  return (
    <Icon
      className={cn('size-3.5 shrink-0', tunnel === 'checking' && 'animate-pulse')}
      strokeWidth={2.25}
      style={{
        color: up ? accent : `color-mix(in srgb, ${accent} 45%, transparent)`,
        opacity: tunnel === 'unknown' ? 0.45 : 1
      }}
    />
  )
}

function MenuRow({
  disabled,
  onClick,
  children
}: {
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
        'hover:bg-accent hover:text-accent-foreground',
        'disabled:pointer-events-none disabled:opacity-40'
      )}
    >
      {children}
    </button>
  )
}

/**
 * Клик по контуру в шапке — меню с теми же действиями, что в настройках:
 * подключить / отключить / проверить (+ «поднять оба» и «настроить»).
 */
export function EnvStatusMenu({
  env,
  tunnel
}: {
  env: EnvConfig
  tunnel: TunnelState
}): JSX.Element {
  const config = useStore((s) => s.config)
  const openEnvEditor = useStore((s) => s.openEnvEditor)
  const [open, setOpen] = useState(false)
  const { busy, probing, probe, connectOne, disconnectOne, connectAll, otpDialog } =
    useEnvTunnelActions()

  const connecting = busy === env.id || busy === '*'
  const isProbing = probing === env.id
  const managed = managedVpnEnvs(config?.envs)
  const canVpn = env.vpn.kind !== 'none'
  const up = tunnel === 'up'

  const run = (fn: () => Promise<unknown>): void => {
    setOpen(false)
    void fn()
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors',
              'hover:bg-foreground/10',
              tunnel === 'up' ? 'text-foreground' : 'text-muted-foreground'
            )}
            title={
              tunnel === 'up'
                ? `${env.name}: контур доступен — меню`
                : tunnel === 'checking'
                  ? `${env.name}: проверяем…`
                  : tunnel === 'down'
                    ? `${env.name}: недоступен — меню`
                    : `${env.name}: ${TUNNEL_LABEL.unknown} — меню`
            }
          >
            <EnvLock accent={env.accent} tunnel={tunnel} />
            <span className="font-medium tracking-wide uppercase">{env.short}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-1.5" sideOffset={8}>
          <div className="px-2 py-1.5">
            <div className="text-[12px] font-medium">{env.name}</div>
            <div className="text-[11px] text-muted-foreground">{TUNNEL_LABEL[tunnel]}</div>
          </div>
          <div className="my-1 h-px bg-border" />
          {canVpn && up && (
            <MenuRow disabled={busy !== null} onClick={() => run(() => disconnectOne(env))}>
              {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
              Отключить
            </MenuRow>
          )}
          {canVpn && !up && (
            <MenuRow disabled={busy !== null} onClick={() => run(() => connectOne(env))}>
              {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
              Подключить
            </MenuRow>
          )}
          <MenuRow
            disabled={isProbing || !env.healthCheckUrl}
            onClick={() => run(() => probe(env))}
          >
            <RefreshCw className={cn('size-3.5', isProbing && 'animate-spin')} />
            Проверить
          </MenuRow>
          {managed.length > 1 && (
            <MenuRow disabled={busy !== null} onClick={() => run(() => connectAll())}>
              {busy === '*' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <PlugZap className="size-3.5" />
              )}
              Поднять оба
            </MenuRow>
          )}
          <div className="my-1 h-px bg-border" />
          <MenuRow
            onClick={() => {
              setOpen(false)
              openEnvEditor(env.id)
            }}
          >
            <Settings2 className="size-3.5" />
            Настроить…
          </MenuRow>
        </PopoverContent>
      </Popover>
      {otpDialog}
    </>
  )
}

/**
 * Запросы из трея, где нужен UI (OTP) или фокус окна: connect / connectBoth.
 */
export function EnvTrayConnectBridge(): JSX.Element {
  const config = useStore((s) => s.config)
  const { connectOne, connectAll, otpDialog } = useEnvTunnelActions()

  useEffect(() => {
    return window.kontur.env.onTrayAction((action) => {
      if (action.kind === 'connectBoth') {
        void connectAll()
        return
      }
      const env = config?.envs.find((e) => e.id === action.envId)
      if (!env) return
      if (action.kind === 'connect') void connectOne(env)
    })
  }, [config?.envs, connectAll, connectOne])

  return <>{otpDialog}</>
}
