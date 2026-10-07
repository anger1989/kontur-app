import { randomUUID } from 'node:crypto'
import type { Bookmark } from '@shared/types'
import { getConfig } from './config/store'
import { getBookmarkByUrl, listBookmarks, removeBookmark, upsertBookmark } from './db'
import { fetchGenericFavicon, getFavicon } from './services/favicon'
import { emitBookmarksChanged } from './notify/bookmarksChanged'

/**
 * Каталог закладок: добавление (вручную или из открытой вкладки сервиса),
 * список, удаление. Группа каталога — host, формируется сама, без ручных папок.
 */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Адрес совпадает по origin с уже настроенным сервисом — его иконка уже есть в кэше. */
function matchingServiceId(url: string): string | null {
  try {
    const origin = new URL(url).origin
    const svc = getConfig().services.find((s) => {
      if (!s.baseUrl) return false
      try {
        return new URL(s.baseUrl).origin === origin
      } catch {
        return false
      }
    })
    return svc?.id ?? null
  } catch {
    return null
  }
}

async function resolveFavicon(url: string, serviceId: string | null): Promise<string | null> {
  const svc = serviceId ?? matchingServiceId(url)
  if (svc) {
    const icon = await getFavicon(svc).catch(() => null)
    if (icon) return icon
  }
  return fetchGenericFavicon(url).catch(() => null)
}

export function listAllBookmarks(): Bookmark[] {
  return listBookmarks()
}

export function deleteBookmark(id: string): void {
  removeBookmark(id)
}

/**
 * Добавить закладку. Иконка в большинстве случаев уже есть (сервис или кэш) и
 * приходит сразу; если нет — досылается фоном, чтобы «добавить» не ждало сеть.
 */
export function addBookmark(input: { url: string; title?: string; serviceId?: string | null }): Bookmark {
  const url = input.url.trim()
  if (!url) throw new Error('Пустой адрес')
  const host = hostOf(url)
  if (!host) throw new Error('Некорректный адрес')

  const existing = getBookmarkByUrl(url)
  const now = Date.now()
  const serviceId = input.serviceId ?? existing?.serviceId ?? null
  const saved = upsertBookmark({
    id: existing?.id ?? randomUUID(),
    url,
    title: input.title?.trim() || existing?.title || host,
    favicon: existing?.favicon ?? null,
    host,
    serviceId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })

  if (!saved.favicon) {
    void resolveFavicon(url, serviceId).then((icon) => {
      if (!icon) return
      upsertBookmark({ ...saved, favicon: icon, updatedAt: Date.now() })
      emitBookmarksChanged()
    })
  }

  return saved
}
