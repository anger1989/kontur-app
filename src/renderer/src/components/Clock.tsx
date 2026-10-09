import { useEffect, useState, type JSX } from 'react'
import { useReducedMotion } from 'motion/react'
import { SlidingNumber } from '@/components/core/sliding-number'

export function Clock(): JSX.Element {
  const [time, setTime] = useState(() => new Date())
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const interval = window.setInterval(() => setTime(new Date()), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  const label = time.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  return (
    <time
      dateTime={time.toISOString()}
      aria-label={`Текущее время: ${label}`}
      className="inline-flex min-w-[7.25ch] items-center justify-end font-mono text-foreground"
    >
      {reducedMotion ? (
        <span className="tabular-nums" aria-hidden="true">
          {label}
        </span>
      ) : (
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <SlidingNumber value={time.getHours()} padStart />
          <span className="text-muted-foreground/70">:</span>
          <SlidingNumber value={time.getMinutes()} padStart />
          <span className="text-muted-foreground/70">:</span>
          <SlidingNumber value={time.getSeconds()} padStart />
        </span>
      )}
    </time>
  )
}
