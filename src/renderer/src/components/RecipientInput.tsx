import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { CalendarPerson } from '@shared/types'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Разделители адресов в строке получателей — как в Outlook: запятая или точка с запятой. */
const SEPARATOR = /[,;]/

/** Индекс конца уже введённых адресов (после последнего разделителя). */
function headEnd(value: string): number {
  let last = -1
  for (let i = 0; i < value.length; i++) if (SEPARATOR.test(value[i]!)) last = i
  return last + 1
}

/** Адреса, которые уже в строке — их не предлагаем повторно. */
function takenEmails(value: string): Set<string> {
  const out = new Set<string>()
  for (const m of value.toLowerCase().matchAll(/[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}/g)) out.add(m[0])
  return out
}

/**
 * Поле «Кому/Копия» с подсказками из адресной книги (main/contacts): кому
 * писали, с кем встречались, общая книга Exchange (GAL). Значение — обычная
 * строка адресов через запятую, как и раньше: отправка писем не меняется.
 */
export function RecipientInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}): JSX.Element {
  const [items, setItems] = useState<CalendarPerson[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const focused = useRef(false)
  const seq = useRef(0)

  const token = value.slice(headEnd(value)).trim()

  useEffect(() => {
    // Готовый адрес («кто-то@домен.ру») — дописали руками, подсказывать нечего.
    if (!token || /@[^@\s]+\.[a-z]{2,}$/i.test(token)) {
      setItems([])
      setOpen(false)
      return
    }
    const id = ++seq.current
    const t = setTimeout(() => {
      void window.kontur.contacts
        .suggest(token, 8)
        .then((list) => {
          // Пока GAL отвечал, текст уже изменился — этот ответ устарел.
          if (id !== seq.current) return
          const taken = takenEmails(value)
          const next = list.filter((p) => !taken.has(p.email))
          setItems(next)
          setActive(0)
          setOpen(focused.current && next.length > 0)
        })
        .catch(() => {})
    }, 150)
    return () => clearTimeout(t)
    // value целиком не в зависимостях: интересен только набираемый адрес.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const pick = (p: CalendarPerson): void => {
    const head = value.slice(0, headEnd(value)).trimEnd()
    onChange(`${head ? `${head} ` : ''}${p.email}, `)
    setOpen(false)
    setItems([])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!open || !items.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(items[active]!)
    } else if (e.key === 'Escape') {
      // preventDefault — чтобы Esc закрыл только список, а не окно почты (Desktop.tsx).
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          focused.current = true
          if (items.length) setOpen(true)
        }}
        onBlur={() => {
          focused.current = false
          setOpen(false)
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={className}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <ul
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((p, i) => (
            <li
              key={p.email}
              role="option"
              aria-selected={i === active}
              // mousedown, а не click: иначе input теряет фокус раньше и список закрывается.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px]',
                i === active && 'bg-accent text-accent-foreground'
              )}
            >
              {/* В две строки: панель письма узкая, в одну строку адрес обрезался. */}
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{p.email}</span>
              </span>
              {p.source === 'gal' && (
                <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground uppercase">
                  GAL
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
