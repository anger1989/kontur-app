import { useEffect, useState, type JSX } from 'react'
import { serviceIcon } from '@/lib/icons'

/**
 * Иконка сервиса.
 *
 * У произвольных ресурсов (добавленных ссылкой) своего логотипа нет, поэтому
 * показываем favicon сайта: он узнаваем и приходит бесплатно. Пока иконка не
 * загрузилась или её нет — рисуем линейную иконку по типу сервиса, так список
 * никогда не «прыгает» и не остаётся пустым.
 */

/** Общий кэш на процесс: один запрос на сервис, а не на каждый рендер. */
const cache = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

function load(serviceId: string): Promise<string | null> {
  const existing = pending.get(serviceId)
  if (existing) return existing
  const p = window.kontur.icons
    .favicon(serviceId)
    .catch(() => null)
    .then((v) => {
      cache.set(serviceId, v)
      pending.delete(serviceId)
      return v
    })
  pending.set(serviceId, p)
  return p
}

export function ServiceIcon({
  serviceId,
  kind,
  size = 16
}: {
  serviceId: string
  kind: string
  size?: number
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(() => cache.get(serviceId) ?? null)

  useEffect(() => {
    if (cache.has(serviceId)) {
      setSrc(cache.get(serviceId) ?? null)
      return
    }
    let alive = true
    void load(serviceId).then((v) => {
      if (alive) setSrc(v)
    })
    return () => {
      alive = false
    }
  }, [serviceId])

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain', borderRadius: 3 }}
      />
    )
  }

  const Icon = serviceIcon(kind)
  return <Icon size={size} />
}
