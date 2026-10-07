import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { CalendarIcon } from 'lucide-react'
import { ru } from 'react-day-picker/locale'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { HoverBorderRing } from '@/components/ui/hover-border-gradient'
import { cn } from '@/lib/utils'

/**
 * Дата и время: календарь shadcn/ui (react-day-picker) + колонка времени.
 * Значение — та же строка `YYYY-MM-DDTHH:mm` (локальное время), что отдавал
 * нативный `<input type="datetime-local">`, поэтому замена один в один.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

function parse(value: string): Date | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t)
}

function format(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Слоты времени с шагом 15 минут + текущее время значения, если оно вне сетки. */
function timeSlots(current: Date | null): string[] {
  const out: string[] = []
  for (let m = 0; m < 24 * 60; m += 15) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  if (current) {
    const cur = `${pad(current.getHours())}:${pad(current.getMinutes())}`
    if (!out.includes(cur)) {
      out.push(cur)
      out.sort()
    }
  }
  return out
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = 'Выберите дату и время',
  className
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const date = parse(value)
  const slots = useMemo(() => timeSlots(date), [value])
  const currentTime = date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : null
  const timeList = useRef<HTMLDivElement>(null)

  // Выбранное время — сразу в зоне видимости, а не 00:00 сверху списка.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      timeList.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => window.clearTimeout(id)
  }, [open])

  const pickDay = (day: Date | undefined): void => {
    if (!day) return
    const next = new Date(day)
    // Время сохраняем прежним; если его не было — 10:00, как новая встреча.
    next.setHours(date ? date.getHours() : 10, date ? date.getMinutes() : 0, 0, 0)
    onChange(format(next))
  }

  const pickTime = (t: string): void => {
    const [h, m] = t.split(':').map(Number)
    const next = date ? new Date(date) : new Date()
    next.setHours(h ?? 0, m ?? 0, 0, 0)
    onChange(format(next))
    setOpen(false)
  }

  const label = date
    ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Вид как у Input (та же рамка и hover-кольцо), но открывает календарь. */}
        <button
          type="button"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className={cn(
            'relative flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none dark:bg-input/30',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            !date && 'text-muted-foreground',
            className
          )}
        >
          <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate tabular-nums">{label}</span>
          <HoverBorderRing active={hovered} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          <Calendar
            mode="single"
            locale={ru}
            weekStartsOn={1}
            selected={date ?? undefined}
            defaultMonth={date ?? undefined}
            onSelect={pickDay}
          />
          <div ref={timeList} className="max-h-[300px] w-20 overflow-y-auto border-l p-1">
            {slots.map((t) => (
              <button
                key={t}
                type="button"
                data-selected={t === currentTime}
                onClick={() => pickTime(t)}
                className={cn(
                  'w-full rounded-md px-2 py-1 text-center text-[13px] tabular-nums transition-colors hover:bg-accent',
                  t === currentTime && 'bg-primary text-primary-foreground hover:bg-primary'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
