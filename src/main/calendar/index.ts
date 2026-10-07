import { randomUUID } from 'node:crypto'
import type {
  CalendarCancelPayload,
  CalendarMeetingDetails,
  CalendarUpdatePayload,
  Item
} from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { deleteItemsByPrefix, getItem, upsertItems } from '../db'
import type { SyncContext } from '../connectors/types'
import { itemId } from '../connectors/types'
import { createEasClient } from '../connectors/eas'
import { el, find, findAll, text, type El } from '../connectors/eas/wbxml'
import { base, stripHtml } from '../connectors/http'
import { logInfo, logWarn } from '../log'

export type MeetingResponseKind = 'accept' | 'tentative' | 'decline'

export interface CalendarCreatePayload {
  serviceId: string
  subject: string
  startsAt: number
  endsAt: number
  location?: string
  body?: string
  /** Email участников через запятую / пробел / `;`. */
  attendees?: string
  allDay?: boolean
}

/**
 * Разобрать id `env:service:event:serverId` или `…:event:serverId:occKey`.
 * ServerId у Exchange сам содержит двоеточие (`7:42` — папка:элемент), поэтому
 * меткой вхождения считаем только хвост вида `20261007T100000Z`. Раньше резали
 * по первому двоеточию — `7:42` превращался во «встречу 7, вхождение 42», и
 * ответы на приглашения в банковском ящике уходили не туда.
 */
function parseEventId(id: string): {
  serviceId: string
  serverId: string
  instanceCompact?: string
} {
  const marker = ':event:'
  const i = id.indexOf(marker)
  if (i < 0) throw new Error('Некорректный id события')
  const prefix = id.slice(0, i)
  const serviceId = prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1) : prefix
  const rest = id.slice(i + marker.length)
  if (!serviceId || !rest) throw new Error('Некорректный id события')
  const occ = /:(\d{8}T\d{6}Z)$/.exec(rest)
  if (!occ) return { serviceId, serverId: rest }
  return { serviceId, serverId: rest.slice(0, occ.index), instanceCompact: occ[1] }
}

function contextFor(serviceId: string): SyncContext {
  const cfg = getConfig()
  const service = cfg.services.find((s) => s.id === serviceId)
  if (!service) throw new Error('Сервис календаря не найден')
  const env = cfg.envs.find((e) => e.id === service.envId)
  if (!env) throw new Error('Контур не найден')
  return {
    env,
    service,
    secret: getSecret(`${service.id}.secret`),
    cursor: null
  }
}

function protocolOf(ctx: SyncContext): string {
  return ctx.service.options.protocol || (ctx.service.options.jmapUrl ? 'jmap' : 'eas')
}

function compactUtc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** UTC TIME_ZONE_INFORMATION — 172 нуля (как AAS). */
/**
 * Calendar:Timezone по MS-ASDTYPE 2.7.6: структура TIME_ZONE_INFORMATION
 * (172 байта), закодированная в base64 и переданная обычной строкой WBXML —
 * «MUST be encoded and transmitted as inline strings». Раньше слали сырые
 * байты (OPAQUE): сервер Ecom прощал, Exchange банка отвечал Status=6 на любую
 * встречу. Пояс — системный (для Москвы Bias = −180), без перехода на летнее
 * время; StartTime/EndTime всё равно в UTC, пояс нужен для показа в Outlook.
 */
function localTimezoneBase64(at: number): string {
  const buf = Buffer.alloc(172, 0)
  buf.writeInt32LE(new Date(at).getTimezoneOffset(), 0) // Bias: UTC = local + Bias
  const name = (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').slice(0, 31)
  buf.write(name, 4, 'utf16le') // StandardName, 32 WCHAR
  buf.write(name, 88, 'utf16le') // DaylightName (4 + 64 + 16 + 4)
  return buf.toString('base64')
}

function parseAttendees(raw: string | undefined): { email: string; name: string }[] {
  if (!raw?.trim()) return []
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ email, name: email.split('@')[0] || email }))
}

const USER_RESPONSE: Record<MeetingResponseKind, '1' | '2' | '3'> = {
  accept: '1',
  tentative: '2',
  decline: '3'
}

const STATE_AFTER: Record<MeetingResponseKind, string> = {
  accept: 'принята',
  tentative: 'под вопросом',
  decline: 'отклонена'
}

/**
 * Принять / под вопросом / отклонить встречу.
 * CollectionId = Calendar, RequestId = ServerId календарного item (как AAS).
 */
export async function respondToMeeting(
  itemIdStr: string,
  response: MeetingResponseKind
): Promise<Item> {
  const { serviceId, serverId, instanceCompact } = parseEventId(itemIdStr)
  const existing = getItem(itemIdStr)
  if (!existing || existing.kind !== 'event') throw new Error('Событие не найдено локально')

  const ctx = contextFor(serviceId)
  if (protocolOf(ctx) !== 'eas') {
    throw new Error('Ответ на встречу пока только через EAS')
  }

  const client = await createEasClient(ctx)
  const folders = await client.folderSync()
  const calendar = folders.find((f) => f.type === '8')
  if (!calendar) throw new Error('Папка «Календарь» не найдена')

  await client.meetingRespond(calendar.serverId, serverId, USER_RESPONSE[response], {
    instanceCompact,
    notify: true
  })
  logInfo('mail', `MeetingResponse ${response} → ${serverId}${instanceCompact ? `@${instanceCompact}` : ''}`)

  const next: Item = {
    ...existing,
    state: STATE_AFTER[response],
    updatedAt: Date.now()
  }
  upsertItems([next])
  return next
}

/** Создать встречу / событие в календаре (Sync Add). */
export async function createMeeting(payload: CalendarCreatePayload): Promise<Item> {
  if (!payload.subject.trim()) throw new Error('Укажите тему')
  if (!(payload.startsAt > 0) || !(payload.endsAt > payload.startsAt)) {
    throw new Error('Некорректный интервал времени')
  }

  const ctx = contextFor(payload.serviceId)
  if (protocolOf(ctx) !== 'eas') {
    throw new Error('Создание встреч пока только через EAS')
  }

  const attendees = parseAttendees(payload.attendees)
  const isMeeting = attendees.length > 0
  const clientUid = randomUUID().replace(/-/g, '')
  const stamp = compactUtc(Date.now())
  const start = compactUtc(payload.startsAt)
  const end = compactUtc(payload.endsAt)

  /**
   * Поля встречи по MS-ASCAL для протокола 16.0/16.1 (его мы и объявляем).
   * В запросе клиента там НЕЛЬЗЯ: UID (вместо него ClientUid), DtStamp,
   * OrganizerEmail/OrganizerName (сервер сам подставит текущего пользователя),
   * ResponseType (нельзя ни в какой версии). Exchange банка на любое из них
   * отвечал Status=6 «ошибка конвертации» — встреча не создавалась вовсе.
   * Location и Body — только в пространстве AirSyncBase (строкой тоже Status=6).
   *
   * `legacy` — запасной набор для нестандартных серверов (как писали раньше:
   * с UID/DtStamp/организатором). Им пробуем, только если строгий отклонён.
   */
  const buildFields = (legacy: boolean): El[] => {
    const fields: El[] = [el(4, 'TimeZone', localTimezoneBase64(payload.startsAt))]
    if (legacy) fields.push(el(4, 'UID', clientUid), el(4, 'DtStamp', stamp))
    fields.push(
      el(4, 'ClientUid', clientUid),
      el(4, 'StartTime', start),
      el(4, 'EndTime', end),
      el(4, 'Subject', payload.subject.trim()),
      el(4, 'BusyStatus', '2'),
      el(4, 'Sensitivity', '0'),
      el(4, 'AllDayEvent', payload.allDay ? '1' : '0'),
      el(4, 'MeetingStatus', isMeeting ? '1' : '0'),
      el(4, 'Reminder', '15')
    )
    if (legacy && isMeeting) {
      const email = (ctx.service.options.email || ctx.service.auth.username || '').trim()
      if (email.includes('@')) {
        fields.push(el(4, 'OrganizerEmail', email), el(4, 'OrganizerName', email.split('@')[0] || email))
      }
    }
    if (payload.location?.trim()) {
      fields.push(el(17, 'Location', [el(17, 'DisplayName', payload.location.trim())]))
    }
    if (isMeeting) {
      fields.push(
        el(
          4,
          'Attendees',
          attendees.map((a) =>
            el(4, 'Attendee', [
              el(4, 'AttendeeEmail', a.email),
              el(4, 'AttendeeName', a.name),
              el(4, 'AttendeeType', '1')
            ])
          )
        )
      )
    }
    if (payload.body?.trim()) {
      fields.push(el(17, 'Body', [el(17, 'Type', '1'), el(17, 'Data', payload.body.trim())]))
    }
    return fields
  }

  const client = await createEasClient(ctx)
  const folders = await client.folderSync()
  const calendar = folders.find((f) => f.type === '8')
  if (!calendar) throw new Error('Папка «Календарь» не найдена')

  let serverId: string
  try {
    serverId = await client.syncAdd(calendar.serverId, el(0, 'ApplicationData', buildFields(false)))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/Status=6\b/.test(msg)) throw new Error(humanizeSyncAddError(msg))
    // Строгий набор отклонён — сервер, видимо, ждёт поля старых версий.
    logWarn('mail', `создание встречи: строгий формат 16.x отклонён (${msg}), пробуем совместимый`)
    try {
      serverId = await client.syncAdd(calendar.serverId, el(0, 'ApplicationData', buildFields(true)))
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2)
      throw new Error(humanizeSyncAddError(msg2))
    }
  }
  logInfo('mail', `создана встреча ${serverId}: ${payload.subject.trim()}`)

  const item: Item = {
    id: itemId(ctx.service, `event:${serverId}`),
    envId: ctx.service.envId,
    serviceId: ctx.service.id,
    kind: 'event',
    title: payload.subject.trim(),
    body: [payload.location?.trim(), payload.body?.trim()].filter(Boolean).join('\n'),
    author: ctx.service.options.email || ctx.service.auth.username || null,
    state: isMeeting ? 'организатор' : 'встреча',
    url: base(ctx.service.baseUrl),
    updatedAt: payload.startsAt,
    unread: false,
    mentioned: false,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt
  }
  upsertItems([item])
  return item
}

/** Status=6 и др. — в человекочитаемый текст для диалога. */
function humanizeSyncAddError(msg: string): string {
  const m = /Status=(\d+)/i.exec(msg)
  const code = m?.[1]
  if (code === '6') {
    return 'Сервер отклонил встречу (ошибка формата данных). Проверьте время, участников и место — и попробуйте ещё раз.'
  }
  if (code === '3') return 'Календарь рассинхронизирован. Обновите данные и повторите.'
  if (code === '7') return 'Конфликт с уже существующей встречей на сервере.'
  if (code === '8') return 'Папка календаря не найдена на сервере.'
  return msg.startsWith('EAS') ? msg : `Не удалось создать встречу: ${msg}`
}

/* ── Изменение и отмена своих встреч ─────────────────────────────────── */

/** Свою встречу можно менять: я организатор или это просто событие без участников. */
function assertOwnEvent(item: Item | null): asserts item is Item {
  if (!item || item.kind !== 'event') throw new Error('Встреча не найдена локально — обновите календарь')
  if (item.state !== 'организатор' && item.state !== 'встреча') {
    throw new Error('Менять и отменять можно только встречи, которые создали вы')
  }
}

/**
 * Папка встречи. ServerId Exchange — «папка:элемент», так что берём папку из
 * него (встреча может лежать в дополнительном календаре), иначе — основной.
 */
async function calendarFor(
  client: Awaited<ReturnType<typeof createEasClient>>,
  serverId: string
): Promise<string> {
  const folders = await client.folderSync()
  const fromId = serverId.includes(':') ? serverId.slice(0, serverId.indexOf(':')) : null
  const byId = fromId ? folders.find((f) => f.serverId === fromId && (f.type === '8' || f.type === '13')) : undefined
  const main = folders.find((f) => f.type === '8')
  const folder = byId ?? main
  if (!folder) throw new Error('Папка «Календарь» не найдена')
  return folder.serverId
}

function humanizeChangeError(msg: string, verb: string): string {
  const code = /Status=(\d+)/i.exec(msg)?.[1]
  if (code === '6') return `Сервер отклонил изменения (ошибка формата данных) — ${verb} не удалось.`
  if (code === '7') return 'Встречу одновременно изменили на сервере. Обновите календарь и повторите.'
  if (code === '8') return 'Встреча уже удалена на сервере. Обновите календарь.'
  return msg.startsWith('EAS') || msg.startsWith('Exchange') ? msg : `Не удалось ${verb}: ${msg}`
}

/** Детали с сервера (участники, место, описание) — для формы редактирования. */
export async function getMeetingDetails(itemIdStr: string): Promise<CalendarMeetingDetails> {
  const { serviceId, serverId, instanceCompact } = parseEventId(itemIdStr)
  const ctx = contextFor(serviceId)
  if (protocolOf(ctx) !== 'eas') throw new Error('Детали встречи пока только через EAS')
  const client = await createEasClient(ctx)
  const collectionId = await calendarFor(client, serverId)
  const props = await client.fetchItem(collectionId, serverId)

  const attendees = findAll(find(props, 'Attendees'), 'Attendee')
    .map((a) => {
      const email = (text(a, 'AttendeeEmail') ?? '').trim().toLowerCase()
      const name = (text(a, 'AttendeeName') ?? '').trim()
      return { email, name: name || email.split('@')[0] || email, source: 'local' as const }
    })
    .filter((p) => p.email.includes('@'))

  const loc = find(props, 'Location')
  const location = (text(loc, 'DisplayName') ?? loc?.text ?? '').trim()
  const bodyNode = find(props, 'Body')
  const raw = text(bodyNode, 'Data') ?? ''
  const body = (text(bodyNode, 'Type') === '2' ? stripHtml(raw) : raw).trim()

  return { location, body, attendees, recurring: Boolean(instanceCompact) || find(props, 'Recurrence') != null }
}

/**
 * Изменить или перенести свою встречу. Только переданные поля: в EAS 16.x
 * остальное на сервере не трогается, а участникам обновление рассылает сервер.
 * Повторяющаяся встреча меняется только в этом вхождении.
 */
export async function updateMeeting(payload: CalendarUpdatePayload): Promise<Item> {
  const existing = getItem(payload.itemId)
  assertOwnEvent(existing)
  const { serviceId, serverId, instanceCompact } = parseEventId(payload.itemId)
  const ctx = contextFor(serviceId)
  if (protocolOf(ctx) !== 'eas') throw new Error('Изменение встреч пока только через EAS')

  const startsAt = payload.startsAt ?? existing.startsAt ?? 0
  const endsAt = payload.endsAt ?? existing.endsAt ?? 0
  if (payload.startsAt != null || payload.endsAt != null) {
    if (!(startsAt > 0) || !(endsAt > startsAt)) throw new Error('Некорректный интервал времени')
  }
  if (payload.subject != null && !payload.subject.trim()) throw new Error('Укажите тему')

  const fields: El[] = []
  if (payload.startsAt != null || payload.endsAt != null) {
    fields.push(
      el(4, 'TimeZone', localTimezoneBase64(startsAt)),
      el(4, 'StartTime', compactUtc(startsAt)),
      el(4, 'EndTime', compactUtc(endsAt))
    )
  }
  if (payload.subject != null) fields.push(el(4, 'Subject', payload.subject.trim()))
  if (payload.attendees != null) {
    const attendees = parseAttendees(payload.attendees)
    fields.push(el(4, 'MeetingStatus', attendees.length ? '1' : '0'))
    fields.push(
      el(
        4,
        'Attendees',
        attendees.map((a) =>
          el(4, 'Attendee', [
            el(4, 'AttendeeEmail', a.email),
            el(4, 'AttendeeName', a.name),
            el(4, 'AttendeeType', '1')
          ])
        )
      )
    )
  }
  if (payload.location != null) {
    fields.push(el(17, 'Location', [el(17, 'DisplayName', payload.location.trim())]))
  }
  if (payload.body != null) {
    fields.push(el(17, 'Body', [el(17, 'Type', '1'), el(17, 'Data', payload.body.trim())]))
  }
  if (!fields.length) return existing

  const client = await createEasClient(ctx)
  const collectionId = await calendarFor(client, serverId)
  try {
    await client.syncChange(collectionId, serverId, el(0, 'ApplicationData', fields), instanceCompact)
  } catch (e) {
    throw new Error(humanizeChangeError(e instanceof Error ? e.message : String(e), 'изменить встречу'))
  }
  logInfo('mail', `изменена встреча ${serverId}${instanceCompact ? `@${instanceCompact}` : ''}`)

  const next: Item = {
    ...existing,
    title: payload.subject?.trim() || existing.title,
    startsAt,
    endsAt,
    updatedAt: startsAt || existing.updatedAt,
    state: payload.attendees != null ? (parseAttendees(payload.attendees).length ? 'организатор' : 'встреча') : existing.state,
    body:
      payload.location != null || payload.body != null
        ? [payload.location?.trim(), payload.body?.trim()].filter(Boolean).join('\n')
        : existing.body
  }
  upsertItems([next])
  return next
}

/**
 * Отменить свою встречу: удалить на сервере. Если вы организатор, отмену
 * участникам рассылает сервер (EAS 16.x). У повторяющейся — одно вхождение
 * или вся серия.
 */
export async function cancelMeeting(payload: CalendarCancelPayload): Promise<void> {
  const existing = getItem(payload.itemId)
  assertOwnEvent(existing)
  const { serviceId, serverId, instanceCompact } = parseEventId(payload.itemId)
  const ctx = contextFor(serviceId)
  if (protocolOf(ctx) !== 'eas') throw new Error('Отмена встреч пока только через EAS')
  const series = payload.scope === 'series' || !instanceCompact

  const client = await createEasClient(ctx)
  const collectionId = await calendarFor(client, serverId)
  try {
    await client.syncDelete(collectionId, serverId, series ? undefined : instanceCompact)
  } catch (e) {
    throw new Error(humanizeChangeError(e instanceof Error ? e.message : String(e), 'отменить встречу'))
  }
  logInfo('mail', `отменена встреча ${serverId}${series ? '' : `@${instanceCompact}`}`)

  // Локально убираем сразу, не дожидаясь синка: вся серия — все её вхождения.
  if (series) deleteItemsByPrefix(itemId(ctx.service, `event:${serverId}`))
  else deleteItemsByPrefix(payload.itemId)
}
