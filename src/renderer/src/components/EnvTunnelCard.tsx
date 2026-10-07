import { useEffect, type JSX } from 'react'
import { useAnimate } from 'motion/react'
import { Globe, Laptop, Lock, Server, Wifi } from 'lucide-react'
import type { EnvConfig, TunnelState } from '@shared/types'
import {
  FeatureCard,
  FeatureCardDescription,
  FeatureCardOrb,
  FeatureCardSparkles,
  FeatureCardStage,
  FeatureCardTitle
} from '@/components/ui/feature-card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * Карточка контура в стиле Aceternity «feature block»: в витрине — путь до
 * контура (ноутбук → VPN → контур), по которому пробегает луч. Пока туннель не
 * поднят, цепочка замирает и гаснет — состояние видно до чтения текста.
 */

const TUNNEL_LABEL: Record<TunnelState, string> = {
  up: 'Контур доступен',
  down: 'Туннель не поднят',
  checking: 'Проверяем…',
  unknown: 'Проверка не настроена'
}

function TunnelFlow({ accent, live }: { accent: string; live: boolean }): JSX.Element {
  const [scope, animate] = useAnimate()

  useEffect(() => {
    if (!live) return
    // Селекторы ограничены scope — иначе пульс ловили бы кружки соседних карточек.
    const scale = [1, 1.1, 1]
    const transform = ['translateY(0px)', 'translateY(-4px)', 'translateY(0px)']
    const controls = animate(
      [1, 2, 3, 4, 5].map((n) => [`.orb-${n}`, { scale, transform }, { duration: 0.8 }]),
      { repeat: Infinity, repeatDelay: 1 }
    )
    return () => controls.stop()
  }, [animate, live])

  return (
    <div
      ref={scope}
      className={cn(
        'relative flex h-full items-center justify-center overflow-hidden p-6 transition-opacity',
        live ? 'opacity-100' : 'opacity-45 grayscale'
      )}
    >
      <div className="flex shrink-0 flex-row items-center justify-center gap-2">
        <FeatureCardOrb className="orb-1 size-8">
          <Laptop className="size-4 text-muted-foreground" />
        </FeatureCardOrb>
        <FeatureCardOrb className="orb-2 size-12">
          <Wifi className="size-5 text-muted-foreground" />
        </FeatureCardOrb>
        <FeatureCardOrb className="orb-3">
          <Lock className="size-7" style={{ color: accent }} />
        </FeatureCardOrb>
        <FeatureCardOrb className="orb-4 size-12">
          <Globe className="size-5 text-muted-foreground" />
        </FeatureCardOrb>
        <FeatureCardOrb className="orb-5 size-8">
          <Server className="size-4 text-muted-foreground" />
        </FeatureCardOrb>
      </div>

      {live && (
        <div
          className="absolute top-6 z-40 m-auto h-28 w-px animate-card-beam"
          style={{ background: `linear-gradient(to bottom, transparent, ${accent}, transparent)` }}
        >
          <div className="absolute top-1/2 -left-10 h-24 w-10 -translate-y-1/2">
            <FeatureCardSparkles />
          </div>
        </div>
      )}
    </div>
  )
}

export function EnvTunnelCard({
  env,
  tunnel,
  syncLabel,
  error,
  hint,
  actions
}: {
  env: EnvConfig
  tunnel: TunnelState
  syncLabel: string | null
  error: string | null
  hint: string | null
  actions: JSX.Element
}): JSX.Element {
  const up = tunnel === 'up'
  return (
    <FeatureCard>
      <FeatureCardStage className="h-36">
        <TunnelFlow accent={env.accent} live={up} />
      </FeatureCardStage>

      <div className="mt-3 flex items-center gap-2">
        <FeatureCardTitle>{env.name}</FeatureCardTitle>
        <Badge variant="outline" style={{ color: env.accent, borderColor: `${env.accent}55` }}>
          {env.short}
        </Badge>
        <span className="flex-1" />
        <span
          className={cn(
            'text-xs font-medium',
            up ? 'text-success' : tunnel === 'down' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {TUNNEL_LABEL[tunnel]}
        </span>
      </div>

      {/* Высота зафиксирована: иначе соседние карточки в сетке разъезжаются,
          когда у одной есть текст ошибки, а у другой нет. */}
      <div className="mt-1 min-h-8 space-y-0.5">
        {syncLabel && <p className="text-xs text-muted-foreground tabular-nums">{syncLabel}</p>}
        {error && <p className="text-xs leading-relaxed text-destructive">{error}</p>}
        {hint && <FeatureCardDescription className="text-xs leading-relaxed">{hint}</FeatureCardDescription>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
    </FeatureCard>
  )
}
