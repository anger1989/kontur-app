import { request } from 'undici'
import type { Item } from '@shared/types'
import { dispatcherFor } from '../net/transport'
import { base } from './http'
import { itemId, type SyncContext } from './types'

/**
 * Календарь по CalDAV: логин почта, пароль —
 * пароль приложения. Делаем стандартную последовательность обнаружения
 * (principal → calendar-home → календари) и тянем события на 30 дней вперёд.
 */

function creds(ctx: SyncContext): string {
  const user = ctx.service.auth.username || ctx.service.options.email || ''
  return `Basic ${Buffer.from(`${user}:${ctx.secret ?? ''}`).toString('base64')}`
}

async function dav(
  ctx: SyncContext,
  url: string,
  method: 'PROPFIND' | 'REPORT',
  depth: string,
  body: string
): Promise<string> {
  const res = await request(url, {
    method: method as 'GET',
    dispatcher: dispatcherFor(ctx.env),
    headers: {
      authorization: creds(ctx),
      depth,
      'content-type': 'application/xml; charset=utf-8'
    },
    body,
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  })
  const text = await res.body.text()
  if (res.statusCode === 401) throw new Error('CalDAV отклонил вход — проверьте пароль приложения.')
  if (res.statusCode >= 400 && res.statusCode !== 207) {
    throw new Error(`CalDAV ответил ${res.statusCode}`)
  }
  return text
}

/** Первое вхождение тега (без учёта namespace-префикса). */
const tagText = (xml: string, local: string): string | null =>
  new RegExp(`<[^>:]*:?${local}[^>]*>([\\s\\S]*?)</[^>:]*:?${local}>`, 'i').exec(xml)?.[1]?.trim() ?? null

/** Все <href> внутри блоков <response>, у которых resourcetype содержит calendar. */
function calendarHrefs(xml: string): string[] {
  const out: string[] = []
  const re = /<[^>:]*:?response[^>]*>([\s\S]*?)<\/[^>:]*:?response>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const block = m[1]
    if (/<[^>:]*:?calendar[\s/>]/i.test(block)) {
      const href = tagText(block, 'href')
      if (href) out.push(href)
    }
  }
  return out
}

const resolve = (origin: string, href: string): string =>
  href.startsWith('http') ? href : new URL(href, origin).toString()

async function discoverCalendars(ctx: SyncContext): Promise<string[]> {
  const root = base(ctx.service.options.caldavUrl || ctx.service.baseUrl)
  const origin = new URL(root).origin

  // 1. principal
  const p1 = await dav(
    ctx,
    root,
    'PROPFIND',
    '0',
    `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`
  )
  const principalHref = tagText(p1, 'href')
  const principal = principalHref ? resolve(origin, principalHref) : root

  // 2. calendar-home-set
  const p2 = await dav(
    ctx,
    principal,
    'PROPFIND',
    '0',
    `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`
  )
  const homeHref = tagText(p2, 'href')
  const home = homeHref ? resolve(origin, homeHref) : principal

  // 3. список календарей
  const p3 = await dav(
    ctx,
    home,
    'PROPFIND',
    '1',
    `<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`
  )
  const hrefs = calendarHrefs(p3).map((h) => resolve(origin, h))
  // Если обнаружение не дало календарей — пробуем сам home как коллекцию.
  return hrefs.length ? hrefs : [home]
}

/* ── Разбор ICS ──────────────────────────────────────────────────── */

function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/)
}

function parseIcsDate(val: string): number | null {
  // Форматы: 20260115T130000Z, 20260115T130000, 20260115 (VALUE=DATE).
  const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(val)
  if (!m) return null
  const [, y, mo, d, hh = '0', mm = '0', ss = '0', z] = m
  const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
  // Без Z время локальное — поправка на смещение, чтобы не уехать на часы.
  return z ? t : t + new Date(t).getTimezoneOffset() * 60_000
}

function parseEvents(ctx: SyncContext, ics: string): Item[] {
  const lines = unfold(ics)
  const items: Item[] = []
  let cur: Record<string, string> | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {}
    else if (line === 'END:VEVENT') {
      if (cur) {
        const start = cur.DTSTART ? parseIcsDate(cur.DTSTART) : null
        const end = cur.DTEND ? parseIcsDate(cur.DTEND) : null
        const uid = cur.UID || Math.random().toString(36)
        items.push({
          id: itemId(ctx.service, `event:${uid}`),
          envId: ctx.service.envId,
          serviceId: ctx.service.id,
          kind: 'event',
          title: cur.SUMMARY || '(без названия)',
          body: cur.LOCATION || '',
          author: null,
          state: 'встреча',
          url: ctx.service.baseUrl || base(ctx.service.options.caldavUrl || ''),
          updatedAt: start ?? Date.now(),
          unread: false,
          mentioned: false,
          startsAt: start,
          endsAt: end
        })
      }
      cur = null
    } else if (cur) {
      // KEY;params:value — берём имя свойства до ; и :
      const idx = line.indexOf(':')
      if (idx > 0) {
        const key = line.slice(0, idx).split(';')[0].toUpperCase()
        cur[key] = line.slice(idx + 1)
      }
    }
  }
  return items
}

/**
 * Окно, которое забирает `syncCaldav`. Вынесено наружу, потому что по нему же
 * чистится локальная копия: отчёт `calendar-query` с `time-range` отдаёт весь
 * диапазон целиком, поэтому всё, чего в нём нет, на сервере уже не существует.
 */
export function caldavWindow(now = Date.now()): { from: number; to: number } {
  return { from: now, to: now + 30 * 86400_000 }
}

export async function syncCaldav(ctx: SyncContext): Promise<Item[]> {
  const calendars = await discoverCalendars(ctx)
  const win = caldavWindow()
  const now = new Date(win.from)
  const end = new Date(win.to)
  const fmt = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

  const report = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${fmt(now)}" end="${fmt(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`

  const all: Item[] = []
  for (const cal of calendars) {
    try {
      const xml = await dav(ctx, cal, 'REPORT', '1', report)
      // calendar-data может быть экранирован в XML — снимаем сущности.
      const unesc = xml
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
      // Берём только блоки VCALENDAR, чтобы не ловить XML-мусор.
      const re = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g
      let m: RegExpExecArray | null
      while ((m = re.exec(unesc))) all.push(...parseEvents(ctx, m[0]))
    } catch {
      // один календарь не читается — не рушим остальные
    }
  }
  // Дедуп по id (повторяющиеся события из разных коллекций).
  const seen = new Set<string>()
  return all.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
}
