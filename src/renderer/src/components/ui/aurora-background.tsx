import type { ComponentProps, JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Aurora Background (Aceternity) — переливающееся северное сияние.
 *
 * Классы оставлены как в оригинале, чтобы компонент можно было сличить с
 * исходником. Отличия — только вынужденные:
 *
 * — обёртка `<main>` и `h-[100vh]` убраны: здесь это фоновый слой внутри
 *   рабочего стола, а не страница. Размер задаёт контейнер;
 * — палитру оригинал берёт из плагина, который вываливает все цвета Tailwind
 *   в CSS-переменные (`--blue-500` и т.п.). Ради одного компонента тянуть
 *   весь палитровый дамп незачем — нужные переменные и `@keyframes aurora`
 *   объявлены в globals.css рядом с остальной Aceternity-анимацией;
 * — добавлен `data-paused`: пока окно скрыто, анимацию держим на паузе,
 *   иначе фон рабочего стола крутится вхолостую (см. AnimatedWallpaper);
 * — в оригинале тёмный вариант у `::after` записан как `after:dark:`. В
 *   Tailwind v4 порядок модификаторов значим, и такая запись собирается в
 *   `…::after:where(.dark, .dark *)` — условие проверяется на самом
 *   псевдоэлементе и не выполняется никогда, из-за чего в тёмной теме поверх
 *   сияния оставался светлый градиент и фон уходил в муть. Правильный
 *   порядок — `dark:after:`.
 */
export interface AuroraBackgroundProps extends ComponentProps<'div'> {
  children?: ReactNode
  /** Высветлять только один угол — как в оригинале. */
  showRadialGradient?: boolean
}

export function AuroraBackground({
  className,
  children,
  showRadialGradient = true,
  ...props
}: AuroraBackgroundProps): JSX.Element {
  return (
    <div
      className={cn(
        'kontur-aurora relative flex flex-col items-center justify-center bg-zinc-50 text-slate-950 transition-bg dark:bg-zinc-900',
        className
      )}
      {...props}
    >
      <div className="absolute inset-0 overflow-hidden">
        <div
          className={cn(
            `
            [--white-gradient:repeating-linear-gradient(100deg,var(--white)_0%,var(--white)_7%,var(--transparent)_10%,var(--transparent)_12%,var(--white)_16%)]
            [--dark-gradient:repeating-linear-gradient(100deg,var(--black)_0%,var(--black)_7%,var(--transparent)_10%,var(--transparent)_12%,var(--black)_16%)]
            [--aurora:repeating-linear-gradient(100deg,var(--blue-500)_10%,var(--indigo-300)_15%,var(--blue-300)_20%,var(--violet-200)_25%,var(--blue-400)_30%)]
            [background-image:var(--white-gradient),var(--aurora)]
            dark:[background-image:var(--dark-gradient),var(--aurora)]
            [background-size:300%,_200%]
            [background-position:50%_50%,50%_50%]
            filter blur-[10px] invert dark:invert-0
            after:content-[""] after:absolute after:inset-0 after:[background-image:var(--white-gradient),var(--aurora)]
            dark:after:[background-image:var(--dark-gradient),var(--aurora)]
            after:[background-size:200%,_100%]
            after:animate-aurora after:[background-attachment:fixed] after:mix-blend-difference
            pointer-events-none
            absolute -inset-[10px] opacity-50 will-change-transform`,
            showRadialGradient &&
              `[mask-image:radial-gradient(ellipse_at_100%_0%,black_10%,var(--transparent)_70%)]`
          )}
        />
      </div>
      {children}
    </div>
  )
}
