import { randomUUID } from 'node:crypto'
import type { Item, MailFolder } from '@shared/types'
import { base, stripHtml } from '../http'
import { itemId, type SyncContext, type SyncResult } from '../types'
import { patchConfig, getConfig } from '../../config/store'
import { logInfo, logWarn } from '../../log'
import { EasClient, EAS_DEVICE_TYPE, EAS_PROTOCOL_VERSION, find, text, type Node } from './client'
import { easDnsProbe } from './dns'
import { harvestEvent, harvestMail, rememberPeople, type SeenPerson } from '../../contacts/harvest'
import {
  calendarWindow,
  expandEventOccurrences,
  isCanceledMeeting
} from './recurrence'

/**
 * Почта и календарь по Exchange ActiveSync (спека AAS Mail).
 *
 * Exchange ActiveSync (MS-ASCMD). Только EAS: без IMAP/SMTP/EWS/Graph.
 * Логин — email или DOMAIN\\user, пароль — keychain.
 */

/** Адрес EAS по умолчанию выводится из базового URL сервиса. */
function endpointOf(ctx: SyncContext): string {
  const explicit = ctx.service.options.easUrl?.trim()
  if (explicit) return explicit
  return `${base(ctx.service.baseUrl)}/Microsoft-Server-ActiveSync`
}

/** Стабильный DeviceId на сервис. При смене DeviceType — новый id (сервер вяжет пару). */
function deviceIdOf(ctx: SyncContext): string {
  const existing = ctx.service.options.easDeviceId
  const storedType = ctx.service.options.easDeviceType
  if (existing && storedType === EAS_DEVICE_TYPE) return existing
  const id = randomUUID().replace(/-/g, '').slice(0, 32)
  const cfg = getConfig()
  patchConfig({
    services: cfg.services.map((s) =>
      s.id === ctx.service.id
        ? { ...s, options: { ...s.options, easDeviceId: id, easDeviceType: EAS_DEVICE_TYPE } }
        : s
    )
  })
  return id
}

/** EAS-дата: ISO `2026-10-02T06:00:00.000Z` или compact `20261002T060000Z`. */
function parseEasDate(v: string | null): number | null {
  if (!v) return null
  const s = v.trim()
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(s)
  if (compact) {
    const [, y, mo, d, hh, mm, ss, z] = compact
    const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
    return z ? t : t
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Тело из AirSyncBase/Body: Type 1 = text, 2 = HTML. */
export function extractBody(data: Node | null): { text: string; html: string | null } {
  if (!data) return { text: '', html: null }
  const bodies = data.children.filter((c) => c.name === 'Body')
  // Ищем среди прямых и вложенных Body.
  const allBodies = bodies.length ? bodies : []
  const walkBodies: Node[] = [...allBodies]
  const stack = [...data.children]
  while (stack.length) {
    const n = stack.pop()!
    if (n.name === 'Body') walkBodies.push(n)
    stack.push(...n.children)
  }
  let html: string | null = null
  let plain = ''
  for (const b of walkBodies) {
    const type = text(b, 'Type')
    const content = text(b, 'Data') ?? b.text ?? ''
    if (!content) continue
    if (type === '2') html = content
    else if (type === '1') plain = content
    else if (!plain && !html) plain = content
  }
  if (!plain && html) plain = stripHtml(html)
  return { text: plain, html }
}

/**
 * Письмо списка. `folder` различает «Входящие»/«Отправленные»/«Черновики» —
 * для отправленных и черновиков автор письма обычно не интересен (это я),
 * поэтому там в author кладём получателя (To), а не From.
 */
function mailItem(ctx: SyncContext, serverId: string, data: Node, folder: MailFolder): Item {
  const from = text(data, 'From') ?? ''
  const to = text(data, 'To') ?? ''
  const who = folder === 'inbox' ? from : to
  // Обычно вида: Имя <addr@dom> — достаём отображаемое имя.
  const name = /"?([^"<]+?)"?\s*<.*>/.exec(who)?.[1]?.trim() || who || null
  const received = parseEasDate(text(data, 'DateReceived'))
  const read = text(data, 'Read') === '1'
  const { text: bodyPreview } = extractBody(data)
  return {
    id: itemId(ctx.service, `mail:${serverId}`),
    envId: ctx.service.envId,
    serviceId: ctx.service.id,
    kind: 'mail',
    title: text(data, 'Subject') || '(без темы)',
    body: bodyPreview.slice(0, 2000),
    author: name,
    // Отправленные/черновики всегда «прочитаны» — непрочитанность для своих же писем не имеет смысла.
    state: folder !== 'inbox' ? null : read ? 'прочитано' : 'непрочитано',
    url: base(ctx.service.baseUrl),
    updatedAt: received ?? Date.now(),
    unread: folder === 'inbox' && !read,
    mentioned: false,
    startsAt: null,
    endsAt: null,
    folder
  }
}

function eventLocation(data: Node): string {
  // 16.x: AirSyncBase/Location/DisplayName; ≤14.1: Calendar/Location строка.
  const box = find(data, 'Location')
  if (box) {
    const name = text(box, 'DisplayName')
    if (name?.trim()) return name.trim()
    if (box.text?.trim()) return box.text.trim()
  }
  return ''
}

/** Место + ссылка на встречу + краткое тело — для модалки и линков. */
function eventBody(data: Node): string {
  const parts: string[] = []
  if (text(data, 'AllDayEvent') === '1') parts.push('allday:1')
  const loc = eventLocation(data)
  if (loc) parts.push(loc)
  const conf = text(data, 'OnlineMeetingConfLink')?.trim()
  const ext = text(data, 'OnlineMeetingExternalLink')?.trim()
  if (ext) parts.push(ext)
  else if (conf) parts.push(conf)
  const { text: plain } = extractBody(data)
  if (plain?.trim()) parts.push(plain.trim().slice(0, 4000))
  return parts.join('\n')
}

/**
 * Состояние RSVP из MeetingStatus / ResponseType (MS-ASCAL).
 * UI кнопки Accept/Decline смотрит на «не отвечено» / «под вопросом».
 *
 * MeetingStatus — битовая маска: 1 — это встреча (а не личное событие),
 * 2 — она пришла от кого-то другого, 4 — отменена. Бит отмены здесь
 * сознательно не разбираем: Exchange банка ставит его и живым встречам
 * (см. isCanceledMeeting), поэтому 5 читаем как 1, а 7 — как 3.
 */
function eventResponseState(data: Node): string {
  const ms = Number(text(data, 'MeetingStatus') ?? '')
  const rt = text(data, 'ResponseType')
  const isMeeting = Number.isFinite(ms) && (ms & 1) === 1
  const fromSomeoneElse = isMeeting && (ms & 2) === 2

  if (isMeeting && !fromSomeoneElse) return 'организатор'
  if (rt === '1') return 'организатор'
  if (rt === '3') return 'принята'
  if (rt === '2') return 'под вопросом'
  if (rt === '4') return 'отклонена'
  if (fromSomeoneElse || rt === '5' || rt === '0') return 'не отвечено'
  return 'встреча'
}

function eventTitle(data: Node, start: number | null): string {
  const subject = text(data, 'Subject')?.trim()
  if (subject) return subject
  const loc = eventLocation(data)
  if (loc) return loc
  if (start != null) {
    const d = new Date(start)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  return '(без названия)'
}

/** Достаём start/end: сначала поля AirSync, иначе DTSTART/DTEND из тела ICS. */
function eventTimes(data: Node): { start: number | null; end: number | null } {
  let start =
    parseEasDate(text(data, 'StartTime')) ??
    parseEasDate(text(data, 'DtStamp'))
  let end = parseEasDate(text(data, 'EndTime'))

  if (start == null) {
    const { text: body } = extractBody(data)
    const icsStart = /DTSTART[^:]*:(\d{8}T\d{6}Z?)/i.exec(body)?.[1]
    const icsEnd = /DTEND[^:]*:(\d{8}T\d{6}Z?)/i.exec(body)?.[1]
    start = parseIcsStamp(icsStart)
    end = parseIcsStamp(icsEnd) ?? end
  }
  return { start, end }
}

function parseIcsStamp(v: string | null | undefined): number | null {
  if (!v) return null
  return parseEasDate(v)
}

function eventItem(
  ctx: SyncContext,
  serverId: string,
  data: Node,
  start: number | null,
  end: number | null,
  occKey?: string
): Item {
  return {
    id: itemId(ctx.service, occKey ? `event:${serverId}:${occKey}` : `event:${serverId}`),
    envId: ctx.service.envId,
    serviceId: ctx.service.id,
    kind: 'event',
    title: eventTitle(data, start),
    body: eventBody(data),
    author: text(data, 'OrganizerName'),
    state: eventResponseState(data),
    url: base(ctx.service.baseUrl),
    updatedAt: start ?? Date.now(),
    unread: false,
    mentioned: false,
    startsAt: start,
    endsAt: end
  }
}

function compactOccKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** Разбор ApplicationData календаря → 0..N Item (серии разворачиваем в окно). */
function calendarItemsFromAdd(
  ctx: SyncContext,
  serverId: string,
  data: Node,
  win: { start: number; end: number }
): Item[] {
  const { start: masterStart, end: masterEnd } = eventTimes(data)
  if (masterStart == null) {
    const fields = data.children.map((c) => c.name).join(',')
    logWarn('mail', `календарь ${serverId}: нет StartTime (поля: ${fields || 'пусто'})`)
    return []
  }
  const title = eventTitle(data, masterStart)
  // Отменённую встречу раньше просто выбрасывали из синка. Но локальная копия
  // при этом оставалась в базе — с прежним названием и статусом «принята», и
  // убрать её было уже нечем: мы только дописываем элементы, но не удаляем.
  // Поэтому отдаём её как обычную, но с состоянием «отменена»: сетка календаря
  // покажет её зачёркнутой, а «Сегодня» и счётчики такие пропускают.
  const canceled = isCanceledMeeting(title)

  const occs = expandEventOccurrences(data, masterStart, masterEnd, win.start, win.end)
  const hasRecurrence = find(data, 'Recurrence') != null
  const items = occs.map((o) =>
    eventItem(ctx, serverId, data, o.start, o.end, hasRecurrence ? compactOccKey(o.start) : undefined)
  )
  return canceled ? items.map((it) => ({ ...it, state: 'отменена' })) : items
}

export async function createEasClient(
  ctx: SyncContext,
  opts: { background?: boolean } = {}
): Promise<EasClient> {
  if (!ctx.service.baseUrl && !ctx.service.options.easUrl) throw new Error('Не задан адрес почты')
  if (!ctx.secret) throw new Error('Не задан пароль')

  // Логин для Basic: email или DOMAIN\user. User= в query — без домена (EasClient).
  const candidates = uniqueNonEmpty([
    ...expandLoginCandidates(ctx.service.auth.username),
    ctx.service.options.email
  ])
  if (!candidates.length) throw new Error('Не задан логин (email или DOMAIN\\user)')

  const endpoint = endpointOf(ctx)
  try {
    const host = new URL(endpoint).hostname
    const dns = await easDnsProbe(host)
    if (dns.systemPrivate) {
      logInfo(
        'mail',
        `EAS DNS: система даёт ${dns.system} (intranet) для ${host} — используем его (публичный ${dns.public ?? '?'})`
      )
    } else if (dns.system) {
      logInfo('mail', `EAS DNS: система ${dns.system} для ${host}`)
    } else if (dns.public) {
      logWarn('mail', `EAS DNS: системы нет, публичный ${dns.public} для ${host}`)
    }
  } catch {
    /* probe не блокирует вход */
  }

  const password = ctx.secret.trim()
  if (!password) throw new Error('Пароль пустой (пробелы). Задайте пароль заново.')

  let lastErr: Error | null = null
  const remaining = [...candidates]
  for (const user of candidates) {
    remaining.shift()
    const client = new EasClient(
      endpoint,
      user,
      password,
      deviceIdOf(ctx),
      ctx.env,
      EAS_DEVICE_TYPE,
      EAS_PROTOCOL_VERSION
    )
    // Фоновый синк уступает очередь запросам пользователя (см. EasClient.priority).
    if (opts.background) client.priority = 'background'
    // Устройство уже провижено этой учёткой в этом запуске — ключ общий, второй
    // Provision не нужен (на Ecom он выдаёт новый ключ и ломает параллельные запросы).
    // Если ключ устарел, первый же запрос получит 449 и перепровизит сам.
    if (client.hasPolicy()) return client
    try {
      await client.provision()
      logInfo(
        'mail',
        `EAS: вход Basic «${user}», User=«${user.includes('\\') ? user.split('\\').pop() : user}» (${EAS_PROTOCOL_VERSION}/${EAS_DEVICE_TYPE})`
      )
      return client
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (!/401/.test(lastErr.message)) throw lastErr
      const more = remaining.length > 0
      logWarn('mail', `EAS 401 для «${user}»${more ? ', пробуем другой логин' : ''}`)
    }
  }
  throw lastErr ?? new Error('EAS отклонил вход (401)')
}

/** Варианты логина для Basic: email как есть; DOMAIN\user — разные регистры домена. */
function expandLoginCandidates(raw: string | null | undefined): string[] {
  const s = raw?.trim()
  if (!s) return []
  if (s.includes('@')) return [s]
  if (s.includes('\\')) {
    const i = s.indexOf('\\')
    const domain = s.slice(0, i)
    const user = s.slice(i + 1)
    if (!domain || !user) return [s]
    return uniqueNonEmpty([
      s,
      `${domain}\\${user}`,
      `${domain.toLowerCase()}\\${user}`,
      `${domain.toUpperCase()}\\${user}`,
      user
    ])
  }
  return [s]
}

function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const s = v?.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

export async function syncEas(ctx: SyncContext): Promise<SyncResult> {
  const client = await createEasClient(ctx, { background: true })
  const folders = await client.folderSync()
  const byTypeOrName = (type: string, names: string[]): (typeof folders)[number] | undefined => {
    const byType = folders.find((f) => f.type === type)
    if (byType) return byType
    const lower = names.map((n) => n.toLowerCase())
    return folders.find((f) => lower.some((n) => f.name.toLowerCase().includes(n)))
  }
  const inbox = byTypeOrName('2', ['inbox', 'входящие'])
  const drafts = byTypeOrName('3', ['drafts', 'черновики'])
  const sent = byTypeOrName('5', ['sent', 'отправленные'])
  // Только основной календарь (type 8). Пользовательские (13) часто дают
  // пустые/служебные записи без темы и засоряют сетку.
  const calendar = folders.find((f) => f.type === '8')
  logInfo(
    'mail',
    `EAS папки: inbox=${inbox?.serverId ?? '—'} sent=${sent?.serverId ?? '—'} drafts=${drafts?.serverId ?? '—'} (всего ${folders.length})`
  )

  const items: Item[] = []
  /** Отправители/получатели/участники — в адресную книгу (contacts). */
  const people: SeenPerson[] = []

  if (inbox) {
    // Проверено эмпирически: FilterType выше '5' (1 месяц) сервер банка для
    // класса Email не принимает вовсе — отвечает глобальным голым
    // <Sync><Status>4</Status></Sync> без деталей по коллекции, причём это
    // падает даже на «Входящих». '6'/'7' у этого Exchange работают только
    // для Calendar. Глубину истории поэтому тянем не FilterType, а страницами:
    // maxPages 3→12 — чтобы долистать до конца того же месяца, а не
    // обрываться на половине (отсюда был обрыв на ~21 сентября).
    const { adds } = await client.syncItems(inbox.serverId, {
      windowSize: 100,
      filterType: '5',
      bodyBytes: 100_000,
      maxPages: 12,
      wantHtml: true
    })
    for (const add of adds) {
      const data = find(add, 'ApplicationData')
      if (!data) continue
      const serverId = text(add, 'ServerId')
      if (!serverId) continue
      items.push(mailItem(ctx, serverId, data, 'inbox'))
      people.push(...harvestMail(data, 'inbox'))
    }
  }

  // Отправленные и черновики — тот же месячный FilterType, что и у входящих
  // (см. комментарий выше): '6' здесь так же глушит Sync целиком.
  for (const [folder, dir] of [
    ['sent', sent],
    ['drafts', drafts]
  ] as const) {
    if (!dir) continue
    try {
      const { adds } = await client.syncItems(dir.serverId, {
        windowSize: 50,
        filterType: '5',
        bodyBytes: folder === 'drafts' ? 8_192 : 20_000,
        maxPages: 6,
        wantHtml: folder !== 'drafts'
      })
      for (const add of adds) {
        const data = find(add, 'ApplicationData')
        if (!data) continue
        const serverId = text(add, 'ServerId')
        if (!serverId) continue
        items.push(mailItem(ctx, serverId, data, folder))
        people.push(...harvestMail(data, folder))
      }
    } catch (err) {
      // Отсутствие папки или временная ошибка не должны ронять синк входящих.
      logWarn('mail', `EAS ${folder}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const win = calendarWindow()
  /**
   * Календарная выдача дочитана целиком — по ней можно убрать из локальной
   * копии встречи, которых на сервере больше нет (отменили и пересоздали,
   * перенесли серию, удалили). Если хоть один календарь не дочитался, окно
   * не объявляем: чистка по дырявой выдаче стёрла бы живые встречи.
   */
  let calendarComplete = false

  if (calendar) {
    // FilterType 6 ≈ 3 месяца назад; будущее и серии — через expand.
    const { adds, complete } = await client.syncItems(calendar.serverId, {
      windowSize: 100,
      filterType: '6',
      bodyBytes: 1024,
      maxPages: 12
    })
    calendarComplete = complete
    let kept = 0
    for (const add of adds) {
      const data = find(add, 'ApplicationData')
      if (!data) continue
      const serverId = text(add, 'ServerId')
      if (!serverId) continue
      const evs = calendarItemsFromAdd(ctx, serverId, data, win)
      items.push(...evs)
      people.push(...harvestEvent(data))
      kept += evs.length
    }
    logInfo('mail', `EAS календарь: Add=${adds.length}, вхождений=${kept}`)
  }

  for (const cal of folders.filter((f) => f.type === '13')) {
    try {
      const { adds, complete } = await client.syncItems(cal.serverId, {
        windowSize: 50,
        filterType: '6',
        bodyBytes: 1024,
        maxPages: 4
      })
      if (!complete) calendarComplete = false
      for (const add of adds) {
        const data = find(add, 'ApplicationData')
        if (!data) continue
        const serverId = text(add, 'ServerId')
        if (!serverId) continue
        for (const ev of calendarItemsFromAdd(ctx, serverId, data, win)) {
          if (ev.title === '(без названия)') continue
          items.push(ev)
        }
        people.push(...harvestEvent(data))
      }
    } catch {
      // Один лишний календарь не должен валить весь синк — но и чистить по
      // неполной выдаче нельзя: его встречи в окно просто не попали.
      calendarComplete = false
    }
  }

  // Адресная книга для подсказок получателей (почта, встречи) — одной транзакцией.
  rememberPeople(people, ctx.service.envId)
  return {
    items,
    cursor: String(Date.now()),
    prune: calendarComplete ? [{ kind: 'event', from: win.start, to: win.end }] : []
  }
}

export { find, text }
export type { Node }
