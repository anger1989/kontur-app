import { useState, type JSX } from 'react'
import { CircleCheck, CircleX, Loader2, MinusCircle, Stethoscope, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Status = 'ok' | 'warn' | 'fail' | 'skip'
interface Diagnosis {
  steps: { label: string; status: Status; detail: string }[]
  verdict: string
}

const ICON: Record<Status, JSX.Element> = {
  ok: <CircleCheck className="size-4 text-[var(--success)]" />,
  warn: <TriangleAlert className="size-4 text-[var(--warning)]" />,
  fail: <CircleX className="size-4 text-destructive" />,
  skip: <MinusCircle className="size-4 text-muted-foreground" />
}

/**
 * Кнопка «Проверить соединение» с пошаговым результатом. Отвечает на вопрос
 * «почему пусто» конкретикой: где именно обрывается цепочка.
 */
export function Diagnostics({ serviceId }: { serviceId: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Diagnosis | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      setResult(await window.kontur.items.diagnose(serviceId))
    } finally {
      setBusy(false)
    }
  }

  const verdictTone = result?.steps.some((s) => s.status === 'fail')
    ? 'border-l-destructive'
    : result?.steps.some((s) => s.status === 'warn')
      ? 'border-l-[var(--warning)]'
      : 'border-l-[var(--success)]'

  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="animate-spin" /> : <Stethoscope />}
        Проверить соединение
      </Button>

      {result && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          {result.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-[13px]">
              <span className="mt-0.5 shrink-0">{ICON[step.status]}</span>
              <span className="w-28 shrink-0 font-medium">{step.label}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{step.detail}</span>
            </div>
          ))}
          <p className={`mt-1 border-l-[3px] ${verdictTone} pl-3 text-[13px] font-medium`}>
            {result.verdict}
          </p>
        </div>
      )}
    </div>
  )
}
