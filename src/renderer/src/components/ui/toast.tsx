import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Info, Loader2, TriangleAlert } from 'lucide-react'
import SwipeToast from '@/components/ui/swipe-toast'

/**
 * Тосты приложения на React Bits Swipe Toast.
 *
 * API намеренно повторяет sonner (`toast.success(...)`, `{ id, description,
 * duration }`, обновление по id): вызовов по приложению под сотню, и менять их
 * все ради смены внешнего вида незачем.
 */

export type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'message' | 'loading'

export interface ToastOptions {
  /** Обновить уже показанный тост вместо нового — так «Поднимаем…» превращается в «Поднят». */
  id?: string | number
  description?: string
  /** мс; 0 — висит, пока не закроют. У loading по умолчанию именно так. */
  duration?: number
  /** Кнопка в тосте: отменить только что сделанное, не идя в настройки. */
  action?: { label: string; onClick: () => void }
}

interface ToastItem {
  id: string | number
  kind: ToastKind
  title: string
  description?: string
  duration: number
  action?: { label: string; onClick: () => void }
}

const DEFAULT_MS = 4000
/** Ошибку надо успеть прочитать, она длиннее остальных. */
const ERROR_MS = 8000

let items: ToastItem[] = []
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function push(kind: ToastKind, title: ReactNode, opts: ToastOptions = {}): string | number {
  const id = opts.id ?? `t${++seq}`
  const next: ToastItem = {
    id,
    kind,
    title: String(title ?? ''),
    description: opts.description,
    action: opts.action,
    duration:
      opts.duration ?? (kind === 'loading' ? 0 : kind === 'error' ? ERROR_MS : DEFAULT_MS)
  }
  const i = items.findIndex((t) => t.id === id)
  items = i >= 0 ? items.map((t, n) => (n === i ? next : t)) : [...items, next]
  emit()
  return id
}

function dismiss(id?: string | number): void {
  items = id == null ? [] : items.filter((t) => t.id !== id)
  emit()
}

type ToastFn = ((title: ReactNode, opts?: ToastOptions) => string | number) & {
  success: (title: ReactNode, opts?: ToastOptions) => string | number
  error: (title: ReactNode, opts?: ToastOptions) => string | number
  warning: (title: ReactNode, opts?: ToastOptions) => string | number
  info: (title: ReactNode, opts?: ToastOptions) => string | number
  message: (title: ReactNode, opts?: ToastOptions) => string | number
  loading: (title: ReactNode, opts?: ToastOptions) => string | number
  dismiss: (id?: string | number) => void
}

export const toast = Object.assign(
  (title: ReactNode, opts?: ToastOptions) => push('message', title, opts),
  {
    success: (title: ReactNode, opts?: ToastOptions) => push('success', title, opts),
    error: (title: ReactNode, opts?: ToastOptions) => push('error', title, opts),
    warning: (title: ReactNode, opts?: ToastOptions) => push('warning', title, opts),
    info: (title: ReactNode, opts?: ToastOptions) => push('info', title, opts),
    message: (title: ReactNode, opts?: ToastOptions) => push('message', title, opts),
    loading: (title: ReactNode, opts?: ToastOptions) => push('loading', title, opts),
    dismiss
  }
) as ToastFn

/** Цвет «фитиля» и иконка — единственное, чем виды тостов отличаются. */
const ACCENT: Record<ToastKind, string> = {
  success: 'var(--success)',
  error: 'var(--destructive)',
  warning: 'var(--warning)',
  info: 'var(--primary)',
  message: 'var(--primary)',
  loading: 'var(--primary)'
}

function KindIcon({ kind }: { kind: ToastKind }): JSX.Element {
  const color = ACCENT[kind]
  if (kind === 'loading') return <Loader2 className="size-4 animate-spin" style={{ color }} />
  if (kind === 'success') return <CheckCircle2 className="size-4" style={{ color }} />
  if (kind === 'error') return <CircleAlert className="size-4" style={{ color }} />
  if (kind === 'warning') return <TriangleAlert className="size-4" style={{ color }} />
  return <Info className="size-4" style={{ color }} />
}

/**
 * Стопка тостов сверху по центру.
 *
 * z-[1500]: выше модалок и поповеров (1200), но ниже экрана блокировки
 * (210000) — тост не должен всплыть поверх запертого экрана.
 */
export function Toaster(): JSX.Element {
  const [, force] = useState(0)
  useEffect(() => {
    const l = (): void => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[1500] flex flex-col items-center gap-2">
      {items.map((t) => (
        // Ширину обязан задавать контейнер: у самой карточки
        // `width: min(380px, 100%)`, и без опоры «100%» считать не от чего —
        // тост схлопывался до ширины текста и уезжал из центра.
        <div key={t.id} className="pointer-events-auto w-[380px] max-w-[calc(100vw-24px)]">
          <SwipeToast
            inline
            title={t.title}
            description={t.description}
            duration={t.duration}
            icon={<KindIcon kind={t.kind} />}
            background="var(--popover)"
            color="var(--popover-foreground)"
            fuseColor={ACCENT[t.kind]}
            width={380}
            radius={12}
            closeButton={t.duration === 0}
            actionLabel={t.action?.label}
            onAction={t.action?.onClick}
            onClose={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  )
}
