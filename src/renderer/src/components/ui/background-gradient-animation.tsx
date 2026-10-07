import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Aceternity BackgroundGradientAnimation — палитра под Kontur (графит + янтарь).
 */
export function BackgroundGradientAnimation({
  gradientBackgroundStart = 'rgb(19, 22, 28)',
  gradientBackgroundEnd = 'rgb(36, 28, 16)',
  firstColor = '240, 154, 5',
  secondColor = '242, 180, 61',
  thirdColor = '255, 255, 255',
  fourthColor = '208, 38, 112',
  fifthColor = '100, 116, 139',
  pointerColor = '240, 154, 5',
  size = '80%',
  blendingValue = 'hard-light',
  children,
  className,
  interactive = true,
  containerClassName
}: {
  gradientBackgroundStart?: string
  gradientBackgroundEnd?: string
  firstColor?: string
  secondColor?: string
  thirdColor?: string
  fourthColor?: string
  fifthColor?: string
  pointerColor?: string
  size?: string
  blendingValue?: string
  children?: ReactNode
  className?: string
  interactive?: boolean
  containerClassName?: string
}): JSX.Element {
  const interactiveRef = useRef<HTMLDivElement>(null)
  const cur = useRef({ x: 0, y: 0 })
  const tg = useRef({ x: 0, y: 0 })
  const [isSafari, setIsSafari] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--gradient-background-start', gradientBackgroundStart)
    root.style.setProperty('--gradient-background-end', gradientBackgroundEnd)
    root.style.setProperty('--first-color', firstColor)
    root.style.setProperty('--second-color', secondColor)
    root.style.setProperty('--third-color', thirdColor)
    root.style.setProperty('--fourth-color', fourthColor)
    root.style.setProperty('--fifth-color', fifthColor)
    root.style.setProperty('--pointer-color', pointerColor)
    root.style.setProperty('--size', size)
    root.style.setProperty('--blending-value', blendingValue)
  }, [
    gradientBackgroundStart,
    gradientBackgroundEnd,
    firstColor,
    secondColor,
    thirdColor,
    fourthColor,
    fifthColor,
    pointerColor,
    size,
    blendingValue
  ])

  useEffect(() => {
    setIsSafari(/^((?!chrome|android).)*safari/i.test(navigator.userAgent))
  }, [])

  useEffect(() => {
    if (!interactive) return
    let raf = 0
    const tick = (): void => {
      cur.current.x += (tg.current.x - cur.current.x) / 20
      cur.current.y += (tg.current.y - cur.current.y) / 20
      if (interactiveRef.current) {
        interactiveRef.current.style.transform = `translate(${Math.round(cur.current.x)}px, ${Math.round(cur.current.y)}px)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [interactive])

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!interactiveRef.current) return
    const rect = interactiveRef.current.getBoundingClientRect()
    tg.current.x = event.clientX - rect.left
    tg.current.y = event.clientY - rect.top
  }

  return (
    <div
      className={cn(
        'relative top-0 left-0 h-screen w-screen overflow-hidden bg-[linear-gradient(40deg,var(--gradient-background-start),var(--gradient-background-end))]',
        containerClassName
      )}
    >
      <svg className="hidden">
        <defs>
          <filter id="blurMe">
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>
      <div className={cn('relative z-10', className)}>{children}</div>
      <div
        className={cn(
          'gradients-container absolute inset-0 h-full w-full blur-lg',
          isSafari ? 'blur-2xl' : '[filter:url(#blurMe)_blur(40px)]'
        )}
      >
        <div
          className={cn(
            'absolute top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)] h-[var(--size)] w-[var(--size)]',
            '[background:radial-gradient(circle_at_center,_rgba(var(--first-color),_0.8)_0,_rgba(var(--first-color),_0)_50%)_no-repeat]',
            '[mix-blend-mode:var(--blending-value)] [transform-origin:center_center]',
            'animate-bg-first opacity-100'
          )}
        />
        <div
          className={cn(
            'absolute top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)] h-[var(--size)] w-[var(--size)]',
            '[background:radial-gradient(circle_at_center,_rgba(var(--second-color),_0.8)_0,_rgba(var(--second-color),_0)_50%)_no-repeat]',
            '[mix-blend-mode:var(--blending-value)] [transform-origin:calc(50%-400px)]',
            'animate-bg-second opacity-100'
          )}
        />
        <div
          className={cn(
            'absolute top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)] h-[var(--size)] w-[var(--size)]',
            '[background:radial-gradient(circle_at_center,_rgba(var(--third-color),_0.8)_0,_rgba(var(--third-color),_0)_50%)_no-repeat]',
            '[mix-blend-mode:var(--blending-value)] [transform-origin:calc(50%+400px)]',
            'animate-bg-third opacity-100'
          )}
        />
        <div
          className={cn(
            'absolute top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)] h-[var(--size)] w-[var(--size)]',
            '[background:radial-gradient(circle_at_center,_rgba(var(--fourth-color),_0.8)_0,_rgba(var(--fourth-color),_0)_50%)_no-repeat]',
            '[mix-blend-mode:var(--blending-value)] [transform-origin:calc(50%-200px)]',
            'animate-bg-fourth opacity-70'
          )}
        />
        <div
          className={cn(
            'absolute top-[calc(50%-var(--size)/2)] left-[calc(50%-var(--size)/2)] h-[var(--size)] w-[var(--size)]',
            '[background:radial-gradient(circle_at_center,_rgba(var(--fifth-color),_0.8)_0,_rgba(var(--fifth-color),_0)_50%)_no-repeat]',
            '[mix-blend-mode:var(--blending-value)] [transform-origin:calc(50%-800px)_calc(50%+800px)]',
            'animate-bg-fifth opacity-100'
          )}
        />
        {interactive && (
          <div
            ref={interactiveRef}
            onMouseMove={handleMouseMove}
            className={cn(
              'absolute -top-1/2 -left-1/2 h-full w-full',
              '[background:radial-gradient(circle_at_center,_rgba(var(--pointer-color),_0.8)_0,_rgba(var(--pointer-color),_0)_50%)_no-repeat]',
              '[mix-blend-mode:var(--blending-value)] opacity-70'
            )}
          />
        )}
      </div>
    </div>
  )
}
