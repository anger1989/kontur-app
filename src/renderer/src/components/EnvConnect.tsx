import type { JSX } from 'react'
import { Loader2, Plug, PlugZap, RefreshCw, SlidersHorizontal, Unplug } from 'lucide-react'
import type { EnvConfig } from '@shared/types'
import { useStore } from '@/store'
import { EnvTunnelCard } from '@/components/EnvTunnelCard'
import { Button } from '@/components/ui/button'
import { managedVpnEnvs, tunnelEnvs, useEnvTunnelActions } from '@/lib/envTunnel'

function relTime(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`
}

/**
 * Подключение контуров: статус туннеля, кнопки «подключить» и «поднять оба».
 * Проверка каждого контура независима — VPN, поднятый во внешнем клиенте,
 * подхватывается сам по health-check URL.
 */
export function EnvConnect({
  onConfigure
}: {
  /** Открыть настройки контура — форма доступов живёт в модалке у вызывающего. */
  onConfigure?: (env: EnvConfig) => void
}): JSX.Element {
  const { config, statuses } = useStore()
  const { busy, probing, probe, connectOne, disconnectOne, connectAll, otpDialog } =
    useEnvTunnelActions()

  const envs = tunnelEnvs(config?.envs)
  const managed = managedVpnEnvs(config?.envs)
  const dualStack = managed.some((e) => e.vpn.kind === 'snx-rs' || e.vpn.kind === 'openvpn')

  return (
    <>
      <div className="mb-3 flex items-start gap-4">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          {dualStack
            ? 'Банк — Check Point, второй контур — snx-rs или Tunnelblick: оба можно держать одновременно.'
            : 'Каждый контур проверяется отдельно. VPN можно поднять и во внешнем клиенте — статус в шапке по адресу проверки.'}
        </p>
        {managed.length > 1 && (
          <Button size="sm" className="shrink-0" disabled={busy !== null} onClick={() => void connectAll()}>
            {busy === '*' ? <Loader2 className="animate-spin" /> : <PlugZap />}
            Поднять оба
          </Button>
        )}
      </div>

      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
          {envs.map((env) => {
            const st = statuses.find((s) => s.envId === env.id)
            const tunnel = st?.tunnel ?? 'unknown'
            const connecting = st?.vpn === 'connecting' || busy === env.id || busy === '*'
            const isProbing = probing === env.id
            const hint = !env.healthCheckUrl
              ? 'Укажите внутренний адрес контура в настройках — без него не видно, поднят ли туннель.'
              : st?.pendingOutbox
                ? `${st.pendingOutbox} действ. ждёт отправки — уйдёт, как только контур поднимется.`
                : tunnel === 'down'
                  ? 'Нажмите «Подключить» — Kontur сам дёргает клиент.'
                  : null
            return (
              <EnvTunnelCard
                key={env.id}
                env={env}
                tunnel={tunnel}
                syncLabel={st?.lastSyncAt ? `Синхронизация ${relTime(st.lastSyncAt)}` : null}
                error={tunnel === 'down' ? (st?.lastError ?? null) : null}
                hint={hint}
                actions={
                  <>
                    {env.vpn.kind !== 'none' && tunnel === 'up' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null && busy !== env.id}
                        onClick={() => void disconnectOne(env)}
                      >
                        {connecting ? <Loader2 className="animate-spin" /> : <Unplug />}
                        Отключить
                      </Button>
                    )}
                    {env.vpn.kind !== 'none' && tunnel !== 'up' && (
                      <Button
                        size="sm"
                        disabled={busy !== null && busy !== env.id}
                        onClick={() => void connectOne(env)}
                      >
                        {connecting ? <Loader2 className="animate-spin" /> : <Plug />}
                        Подключить
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isProbing || !env.healthCheckUrl}
                      onClick={() => void probe(env)}
                    >
                      <RefreshCw className={isProbing ? 'animate-spin' : ''} />
                      Проверить
                    </Button>
                    <span className="flex-1" />
                    {onConfigure && (
                      <Button size="sm" variant="ghost" onClick={() => onConfigure(env)}>
                        <SlidersHorizontal />
                        Настроить
                      </Button>
                    )}
                  </>
                }
              />
            )
          })}
        </div>
      </div>

      {otpDialog}
    </>
  )
}
