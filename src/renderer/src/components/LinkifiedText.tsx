import type { JSX, MouseEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { openLink } from '@/lib/openLink'

const URL_RE = /(https?:\/\/[^\s<>"'`)\]}]+)/gi

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/g, '')
}

/**
 * Текст со ссылками. Толк → настроенный сервис в Kontur, остальное — в ОС.
 */
export function LinkifiedText({
  text,
  className
}: {
  text: string
  className?: string
}): JSX.Element {
  const parts = text.split(URL_RE)
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (/^https?:\/\//i.test(part)) {
          const href = trimUrl(part)
          const trailing = part.slice(href.length)
          return (
            <span key={i}>
              <a
                href={href}
                className="text-primary underline-offset-2 hover:underline break-all"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  openLink(href)
                }}
              >
                {href}
              </a>
              {trailing}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

/** Клики по &lt;a&gt; в HTML письма/описания — Толк в сервис, остальное наружу. */
export function interceptHtmlLinks(e: MouseEvent<HTMLElement>): void {
  const a = (e.target as HTMLElement | null)?.closest?.('a')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('mailto:')) return
  e.preventDefault()
  e.stopPropagation()
  openLink(href)
}

export function HtmlWithExternalLinks({
  html,
  className
}: {
  html: string
  className?: string
}): JSX.Element {
  return (
    <div
      className={className}
      onClick={interceptHtmlLinks}
      // HTML с корпоративного сервера — скрипты вырезаны снаружи.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? 'default' : 'outline'}
      onClick={onClick}
      className="h-7 px-2.5 text-[12px]"
    >
      {children}
    </Button>
  )
}
