import { type JSX } from 'react'
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react'
import { LiveTerminal } from '@/components/ui/terminal'
import { WidgetHeader } from '@/components/ui/stats-card'
import { useStore } from '@/store'
import { ASSISTANT_SESSION_KEY } from '@/lib/assistantSession'
import { cn } from '@/lib/utils'

/**
 * Виджет Cursor Agent: сразу живая PTY-сессия `agent`.
 * Шеврон / Maximize — в окно; из окна можно свернуть обратно сюда.
 * Сессия общая (sessionKey) — история не теряется.
 */
export function AssistantWidget({ bare }: { bare?: boolean } = {}): JSX.Element {
  const openWindow = useStore((s) => s.openWindow)
  const closeWindow = useStore((s) => s.closeWindow)
  const restartAssistant = useStore((s) => s.restartAssistant)
  const restartToken = useStore((s) => s.assistantRestartSeq)
  const expandedWinId = useStore((s) => {
    const w = s.windows.find(
      (x) => x.route.kind === 'page' && x.route.page === 'assistant' && !x.minimized
    )
    return w?.id ?? null
  })

  const expanded = expandedWinId != null

  const expand = (): void => {
    openWindow({ kind: 'page', page: 'assistant' })
  }

  const collapse = (): void => {
    if (expandedWinId) closeWindow(expandedWinId)
  }

  return (
    <div className={cn('flex flex-col gap-2', bare ? 'p-3' : 'p-3')}>
      <WidgetHeader
        title="Ассистент"
        action={
          expanded
            ? { label: 'Свернуть в виджет', onClick: collapse }
            : { label: 'Развернуть в окно', onClick: expand }
        }
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
          title={expanded ? 'Свернуть в виджет' : 'Развернуть в окно'}
          aria-label={expanded ? 'Свернуть в виджет' : 'Развернуть в окно'}
          onClick={expanded ? collapse : expand}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </WidgetHeader>

      {expanded ? (
        <button
          type="button"
          onClick={collapse}
          className="flex h-[200px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/15 bg-neutral-900/40 px-4 text-center"
        >
          <Minimize2 className="size-5 text-muted-foreground" />
          <p className="text-[12px] font-medium text-foreground/90">Ассистент в окне</p>
          <p className="text-[11px] text-muted-foreground">Нажми, чтобы вернуть в виджет</p>
        </button>
      ) : (
        <div className="relative h-[220px] overflow-hidden rounded-xl ring-1 ring-black/20 dark:ring-white/10">
          <LiveTerminal
            className="h-full [&_.xterm]:text-[12px]"
            sessionKey={ASSISTANT_SESSION_KEY}
            profile="agent"
            keepAlive
            restartToken={restartToken}
            active
          />
        </div>
      )}
    </div>
  )
}
