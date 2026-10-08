import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import { LiveTerminal } from '@/components/ui/terminal'
import { cn } from '@/lib/utils'

interface TermTab {
  id: string
  /** Подпись вкладки (shell / OSC title). */
  title: string
  exited?: boolean
}

let tabSeq = 0
function newTab(): TermTab {
  tabSeq += 1
  return { id: `term-${Date.now().toString(36)}-${tabSeq}`, title: `zsh ${tabSeq}` }
}

/** Встроенный терминал — несколько вкладок, у каждой свой PTY (zsh). */
export function TerminalPage(): JSX.Element {
  const [tabs, setTabs] = useState<TermTab[]>(() => [newTab()])
  const [activeId, setActiveId] = useState(() => tabs[0]!.id)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const addTab = useCallback((): void => {
    const t = newTab()
    setTabs((prev) => [...prev, t])
    setActiveId(t.id)
  }, [])

  const closeTab = useCallback((id: string): void => {
    setTabs((prev) => {
      if (prev.length <= 1) {
        // Последнюю не закрываем — пересоздаём сессию.
        const t = newTab()
        setActiveId(t.id)
        return [t]
      }
      const i = prev.findIndex((x) => x.id === id)
      const next = prev.filter((x) => x.id !== id)
      if (activeIdRef.current === id) {
        const fallback = next[Math.max(0, i - 1)] ?? next[0]!
        setActiveId(fallback.id)
      }
      return next
    })
  }, [])

  // ⌘T — новая вкладка, ⌘W — закрыть (в окне терминала).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        addTab()
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault()
        closeTab(activeIdRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTab, closeTab])

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-900">
      {/* «+» сразу за последней вкладкой, не у правого края окна. */}
      <div className="flex shrink-0 items-stretch gap-0.5 border-b border-neutral-800 bg-neutral-950/80 px-1 pt-1">
        <div className="flex min-w-0 max-w-full items-stretch gap-0.5">
          <div className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto">
            {tabs.map((tab) => {
              const active = tab.id === activeId
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group flex max-w-[12rem] min-w-[5.5rem] items-center gap-1 rounded-t-md px-2 py-1.5 text-[11px]',
                    active
                      ? 'bg-neutral-900 text-neutral-100'
                      : 'bg-transparent text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300'
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium tracking-tight"
                    onClick={() => setActiveId(tab.id)}
                    title={tab.title}
                  >
                    {tab.exited ? (
                      <span className="text-neutral-600 line-through">{tab.title}</span>
                    ) : (
                      tab.title
                    )}
                  </button>
                  <button
                    type="button"
                    title="Закрыть вкладку"
                    aria-label="Закрыть вкладку"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-sm text-neutral-500',
                      'hover:bg-neutral-700 hover:text-neutral-200',
                      !active && 'opacity-0 group-hover:opacity-100'
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                  >
                    <X className="size-3" strokeWidth={2.25} />
                  </button>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            title="Новая вкладка (⌘T)"
            aria-label="Новая вкладка"
            className="mb-0.5 flex size-7 shrink-0 items-center justify-center self-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={addTab}
          >
            <Plus className="size-3.5" strokeWidth={2.25} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              className={cn(
                'absolute inset-0',
                active ? 'z-10' : 'pointer-events-none z-0 invisible'
              )}
              aria-hidden={!active}
            >
              <LiveTerminal
                className="h-full"
                active={active}
                onTitle={(title) => {
                  setTabs((prev) =>
                    prev.map((t) => (t.id === tab.id ? { ...t, title: title.slice(0, 48) } : t))
                  )
                }}
                onExit={() => {
                  setTabs((prev) =>
                    prev.map((t) => (t.id === tab.id ? { ...t, exited: true } : t))
                  )
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
