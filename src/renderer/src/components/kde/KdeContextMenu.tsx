import { useState, type JSX, type MouseEvent, type ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * Контекстное меню панели KDE — правый клик по кнопке окна, закреплённому
 * пункту или строке в «Пуске».
 *
 * Построено на Popover: он уже умеет прятать нативные вебвью, пока открыт,
 * иначе меню оказалось бы под окном сервиса. Якорь — сама кнопка, поэтому
 * меню всплывает над панелью, как в Plasma.
 */

export interface KdeMenuEntry {
  label: string
  icon?: ReactNode
  /** Разделитель перед пунктом. */
  separatorBefore?: boolean
  danger?: boolean
  onSelect: () => void
}

export function KdeContextMenu({
  entries,
  side = 'top',
  align = 'start',
  children
}: {
  entries: KdeMenuEntry[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** Кнопка, по правому клику на которой открывается меню. */
  children: (props: { onContextMenu: (e: MouseEvent) => void }) => JSX.Element
}): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {children({
          onContextMenu: (e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen(true)
          }
        })}
      </PopoverAnchor>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className="kde-surface w-56 rounded-[4px] border-kde-line p-1 shadow-[0_14px_40px_-16px_rgb(0_0_0/0.6)]"
      >
        {entries.map((entry) => (
          <div key={entry.label}>
            {entry.separatorBefore && <div className="my-1 h-px bg-kde-line" />}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                entry.onSelect()
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-[12px]',
                entry.danger
                  ? 'text-destructive hover:bg-destructive hover:text-white'
                  : 'text-kde-fg hover:bg-kde-accent hover:text-white'
              )}
            >
              {entry.icon}
              {entry.label}
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
