import { useEffect, useState, type JSX } from 'react'
import { cn } from '@/lib/utils'

/**
 * Шапка окна в оболочке KDE — обычная рамка приложения macOS.
 *
 * Своих кнопок здесь нет: окном управляет нативный светофор (закрыть,
 * свернуть, развернуть, зелёная — полноэкранный режим). Полоса нужна, чтобы
 * ему было на чём жить и чтобы окно таскалось за шапку, а не за обои; KDE
 * начинается ниже — рабочий стол с панелью.
 */
export function KdeTitleBar(): JSX.Element {
  /** Fullscreen — светофор скрывает сама система, отступ под него не нужен. */
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    void window.kontur.app.isFullScreen().then(setFullScreen)
    return window.kontur.app.onMaximizedChange(setFullScreen)
  }, [])

  return (
    <header
      className={cn(
        'kde-surface drag relative flex h-10 shrink-0 items-center border-b border-kde-line pr-3 select-none',
        // Светофор нативный (trafficLightPosition x:14 y:14) — оставляем под него место.
        fullScreen ? 'pl-3' : 'pl-[80px]'
      )}
    >
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[12px] font-medium text-kde-fg">
        Kontur
      </span>
    </header>
  )
}
