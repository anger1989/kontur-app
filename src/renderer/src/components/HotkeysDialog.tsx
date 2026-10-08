import type { JSX } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

type Row = { keys: string; action: string }

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Стол',
    rows: [
      { keys: 'Ctrl + `', action: 'Листать окна вперёд (лента)' },
      { keys: 'Ctrl + ⇧ + `', action: 'Листать окна назад' },
      { keys: '↑ ↓ ← →', action: 'В ленте — выбрать окно' },
      { keys: 'Отпустить Ctrl', action: 'Открыть выбранное окно' },
      { keys: 'Esc', action: 'Закрыть ленту / вернуть окна / закрыть верхнее' },
      { keys: 'Клик по обоям', action: 'Показать стол (окна к краям)' }
    ]
  },
  {
    title: 'Терминал / ассистент',
    rows: [
      { keys: '⌘ T', action: 'Новая вкладка терминала' },
      { keys: '⌘ W', action: 'Закрыть вкладку терминала' }
    ]
  },
  {
    title: 'Отладка',
    rows: [
      { keys: '⌥ ⌘ I', action: 'DevTools текущего вебвью / окна' },
      { keys: 'Ctrl + ⇧ + I', action: 'То же на раскладках без ⌥⌘' }
    ]
  }
]

function Kbd({ children }: { children: string }): JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-white/10',
        'bg-foreground/5 px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground/90'
      )}
    >
      {children}
    </kbd>
  )
}

/**
 * Подсказки горячих клавиш — из кнопки в шапке (трей рядом со светофором).
 */
export function HotkeysDialog(): JSX.Element {
  const open = useStore((s) => s.hotkeysOpen)
  const setHotkeysOpen = useStore((s) => s.setHotkeysOpen)

  return (
    <Dialog open={open} onOpenChange={setHotkeysOpen}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle className="text-sm">Горячие клавиши</DialogTitle>
          <DialogDescription className="text-[12px]">
            На macOS ⌘` часто забирает система — для ленты окон используй Ctrl+`.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {g.title}
              </h3>
              <ul className="space-y-1.5">
                {g.rows.map((r) => (
                  <li
                    key={r.keys + r.action}
                    className="flex items-start justify-between gap-3 text-[12px]"
                  >
                    <span className="min-w-0 flex-1 text-muted-foreground">{r.action}</span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      {r.keys.split(' / ').map((part) => (
                        <span key={part} className="inline-flex flex-wrap items-center gap-1">
                          {part.split(' + ').map((k, i) => (
                            <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
                              {i > 0 ? (
                                <span className="text-[10px] text-muted-foreground/60">+</span>
                              ) : null}
                              <Kbd>{k.trim()}</Kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
