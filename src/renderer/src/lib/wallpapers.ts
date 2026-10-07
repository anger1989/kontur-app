import type { CSSProperties } from 'react'
import type { Wallpaper } from '@shared/types'

/**
 * Встроенные градиенты рабочего стола. Ключ — то, что лежит в `wallpaper.value`
 * при `kind: 'gradient'`. Светлая/тёмная тема берут один и тот же градиент —
 * они и так приглушённые, резкого контраста с темой не возникает.
 */
export const WALLPAPER_PRESETS: { key: string; label: string; css: string }[] = [
  { key: 'graphite', label: 'Графит', css: 'linear-gradient(160deg, #1c1d22 0%, #26272e 55%, #313340 100%)' },
  { key: 'sunset', label: 'Закат', css: 'linear-gradient(160deg, #2a1d1a 0%, #4a2a1f 45%, #f09a05 140%)' },
  { key: 'ocean', label: 'Океан', css: 'linear-gradient(160deg, #0f1c24 0%, #15303f 55%, #1f5c73 100%)' },
  { key: 'forest', label: 'Лес', css: 'linear-gradient(160deg, #141b16 0%, #1e2e22 55%, #2f4a35 100%)' },
  { key: 'violet', label: 'Фиолет', css: 'linear-gradient(160deg, #1a1625 0%, #2a2140 55%, #453266 100%)' },
  { key: 'mono', label: 'Монохром', css: 'linear-gradient(160deg, #141414 0%, #202020 55%, #2c2c2c 100%)' }
]

/** Встроенные фото. В конфиге — ключ (`1`…`9`), не data URL. */
export const WALLPAPER_IMAGES: { key: string; label: string; url: string }[] = [
  { key: '1', label: '1', url: './wallpapers/1.jpg' },
  { key: '2', label: '2', url: './wallpapers/2.jpg' },
  { key: '3', label: '3', url: './wallpapers/3.jpg' },
  { key: '4', label: '4', url: './wallpapers/4.jpg' },
  { key: '5', label: '5', url: './wallpapers/5.jpg' },
  { key: '6', label: '6', url: './wallpapers/6.jpg' },
  { key: '7', label: '7', url: './wallpapers/7.jpg' },
  { key: '8', label: '8', url: './wallpapers/8.jpg' },
  { key: '9', label: '9', url: './wallpapers/9.jpg' }
]

/**
 * Живые обои: их рисует React-компонент, а не CSS-фон (см. AnimatedWallpaper).
 * `preview` — статичная подложка для плитки в настройках: крутить анимацию в
 * квадратике 36px незачем, а узнаётся фон и так.
 */
export const WALLPAPER_ANIMATED: { key: string; label: string; preview: string }[] = [
  {
    key: 'aurora',
    label: 'Северное сияние',
    preview: 'linear-gradient(120deg, #18181b 0%, #3b82f6 45%, #a5b4fc 70%, #ddd6fe 100%)'
  }
]

const PRESET_BY_KEY = new Map(WALLPAPER_PRESETS.map((p) => [p.key, p.css]))
const IMAGE_BY_KEY = new Map(WALLPAPER_IMAGES.map((p) => [p.key, p.url]))

/** Несколько приятных сплошных заливок — быстрый выбор без градиента. */
export const WALLPAPER_COLORS = ['#1c1d22', '#0f1419', '#141414', '#1a1f16', '#171022', '#f5f1ea']

const DEFAULT_CSS = PRESET_BY_KEY.get('graphite')!

function imageUrl(value: string): string {
  // Ключ встроенного пресета, data URL или произвольный путь.
  return IMAGE_BY_KEY.get(value) ?? value
}

export function wallpaperStyle(w: Wallpaper | undefined): CSSProperties {
  if (!w) {
    return {
      backgroundImage: `url(${IMAGE_BY_KEY.get('1')})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }
  // Живой фон рисует компонент поверх этой подложки — здесь только цвет,
  // чтобы до его монтирования не просвечивал пустой стол.
  if (w.kind === 'animated') return { background: '#18181b' }
  if (w.kind === 'color') return { background: w.value }
  if (w.kind === 'image') {
    return {
      backgroundImage: `url(${imageUrl(w.value)})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }
  return { background: PRESET_BY_KEY.get(w.value) ?? DEFAULT_CSS }
}
