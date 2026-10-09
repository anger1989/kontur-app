import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type JSX, type ReactNode } from 'react'
import { createNoise3D } from 'simplex-noise'
import { cn } from '@/lib/utils'

const DEFAULT_WAVE_COLORS = ['#38bdf8', '#818cf8', '#c084fc', '#e879f9', '#22d3ee']

interface WavyBackgroundProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode
  containerClassName?: string
  colors?: string[]
  waveWidth?: number
  backgroundFill?: string
  blur?: number
  speed?: 'slow' | 'fast'
  waveOpacity?: number
}

/**
 * Фоновая canvas-анимация для splash/screensaver. Цикл останавливается, когда
 * окно скрыто, а при reduced motion рисуется один статичный кадр.
 */
export function WavyBackground({
  children,
  className,
  containerClassName,
  colors,
  waveWidth = 50,
  backgroundFill = 'black',
  blur = 10,
  speed = 'fast',
  waveOpacity = 0.5,
  ...props
}: WavyBackgroundProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const noise = useMemo(() => createNoise3D(), [])
  const palette = colors ?? DEFAULT_WAVE_COLORS
  const [isSafari] = useState(
    () => navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    const ctx = canvas?.getContext('2d')
    if (!canvas || !container || !ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let width = 0
    let height = 0
    let tick = 0
    let animationId: number | null = null

    const resize = (): void => {
      const rect = container.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.filter = `blur(${blur}px)`
    }

    const draw = (): void => {
      tick += speed === 'fast' ? 0.002 : 0.001
      ctx.globalAlpha = waveOpacity
      ctx.fillStyle = backgroundFill
      ctx.fillRect(0, 0, width, height)

      for (let wave = 0; wave < 5; wave += 1) {
        ctx.beginPath()
        ctx.lineWidth = waveWidth
        ctx.strokeStyle = palette[wave % palette.length] ?? DEFAULT_WAVE_COLORS[0]!
        for (let x = 0; x < width; x += 5) {
          const y = noise(x / 800, 0.3 * wave, tick) * 100
          ctx.lineTo(x, y + height * 0.5)
        }
        ctx.stroke()
      }
    }

    const stop = (): void => {
      if (animationId != null) cancelAnimationFrame(animationId)
      animationId = null
    }
    const frame = (): void => {
      draw()
      animationId = requestAnimationFrame(frame)
    }
    const syncAnimation = (): void => {
      stop()
      draw()
      if (document.visibilityState === 'visible' && !reducedMotion.matches) {
        animationId = requestAnimationFrame(frame)
      }
    }

    resize()
    syncAnimation()
    const observer = new ResizeObserver(() => {
      resize()
      if (animationId == null) draw()
    })
    observer.observe(container)
    document.addEventListener('visibilitychange', syncAnimation)
    reducedMotion.addEventListener('change', syncAnimation)

    return () => {
      stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', syncAnimation)
      reducedMotion.removeEventListener('change', syncAnimation)
    }
  }, [backgroundFill, blur, noise, palette, speed, waveOpacity, waveWidth])

  return (
    <div className={cn('flex h-screen flex-col items-center justify-center', containerClassName)}>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 z-0 size-full"
        style={isSafari ? { filter: `blur(${blur}px)` } : undefined}
      />
      <div className={cn('relative z-10', className)} {...props}>
        {children}
      </div>
    </div>
  )
}
