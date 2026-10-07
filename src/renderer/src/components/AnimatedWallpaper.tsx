import { useEffect, useState, type JSX } from 'react'
import type { Wallpaper } from '@shared/types'
import { AuroraBackground } from '@/components/ui/aurora-background'

/**
 * Живые обои рабочего стола.
 *
 * Обычные обои — это CSS-фон у самого стола (`wallpaperStyle`), а живым нужен
 * свой слой: они рисуются элементами с анимацией. Слой лежит первым в DOM,
 * поэтому иконки, виджеты и окна оказываются над ним, а клики до него не
 * доходят — их ловит `data-desktop-backdrop` выше по стеку.
 *
 * Пока окно скрыто (свернули, ушли в трей), анимацию ставим на паузу: фон,
 * которого никто не видит, не должен занимать GPU. Электрон притормаживает и
 * сам, но только когда окно совсем невидимо, — а цена проверки нулевая.
 */
export function AnimatedWallpaper({ wallpaper }: { wallpaper: Wallpaper | undefined }): JSX.Element | null {
  const [paused, setPaused] = useState(() => document.hidden)

  useEffect(() => {
    const onVisibility = (): void => setPaused(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  if (wallpaper?.kind !== 'animated') return null

  // Вариант пока один; неизвестный ключ из старого конфига — тоже он.
  return (
    <AuroraBackground
      data-paused={paused ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  )
}
