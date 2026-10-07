import { useEffect, useRef, useState, type JSX } from 'react'
import { Globe } from 'lucide-react'
import { showServiceView, useStore } from '@/store'
import { Button } from '@/components/ui/button'
import { RESIZE_INSET, useViewBounds, WINDOW_CORNER_RADIUS } from '@/lib/viewHost'
import { ServiceIcon } from './ServiceIcon'
import { cn } from '@/lib/utils'

/**
 * Пустое место под встроенный сервис.
 *
 * Самого содержимого в React-дереве нет: сервис рисует настоящий
 * WebContentsView, который главный процесс кладёт поверх окна.
 * Задача компонента — сообщать в main точные границы этой области.
 *
 * `frozen`: поверх лежит снимок — нативный view спрятан, потому что выше
 * по z есть другое окно. WebContentsView всегда рисуется НАД любым DOM,
 * поэтому «просвечивать» живую вкладку под чужим titlebar нельзя; freeze
 * даёт вид обычного ОС-окна, а не пустую дыру.
 */
export function ServiceHost({
  serviceId,
  layout,
  frozen = false
}: {
  serviceId: string
  layout?: { x: number; y: number; width: number; height: number; maximized?: boolean }
  /** Перекрыт окном выше — показать последний кадр вместо живого вебвью. */
  frozen?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const service = useStore((s) => s.config?.services.find((x) => x.id === serviceId))
  const openWindow = useStore((s) => s.openWindow)
  const maximized = layout?.maximized ?? false
  const [snap, setSnap] = useState<string | null>(null)

  // Живой ↔ freeze. freeze() на main: hide сразу, кадр из кэша.
  useEffect(() => {
    let cancelled = false
    if (!frozen) {
      setSnap(null)
      showServiceView(serviceId)
      return () => {
        cancelled = true
      }
    }
    // Дублируем hide до await — на случай, если reconcile ещё не успел.
    void window.kontur.view.hide(serviceId)
    void (async () => {
      const url = await window.kontur.view.freeze(serviceId)
      if (cancelled) return
      if (url) setSnap(url)
    })()
    return () => {
      cancelled = true
    }
  }, [frozen, serviceId])

  useEffect(() => {
    return () => {
      void window.kontur.view.hide(serviceId)
    }
  }, [serviceId])

  useViewBounds(ref, serviceId, {
    inset: maximized ? 0 : RESIZE_INSET,
    borderRadius: maximized ? 0 : WINDOW_CORNER_RADIUS,
    rect: `${layout?.x},${layout?.y},${layout?.width},${layout?.height}`
  })

  return (
    <div ref={ref} className="absolute inset-0 bg-background">
      {!service?.baseUrl && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Globe className="size-7 text-muted-foreground" />
          <p className="text-base font-medium">Адрес сервиса не задан</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">
            Укажите URL в настройках — после этого сервис откроется здесь, в собственной сессии своего
            контура.
          </p>
          <Button variant="outline" size="sm" onClick={() => openWindow({ kind: 'page', page: 'settings' })}>
            Открыть настройки
          </Button>
        </div>
      )}
      {frozen && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-[1] overflow-hidden bg-muted/50',
            snap ? 'brightness-[0.92]' : 'flex items-center justify-center'
          )}
          aria-hidden
        >
          {snap ? (
            <img src={snap} alt="" className="size-full object-cover object-left-top" draggable={false} />
          ) : (
            <ServiceIcon serviceId={serviceId} kind={service?.kind ?? ''} size={28} />
          )}
        </div>
      )}
    </div>
  )
}
