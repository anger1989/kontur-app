/**
 * Люди для создания встречи: GAL + локальный кэш, free/busy как в Outlook.
 */
import type {
  CalendarPerson,
  CalendarScheduleQuery,
  CalendarScheduleResult,
  CalendarScheduleRow,
  FreeBusySlot,
  Item
} from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { queryItems } from '../db'
import type { SyncContext } from '../connectors/types'
import { createEasClient } from '../connectors/eas'
import { suggestContacts } from '../contacts'

const SLOT_MS = 30 * 60_000

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

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function parseMerged(merged: string, slotCount: number): FreeBusySlot[] {
  const slots: FreeBusySlot[] = []
  for (let i = 0; i < slotCount; i++) {
    const ch = merged[i]
    const n = ch != null ? Number(ch) : 4
    slots.push(
      n === 0 || n === 1 || n === 2 || n === 3 || n === 4 ? (n as FreeBusySlot) : 4
    )
  }
  return slots
}

/** Слоты busy из локальных событий (для «я»). */
function slotsFromEvents(
  events: { startsAt: number; endsAt: number }[],
  day0: number,
  slotCount: number
): FreeBusySlot[] {
  const slots: FreeBusySlot[] = Array.from({ length: slotCount }, () => 0)
  for (const ev of events) {
    if (ev.startsAt == null || ev.endsAt == null) continue
    const a = Math.max(0, Math.floor((ev.startsAt - day0) / SLOT_MS))
    const b = Math.min(slotCount, Math.ceil((ev.endsAt - day0) / SLOT_MS))
    for (let i = a; i < b; i++) slots[i] = 2
  }
  return slots
}

/**
 * Подсказки участников — общая адресная книга (main/contacts): кому писали и с
 * кем встречались по всем ящикам, затем GAL всех ящиков, а не только того, в
 * чей календарь создаётся встреча. `serviceId` оставлен для совместимости вызова.
 */
export async function suggestPeople(
  _serviceId: string,
  query: string,
  limit = 12
): Promise<CalendarPerson[]> {
  return suggestContacts(query, { limit })
}

/**
 * Планировщик: мои встречи дня + free/busy участников (ResolveRecipients).
 */
export async function getSchedule(query: CalendarScheduleQuery): Promise<CalendarScheduleResult> {
  const { serviceId, startsAt, endsAt, emails } = query
  if (!(startsAt > 0) || !(endsAt > startsAt)) {
    throw new Error('Некорректный интервал')
  }

  const ctx = contextFor(serviceId)
  const day0 = startOfDay(startsAt)
  const day1 = day0 + 86_400_000
  const slotCount = Math.ceil((day1 - day0) / SLOT_MS)

  const myEvents = queryItems({
    kinds: ['event'],
    envIds: [ctx.service.envId],
    limit: 500
  })
    .filter(
      (e): e is Item & { startsAt: number; endsAt: number } =>
        e.serviceId === serviceId &&
        e.id !== query.excludeItemId &&
        e.startsAt != null &&
        e.endsAt != null &&
        e.startsAt < day1 &&
        e.endsAt > day0 &&
        e.state !== 'отменена' &&
        e.state !== 'отклонена'
    )
    .map((e) => ({
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt
    }))
    .sort((a, b) => a.startsAt - b.startsAt)

  const meEmail = (
    ctx.service.options.email ||
    ctx.service.auth.username ||
    'я'
  )
    .trim()
    .toLowerCase()

  const meRow: CalendarScheduleRow = {
    email: meEmail.includes('@') ? meEmail : 'me',
    name: 'Я',
    isSelf: true,
    slots: slotsFromEvents(myEvents, day0, slotCount),
    events: myEvents
  }

  const others = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))]
    .filter((e) => e !== meEmail)

  const rows: CalendarScheduleRow[] = [meRow]

  if (others.length && protocolOf(ctx) === 'eas') {
    try {
      const client = await createEasClient(ctx)
      const avail = await client.resolveAvailability(others, day0, day1)
      const byEmail = new Map(avail.map((a) => [a.email.toLowerCase(), a]))
      for (const email of others) {
        const hit = byEmail.get(email)
        rows.push({
          email,
          name: hit?.name || email.split('@')[0] || email,
          isSelf: false,
          slots: parseMerged(hit?.merged ?? '', slotCount)
        })
      }
    } catch {
      for (const email of others) {
        rows.push({
          email,
          name: email.split('@')[0] || email,
          isSelf: false,
          slots: Array.from({ length: slotCount }, () => 4 as FreeBusySlot)
        })
      }
    }
  } else {
    for (const email of others) {
      rows.push({
        email,
        name: email.split('@')[0] || email,
        isSelf: false,
        slots: Array.from({ length: slotCount }, () => 4 as FreeBusySlot)
      })
    }
  }

  // Пересечение черновика с моим календарём.
  const conflicts = myEvents.filter((e) => e.startsAt < endsAt && e.endsAt > startsAt)

  return {
    dayStart: day0,
    slotMinutes: 30,
    proposedStart: startsAt,
    proposedEnd: endsAt,
    rows,
    conflicts
  }
}
