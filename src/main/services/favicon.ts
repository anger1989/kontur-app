import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { request, type Dispatcher } from 'undici'
import { getConfig } from '../config/store'
import { dispatcherFor } from '../net/transport'
import { logInfo } from '../log'

/**
 * Иконки ресурсов из favicon.
 *
 * Для произвольных приложений, добавленных ссылкой, логотип взять неоткуда —
 * берём favicon самого сайта. Запрос идёт через dispatcher контура, поэтому
 * внутренние адреса достаются только при поднятом туннеле и с его настройками
 * TLS. Результат кладём на диск: иконка потом рисуется мгновенно и без сети.
 */

const MAX_BYTES = 512 * 1024

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'icons')
  mkdirSync(dir, { recursive: true })
  return dir
}

const cachePath = (serviceId: string): string =>
  join(cacheDir(), `${serviceId.replace(/[^\w.-]/g, '_')}.txt`)

/** Подсказка от вебвью: страница сама сообщает адрес своей иконки. */
const hints = new Map<string, string>()

export function rememberFaviconUrl(serviceId: string, url: string): void {
  hints.set(serviceId, url)
}

function readCache(serviceId: string): string | null {
  const p = cachePath(serviceId)
  if (!existsSync(p)) return null
  try {
    const v = readFileSync(p, 'utf8')
    return v.startsWith('data:') ? v : null
  } catch {
    return null
  }
}

/** Разбираем <link rel="icon"> из HTML. Берём самый крупный из объявленных. */
function iconLinksFrom(html: string, pageUrl: string): string[] {
  const out: { href: string; size: number }[] = []
  const re = /<link\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const tag = m[0]
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (!/\b(icon|shortcut icon|apple-touch-icon)\b/.test(rel)) continue
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href) continue
    const sizes = /\bsizes\s*=\s*["'](\d+)x\d+["']/i.exec(tag)?.[1]
    out.push({ href, size: sizes ? Number(sizes) : 0 })
  }
  // Крупные иконки выглядят лучше при масштабировании.
  out.sort((a, b) => b.size - a.size)
  return out.map((i) => {
    try {
      return new URL(i.href, pageUrl).toString()
    } catch {
      return ''
    }
  }).filter(Boolean)
}

/** dispatcher не задан — обычный прямой запрос (для адресов вне контуров, см. fetchGenericFavicon). */
async function fetchIcon(url: string, dispatcher?: Dispatcher): Promise<string | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      dispatcher,
      headersTimeout: 8000,
      bodyTimeout: 8000
    })
    if (res.statusCode >= 400) {
      res.body.dump().catch(() => {})
      return null
    }
    const type = String(res.headers['content-type'] ?? '')
    const buf = Buffer.from(await res.body.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null
    // HTML вместо картинки — значит сервер отдал страницу-заглушку.
    if (/text\/html/i.test(type)) return null
    const mime = /image\/[\w.+-]+/i.exec(type)?.[0] ?? guessMime(url)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function guessMime(url: string): string {
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml'
  if (/\.png(\?|$)/i.test(url)) return 'image/png'
  if (/\.ico(\?|$)/i.test(url)) return 'image/x-icon'
  return 'image/png'
}

/**
 * Иконка сервиса: из кэша, иначе по подсказке вебвью, иначе из HTML страницы,
 * иначе по стандартному /favicon.ico.
 */
export async function getFavicon(serviceId: string, refresh = false): Promise<string | null> {
  if (!refresh) {
    const cached = readCache(serviceId)
    if (cached) return cached
  }

  const service = getConfig().services.find((s) => s.id === serviceId)
  if (!service?.baseUrl) return null

  const candidates: string[] = []
  const hint = hints.get(serviceId)
  if (hint) candidates.push(hint)

  // Страница может объявлять иконку явно — это надёжнее догадок.
  try {
    const res = await request(service.baseUrl, {
      method: 'GET',
      dispatcher: dispatcherFor(getConfig().envs.find((e) => e.id === service.envId)!),
      headersTimeout: 8000,
      bodyTimeout: 8000
    })
    if (res.statusCode < 400) {
      const html = (await res.body.text()).slice(0, 200_000)
      candidates.push(...iconLinksFrom(html, service.baseUrl))
    } else {
      res.body.dump().catch(() => {})
    }
  } catch {
    // Страница недоступна — остаётся стандартный путь ниже.
  }

  try {
    candidates.push(new URL('/favicon.ico', service.baseUrl).toString())
  } catch {
    // Некорректный baseUrl — дальше идти незачем.
  }

  const env = getConfig().envs.find((e) => e.id === service.envId)
  const dispatcher = env ? dispatcherFor(env) : undefined
  for (const url of candidates) {
    const data = await fetchIcon(url, dispatcher)
    if (data) {
      writeFileSync(cachePath(serviceId), data, 'utf8')
      logInfo('favicon', `${serviceId}: иконка получена (${url})`)
      return data
    }
  }
  return null
}

/**
 * Фавикон произвольного адреса без привязки к контуру — для закладок,
 * добавленных вручную без связанного сервиса. Прямой запрос, без dispatcher'а
 * турникета: годится только для публично доступных адресов, внутренние без
 * VPN всё равно не достать — иконка там просто не найдётся, не страшно.
 */
export async function fetchGenericFavicon(url: string): Promise<string | null> {
  const candidates: string[] = []
  try {
    const res = await request(url, { method: 'GET', headersTimeout: 8000, bodyTimeout: 8000 })
    if (res.statusCode < 400) {
      const html = (await res.body.text()).slice(0, 200_000)
      candidates.push(...iconLinksFrom(html, url))
    } else {
      res.body.dump().catch(() => {})
    }
  } catch {
    // Недоступно без сети/VPN — браться неоткуда, падать в общую заглушку.
  }
  try {
    candidates.push(new URL('/favicon.ico', url).toString())
  } catch {
    // Некорректный адрес — дальше идти незачем.
  }
  for (const cand of candidates) {
    const data = await fetchIcon(cand)
    if (data) return data
  }
  return null
}
