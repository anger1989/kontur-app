import { useRef, type JSX } from 'react'
import { Maximize2, RotateCcw } from 'lucide-react'
import { LiveTerminal } from '@/components/ui/terminal'
import { WidgetHeader } from '@/components/ui/stats-card'
import { useStore } from '@/store'
import { ASSISTANT_SESSION_KEY } from '@/lib/assistantSession'
import { cn } from '@/lib/utils'

/**
 * Виджет Cursor Agent: сразу живая PTY-сессия `agent`.
 * Шеврон / Maximize отделяет сам виджет в окно. Пока окно открыто, карточка
 * на столе не рисуется (см. TodayWidgets), а общая PTY-сессия сохраняет историю.
 */
export function AssistantWidget({ bare }: { bare?: boolean } = {}): JSX.Element {
  const openWindow = useStore((s) => s.openWindow)
  const restartAssistant = useStore((s) => s.restartAssistant)
  const restartToken = useStore((s) => s.assistantRestartSeq)
  const root = useRef<HTMLDivElement>(null)

  const expand = (): void => {
    const card = root.current?.closest<HTMLElement>('[data-widget-card]')
    const desktop = root.current?.closest<HTMLElement>('[data-desktop-root]')
    const c = card?.getBoundingClientRect()
    const d = desktop?.getBoundingClientRect()
    openWindow(
      { kind: 'page', page: 'assistant' },
      c && d
        ? {
            x: Math.round(c.x - d.x),
            y: Math.round(c.y - d.y),
            width: Math.round(c.width),
            height: Math.round(c.height)
          }
        : undefined
    )
  }

  return (
    <div ref={root} className={cn('flex flex-col gap-2 p-3', bare && 'pt-2')}>
      <WidgetHeader
        title="Ассистент"
      >
        <button
          type="button"
          title="Перезапустить agent"
          aria-label="Перезапустить agent"
          onClick={() => restartAssistant()}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
        </button>
        <button
          type="button"
          title="Отделить в окно"
          aria-label="Отделить в окно"
          onClick={expand}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </WidgetHeader>

      <div className="relative h-[280px] overflow-hidden rounded-xl ring-1 ring-black/20 dark:ring-white/10">
        <LiveTerminal
          className="h-full"
          fontSize={13}
          sessionKey={ASSISTANT_SESSION_KEY}
          profile="agent"
          keepAlive
          restartToken={restartToken}
          active
        />
      </div>
    </div>
  )
}
