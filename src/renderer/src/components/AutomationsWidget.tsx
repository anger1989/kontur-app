import { useEffect, useState, type JSX } from 'react'
import { Loader2, Play } from 'lucide-react'
import type { AutomationView } from '@shared/automations'
import { WidgetHeader } from '@/components/ui/stats-card'
import { cn } from '@/lib/utils'

function statusDot(a: AutomationView): string {
  if (!a.enabled) return 'bg-muted-foreground/35'
  if (a.lastStatus === 'running') return 'bg-sky-500'
  if (a.lastStatus === 'error') return 'bg-destructive'
  if (a.lastStatus === 'ok') return 'bg-emerald-500'
  return 'bg-muted-foreground/50'
}

function nextLabel(a: AutomationView): string {
  if (!a.enabled) return 'выкл'
  if (a.nextRunAt == null) return '—'
  const d = new Date(a.nextRunAt)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm} ${hh}:${mi}`
}

function Row({
  item,
  onToggle,
  onRun
}: {
  item: AutomationView
  onToggle: (id: string, enabled: boolean) => void
  onRun: (id: string) => void
}): JSX.Element {
  const busy = item.lastStatus === 'running'
  return (
    <li className="rounded-lg px-2 py-1.5 hover:bg-foreground/5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          title={item.enabled ? 'Выключить' : 'Включить'}
          onClick={() => onToggle(item.id, !item.enabled)}
          className="mt-1.5 flex size-3 shrink-0 items-center justify-center"
        >
          <span className={cn('size-2 rounded-full', statusDot(item))} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px] font-medium',
                !item.enabled && 'text-muted-foreground'
              )}
            >
              {item.name}
            </span>
            <button
              type="button"
              title="Запустить сейчас"
              disabled={busy}
              onClick={() => onRun(item.id)}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            </button>
          </div>
          <p className="truncate text-[11px] text-muted-foreground tabular-nums">
            {item.lastStatus === 'error' && item.lastError
              ? item.lastError
              : item.lastSummary
                ? item.lastSummary
                : `след. ${nextLabel(item)} · ${item.schedule.cron}`}
          </p>
        </div>
      </div>
    </li>
  )
}

/** Виджет локальных cron-сценариев на рабочем столе. */
export function AutomationsWidget({ bare }: { bare?: boolean } = {}): JSX.Element | null {
  const [items, setItems] = useState<AutomationView[]>([])

  useEffect(() => {
    const load = (): void => {
      void window.kontur.automations.list().then(setItems)
    }
    load()
    return window.kontur.automations.onChange(load)
  }, [])

  const onToggle = (id: string, enabled: boolean): void => {
    void window.kontur.automations.setEnabled(id, enabled).then((a) => {
      setItems((prev) => prev.map((x) => (x.id === a.id ? a : x)))
    })
  }

  const onRun = (id: string): void => {
    setItems((prev) =>
      prev.map((x) => (x.id === id ? { ...x, lastStatus: 'running' as const } : x))
    )
    void window.kontur.automations.runNow(id).finally(() => {
      void window.kontur.automations.list().then(setItems)
    })
  }

  return (
    <div className={cn(!bare && 'desktop-glass rounded-2xl border p-3 backdrop-blur-2xl', bare && 'p-3')}>
      <WidgetHeader title="Автоматизации" count={items.length} />

      {items.length === 0 ? (
        <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
          Пока пусто — агент может завести через automations_upsert
        </p>
      ) : (
        <ul className="space-y-px">
          {items.map((it) => (
            <Row key={it.id} item={it} onToggle={onToggle} onRun={onRun} />
          ))}
        </ul>
      )}
    </div>
  )
}
