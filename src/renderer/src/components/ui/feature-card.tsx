import { motion } from 'motion/react'
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Aceternity «Feature block — animated card» (`@aceternity/cards-demo-3`),
 * переведённый на токены темы Kontur: оригинал прибит к серым neutral-оттенкам
 * и светится белым, здесь — card/border/foreground, чтобы карточка одинаково
 * жила в светлой и тёмной теме.
 *
 * Состав тот же: контейнер с «витриной» (CardSkeletonContainer) под анимацию,
 * заголовок и описание. Сама анимация — дело вызывающего кода.
 */

export function FeatureCard({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={cn(
        'group relative flex w-full flex-col overflow-hidden rounded-xl border bg-card p-5 shadow-sm',
        className
      )}
    >
      {children}
    </div>
  )
}

export function FeatureCardTitle({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <h3 className={cn('text-[15px] font-semibold', className)}>{children}</h3>
}

export function FeatureCardDescription({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <p className={cn('text-[13px] text-muted-foreground', className)}>{children}</p>
}

/**
 * «Витрина» карточки: область под анимацию с радиальной маской, из-за которой
 * содержимое растворяется к краям.
 */
export function FeatureCardStage({
  className,
  children,
  showGradient = true
}: {
  className?: string
  children: ReactNode
  showGradient?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'z-40 rounded-xl',
        showGradient &&
          'bg-muted/50 [mask-image:radial-gradient(50%_50%_at_50%_50%,white_0%,transparent_100%)] dark:bg-white/[0.03]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Кружок-«линза» под иконку: внутренняя подсветка плюс тень снизу. */
export function FeatureCardOrb({
  className,
  children
}: {
  className?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex size-16 items-center justify-center rounded-full bg-foreground/[0.02] shadow-[0px_0px_8px_0px_rgba(0,0,0,0.12)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.12)] dark:shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Искры вокруг луча. Позиции случайны — поэтому две карточки не синхронны. */
export function FeatureCardSparkles({ className }: { className?: string }): JSX.Element {
  const rnd = (): number => Math.random()
  const drift = (): number => Math.random() * 2 - 1
  return (
    <div className="absolute inset-0">
      {Array.from({ length: 12 }, (_, i) => (
        <motion.span
          key={i}
          animate={{
            top: `calc(${rnd() * 100}% + ${drift()}px)`,
            left: `calc(${rnd() * 100}% + ${drift()}px)`,
            opacity: rnd(),
            scale: [1, 1.2, 0]
          }}
          transition={{ duration: rnd() * 2 + 4, repeat: Infinity, ease: 'linear' }}
          style={{
            position: 'absolute',
            top: `${rnd() * 100}%`,
            left: `${rnd() * 100}%`,
            width: 2,
            height: 2,
            borderRadius: '50%',
            zIndex: 1
          }}
          className={cn('inline-block bg-foreground/60', className)}
        />
      ))}
    </div>
  )
}
