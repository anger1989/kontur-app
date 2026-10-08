import { useEffect, type RefObject } from 'react'
import { DOCK_CLEARANCE, DOCK_MAG_CLEARANCE } from '@/lib/deskLayout'
import { useStore } from '@/store'

/**
 * Геометрия нативных `WebContentsView` под DOM-окнами.
 *
 * Вебвью (встроенный сервис, вкладка браузера) рисуется поверх любого DOM и
 * живёт в main-процессе — React может только сообщать, где для него оставлено
 * место. Этим занят один общий хук: правило про отступ под хэндлы ресайза и
 * радиус скругления должно быть одинаковым у всех хостов, иначе окна начинают
 * отличаться на пиксель.
 *
 * Низ экрана под док всегда вырезаем из bounds: иначе maximize на весь стол
 * накрывает док нативным слоем (DOM z-index тут бессилен).
 */

/** Совпадает с `rounded-xl` у Window. */
export const WINDOW_CORNER_RADIUS = 12

/**
 * Отступ под DOM-хэндлы ресайза. WebContentsView перехватывает клики, и без
 * этого зазора за край или угол окна не потянуть.
 */
export const RESIZE_INSET = 8

/**
 * Сообщать в main границы элемента `ref` как область вебвью `viewId`.
 *
 * `insetTop` отделён от общего отступа: у браузера сверху не край окна, а
 * собственный хром (полоса вкладок и адресная строка), и зазор там не нужен.
 *
 * `rect` — геометрия окна строкой. ResizeObserver молчит, когда окно только
 * переезжает, а при драге окно двигают без motion-анимации (и без тика
 * `kontur:view-bounds-tick`), так что единственный сигнал «окно сдвинулось» —
 * смена этого значения.
 */
export function useViewBounds(
  ref: RefObject<HTMLElement | null>,
  viewId: string | null,
  opts: { inset: number; insetTop?: number; borderRadius?: number; rect?: string }
): void {
  const { inset, rect } = opts
  const insetTop = opts.insetTop ?? inset
  const borderRadius = opts.borderRadius ?? WINDOW_CORNER_RADIUS
  const dockElevated = useStore((s) => s.dockElevated)
  const deskHeight = useStore((s) => s.desktop.height)

  useEffect(() => {
    const el = ref.current
    if (!el || !viewId) return

    let raf = 0
    let last = ''
    const pushNow = (): void => {
      const r = el.getBoundingClientRect()
      const clearance = useStore.getState().dockElevated ? DOCK_MAG_CLEARANCE : DOCK_CLEARANCE
      const deskH = useStore.getState().desktop.height
      const maxBottom = Math.max(0, deskH - clearance)
      let y = Math.round(r.y) + insetTop
      let height = Math.max(0, Math.round(r.height) - inset - insetTop)
      if (y + height > maxBottom) {
        height = Math.max(0, maxBottom - y)
      }
      const next = {
        serviceId: viewId,
        x: Math.round(r.x) + inset,
        y,
        width: Math.max(0, Math.round(r.width) - inset * 2),
        height,
        borderRadius
      }
      const key = `${next.x},${next.y},${next.width},${next.height},${next.borderRadius}`
      if (key === last) return
      last = key
      window.kontur.view.setBounds(next)
    }
    // Одна отправка на кадр: при драге окна события сыпятся пачками.
    const push = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        pushNow()
      })
    }

    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    window.addEventListener('resize', push)
    window.addEventListener('kontur:view-bounds-tick', push)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', push)
      window.removeEventListener('kontur:view-bounds-tick', push)
    }
  }, [ref, viewId, inset, insetTop, borderRadius, rect, dockElevated, deskHeight])
}
