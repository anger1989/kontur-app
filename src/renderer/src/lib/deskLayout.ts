/**
 * Полоса снизу, куда окна/WebContentsView не заезжают.
 * bottom-3 (12) + h-[4.75rem] дока (76) ≈ 88; +пара px воздуха.
 * Большой запас под magnification давал дыру обоев при maximize — не надо:
 * иконки на hover чуть могут зайти под вебвью, зато окно садится к доку.
 */
export const DOCK_CLEARANCE = 90

/** Геометрия развёрнутого окна — всегда с зазором под док. */
export function maximizedRect(desktop: { width: number; height: number }): DeskRect {
  return {
    x: 0,
    y: 0,
    width: desktop.width,
    height: Math.max(MIN_WIN_HEIGHT, desktop.height - DOCK_CLEARANCE)
  }
}

/** Сколько пикселей окна остаётся видно с края в режиме «показать стол». */
export const DESKTOP_PEEK = 36

export type DeskRect = { x: number; y: number; width: number; height: number }

/** Минимальный размер окна рабочего стола (им же ограничен ресайз за угол). */
export const MIN_WIN_WIDTH = 420
export const MIN_WIN_HEIGHT = 280

/**
 * Вписать окно в стол после изменения размера приложения.
 *
 * Отличие от `clampServiceRect`: тот разрешает увести окно за край (так его
 * двигает пользователь), а здесь наоборот — окно должно остаться целиком на
 * виду. Минимум сильнее стола: на совсем узком окне лучше горизонтальный
 * обрез, чем окно шириной 200px.
 */
export function fitRect(
  rect: DeskRect,
  desktop: { width: number; height: number },
  minWidth = MIN_WIN_WIDTH,
  minHeight = MIN_WIN_HEIGHT
): DeskRect {
  const maxBottom = Math.max(minHeight, desktop.height - DOCK_CLEARANCE)
  const width = Math.max(Math.min(rect.width, desktop.width), Math.min(minWidth, desktop.width))
  const height = Math.max(Math.min(rect.height, maxBottom), Math.min(minHeight, maxBottom))
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, 0), Math.max(0, desktop.width - width)),
    y: Math.min(Math.max(rect.y, 0), Math.max(0, maxBottom - height))
  }
}

export function rectsOverlap(a: DeskRect, b: DeskRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

type StackWin = DeskRect & { id: string; z: number }

/** Есть ли окно выше по z, которое пересекается с этим (нативный view нельзя держать). */
export function isOccludedByHigher(win: StackWin, open: StackWin[]): boolean {
  return open.some((o) => o.id !== win.id && o.z > win.z && rectsOverlap(win, o))
}

/** Нижняя граница для окон сервиса — не заезжать на док целиком. */
export function clampServiceRect(
  rect: DeskRect,
  desktop: { width: number; height: number },
  minWidth: number,
  minHeight: number
): DeskRect {
  const maxBottom = desktop.height - DOCK_CLEARANCE
  let { x, y, width, height } = rect
  width = Math.max(minWidth, Math.min(width, desktop.width))
  height = Math.max(minHeight, Math.min(height, Math.max(minHeight, maxBottom)))
  x = Math.min(Math.max(x, -width + 120), desktop.width - 40)
  y = Math.min(Math.max(y, 0), Math.max(0, maxBottom - height))
  if (y + height > maxBottom) {
    height = Math.max(minHeight, maxBottom - y)
  }
  return { x, y, width, height }
}

/**
 * macOS «Показать рабочий стол»: окна разъезжаются влево / вправо / вверх,
 * с края остаётся узкая полоска. Размер не меняем — только сдвиг.
 * Порядок входа = z-order (нижние раньше).
 */
export function peekRects(
  windows: DeskRect[],
  desktop: { width: number; height: number }
): DeskRect[] {
  const edges = ['left', 'right', 'top'] as const
  const usableH = Math.max(120, desktop.height - DOCK_CLEARANCE)
  const byEdge: Record<(typeof edges)[number], number[]> = {
    left: [],
    right: [],
    top: []
  }
  windows.forEach((_, i) => {
    byEdge[edges[i % 3]!]!.push(i)
  })

  const out = windows.map((w) => ({ ...w }))
  for (const edge of edges) {
    const idxs = byEdge[edge]
    const count = idxs.length
    idxs.forEach((idx, k) => {
      const w = windows[idx]!
      if (edge === 'left') {
        const span = Math.max(0, usableH - w.height)
        const y = count <= 1 ? Math.max(0, Math.min(w.y, span)) : (span * k) / (count - 1)
        out[idx] = { x: DESKTOP_PEEK - w.width, y, width: w.width, height: w.height }
      } else if (edge === 'right') {
        const span = Math.max(0, usableH - w.height)
        const y = count <= 1 ? Math.max(0, Math.min(w.y, span)) : (span * k) / (count - 1)
        out[idx] = { x: desktop.width - DESKTOP_PEEK, y, width: w.width, height: w.height }
      } else {
        const span = Math.max(0, desktop.width - w.width)
        const x = count <= 1 ? Math.max(0, Math.min(w.x, span)) : (span * k) / (count - 1)
        out[idx] = { x, y: DESKTOP_PEEK - w.height, width: w.width, height: w.height }
      }
    })
  }
  return out
}
