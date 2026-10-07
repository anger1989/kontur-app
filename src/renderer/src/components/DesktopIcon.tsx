import { useState, type JSX } from 'react'
import { Folder } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

/**
 * Иконка прямо на рабочем столе — как в Finder: один клик выделяет, двойной
 * открывает. Файловый менеджер лежит тут, а не в доке — это не часто
 * открываемое приложение, а, скорее, «место» на столе.
 */
export function DesktopIcon(): JSX.Element {
  const openWindow = useStore((s) => s.openWindow)
  const [selected, setSelected] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setSelected(true)}
      onBlur={() => setSelected(false)}
      onDoubleClick={() => openWindow({ kind: 'page', page: 'files' })}
      className={cn(
        // cursor-default: значок на столе — не ссылка/кнопка, курсор как у ОС (стрелка), не поинтер.
        'no-drag absolute top-4 left-4 flex w-20 cursor-default flex-col items-center gap-1 rounded-lg p-2 text-center outline-none select-none',
        selected && 'bg-white/15 backdrop-blur-sm'
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-xl border border-white/20 bg-gradient-to-b from-white/35 to-white/10 text-neutral-700 shadow-inner dark:text-white/95">
        <Folder className="size-7" />
      </span>
      <span className="text-[11px] font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">Файлы</span>
    </button>
  )
}
