import type { Item } from './types'

/** Начало локальных суток в ms. */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Статусы, после которых задача больше ничего не требует. Категория Jira тут
 * не помощник: «Cancelled» в разных воркфлоу лежит и в Done, и в In Progress,
 * поэтому смотрим ещё и на имя статуса. «Отклонено»/«Rejected» намеренно не
 * в списке — отклонённое обычно как раз возвращается к исполнителю.
 */
const CLOSED_STATUS = /^\s*(cancel|отмен|аннулир|won'?t\s*do)/i

/** Задача закрыта: категория Done или отменяющий статус. */
export function isTaskClosed(item: Item): boolean {
  const cat = item.body.split('\n').find((l) => l.startsWith('cat:'))?.slice(4)
  if (cat === 'done') return true
  return CLOSED_STATUS.test(item.state ?? '')
}

/**
 * Встреча снята с вашего дня: организатор её отменил или вы отказались.
 * В сетке календаря такие видны (зачёркнуты) — там важно понимать, что было;
 * а вот в «Сегодня» и в счётчиках им не место, это уже не ваше расписание.
 */
export function isEventOff(item: Item): boolean {
  return item.state === 'отменена' || item.state === 'отклонена'
}

/**
 * Это приглашение, а не встреча.
 *
 * Exchange кладёт в календарь ещё и само приглашение — отдельной записью с
 * темой «Приглашение на встречу: <тема>. <дата>» и своим временем, почти как
 * у встречи. Штатный клиент рисует её серой штриховкой, а для счётчиков это
 * чистый дубль: настоящая встреча лежит рядом тем же часом. Из-за них день
 * выглядел вдвое плотнее, чем есть.
 */
const INVITATION_SUBJECT = /^\s*(приглашение на встречу|приглашение|invitation|invite)\s*:/i

export function isMeetingInvitation(item: Item): boolean {
  return INVITATION_SUBJECT.test(item.title)
}

/** Встреча, которая действительно занимает день: не отменена и не приглашение. */
export function countsAsMeeting(item: Item): boolean {
  return !isEventOff(item) && !isMeetingInvitation(item)
}

/**
 * Ключ слота: одинаковое начало и конец — считаем одной встречей.
 *
 * Личные встречи приезжают из обоих контуров двумя записями: у каждого ящика
 * своя копия, и счётчик дня удваивался. Склеиваем по времени, а не по теме:
 * один и тот же «Забрать из садика» в двух ящиках назван по-разному («с
 * садика» / «из садика»), а вот время совпадает до минуты.
 */
export function meetingSlotKey(item: Item): string {
  return `${item.startsAt}:${item.endsAt ?? ''}`
}

/**
 * Один и тот же слот — одна встреча. Либо это копия из второго контура, либо
 * наложение двух встреч, и день в обоих случаях занят ровно один раз.
 */
export function dedupeMeetings(items: Item[]): Item[] {
  const seen = new Set<string>()
  return items.filter((it) => {
    const key = meetingSlotKey(it)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface AttentionCounts {
  mailUnread: number
  /** Лента «Мой день» + сегодняшние встречи — то, что в трее / сайдбаре. */
  todayActive: number
  calendarToday: number
  tasksOpen: number
  /** Открытые личные дела из планировщика. */
  todosOpen: number
  byService: Map<string, number>
}

/**
 * Что реально «требует внимания»: непрочитанная почта, открытые задачи,
 * упоминания/unread в MM/MR/wiki, встречи сегодня и на ближайшую неделю.
 * Не путать с `items.length` — там весь кэш.
 */
export function computeAttention(items: Item[], now = Date.now()): AttentionCounts {
  const day0 = startOfLocalDay(now)
  const day1 = day0 + 86_400_000
  const week1 = day0 + 8 * 86_400_000
  let mailUnread = 0
  let todayFeed = 0
  let calendarToday = 0
  let tasksOpen = 0
  let todosOpen = 0
  const byService = new Map<string, number>()
  /** Слоты уже учтённых встреч — копии из второго контура не считаем дважды. */
  const seenSlots = new Set<string>()

  const bumpService = (id: string): void => {
    byService.set(id, (byService.get(id) ?? 0) + 1)
  }

  for (const i of items) {
    if (i.kind === 'mail') {
      if (i.unread) {
        mailUnread += 1
        todayFeed += 1
      }
      continue
    }

    if (i.kind === 'todo') {
      const done = i.body.split('\n').includes('cat:done')
      if (!done) {
        todosOpen += 1
        todayFeed += 1
        if (i.startsAt != null && i.startsAt >= day0 && i.startsAt < day1) {
          calendarToday += 1
        }
      }
      continue
    }

    if (i.kind === 'task') {
      if (!isTaskClosed(i)) {
        tasksOpen += 1
        todayFeed += 1
        bumpService(i.serviceId)
      }
      continue
    }

    if (i.kind === 'event') {
      if (i.startsAt == null || !countsAsMeeting(i)) continue
      const slot = meetingSlotKey(i)
      if (seenSlots.has(slot)) continue
      seenSlots.add(slot)
      if (i.startsAt >= day0 && i.startsAt < day1) {
        calendarToday += 1
      } else if (i.startsAt >= day1 && i.startsAt < week1) {
        todayFeed += 1
      }
      continue
    }

    if (i.kind === 'message' || i.kind === 'review' || i.kind === 'page') {
      if (i.unread || i.mentioned) {
        bumpService(i.serviceId)
        todayFeed += 1
      }
    }
  }

  return {
    mailUnread,
    todayActive: todayFeed + calendarToday,
    calendarToday,
    tasksOpen,
    todosOpen,
    byService
  }
}
