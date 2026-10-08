import { useEffect, useRef, useState, type JSX } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { showServiceView } from '@/store'
import { RESIZE_INSET, useViewBounds, WINDOW_CORNER_RADIUS } from '@/lib/viewHost'
import { cn } from '@/lib/utils'

/**
 * Пустое место под страницу активной вкладки браузера.
 *
 * Как и у `ServiceHost`, самой страницы в React-дереве нет: её рисует нативный
 * `WebContentsView`, который main кладёт поверх окна. Компонент сообщает в main
 * границы этой области и следит за тем, чтобы вебвью исчезал, когда поверх
 * оказывается чужое окно.
 *
 * Сверху зазора нет: там не край окна, а собственный хром браузера (полоса
 * вкладок и адресная строка) — отступ под хэндл ресайза нужен только по трём
 * остальным сторонам.
 */
export function BrowserHost({
  tabId,
  frozen = false,
  maximized = false,
  rect
}: {
  /** Активная вкладка; null — вкладок нет (показываем заглушку). */
  tabId: string | null
  /** Перекрыт окном выше — показать последний кадр вместо живой страницы. */
  frozen?: boolean
  maximized?: boolean
  /** Геометрия окна строкой: сигнал «окно переехало» для пересчёта bounds. */
  rect?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [snap, setSnap] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useViewBounds(ref, tabId, {
    inset: maximized ? 0 : RESIZE_INSET,
    insetTop: 0,
    borderRadius: maximized ? 0 : WINDOW_CORNER_RADIUS,
    rect
  })

  useEffect(() => {
    if (!tabId) {
      setLoading(false)
      return
    }
    let cancelled = false
    void window.kontur.view.isLoading(tabId).then((on) => {
      if (!cancelled) setLoading(on)
    })
    const off = window.kontur.view.onLoading((id, on) => {
      if (id === tabId) setLoading(on)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [tabId])

  // Живой ↔ freeze. freeze() на main: hide сразу, кадр из кэша.
  useEffect(() => {
    if (!tabId) return
    let cancelled = false
    if (!frozen) {
      setSnap(null)
      showServiceView(tabId)
      return () => {
        cancelled = true
      }
    }
    void window.kontur.view.hide(tabId)
    void (async () => {
      const url = await window.kontur.view.freeze(tabId)
      if (cancelled) return
      if (url) setSnap(url)
    })()
    return () => {
      cancelled = true
    }
  }, [frozen, tabId])

  // Окно закрыли или свернули — вебвью не должен остаться висеть на экране.
  useEffect(() => {
    if (!tabId) return
    return () => {
      void window.kontur.view.hide(tabId)
    }
  }, [tabId])

  return (
    <div ref={ref} className="absolute inset-0 bg-background">
      {!tabId && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <Globe className="size-7" />
          <p className="text-[13px]">Нет открытых вкладок</p>
        </div>
      )}
      {tabId && loading && !frozen && (
        <div className="pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-[12px]">Загрузка…</p>
        </div>
      )}
      {frozen && tabId && (
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
            <Globe className="size-7 text-muted-foreground" />
          )}
        </div>
      )}
    </div>
  )
}
