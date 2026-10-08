import { type JSX } from 'react'
import { Minimize2, RotateCcw } from 'lucide-react'
import { LiveTerminal } from '@/components/ui/terminal'
import { ASSISTANT_SESSION_KEY } from '@/lib/assistantSession'
import { useStore } from '@/store'

/**
 * Полноэкранная работа с Cursor Agent — та же PTY, что у виджета на столе.
 * «В виджет» закрывает окно; сессия (keepAlive) остаётся и снова рисуется в виджете.
 */
export function AssistantPage(): JSX.Element {
  const closeWindow = useStore((s) => s.closeWindow)
  const restartAssistant = useStore((s) => s.restartAssistant)
  const restartToken = useStore((s) => s.assistantRestartSeq)
  const winId = useStore((s) => {
    const w = s.windows.find(
      (x) => x.route.kind === 'page' && x.route.page === 'assistant' && !x.minimized
    )
    return w?.id ?? null
  })

  const collapse = (): void => {
    if (winId) closeWindow(winId)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-900">
      <div className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950/80 px-2 py-1">
        <span className="px-1 text-[11px] font-medium tracking-tight text-neutral-400">
          Cursor Agent
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="Перезапустить"
            aria-label="Перезапустить"
            onClick={() => restartAssistant()}
            className="flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <RotateCcw className="size-3.5" strokeWidth={2.25} />
          </button>
          <button
            type="button"
            title="Свернуть в виджет"
            aria-label="Свернуть в виджет"
            onClick={collapse}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <Minimize2 className="size-3.5" strokeWidth={2.25} />
            В виджет
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <LiveTerminal
          className="h-full"
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
