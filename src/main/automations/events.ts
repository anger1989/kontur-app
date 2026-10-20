/**
 * Event-триггеры автоматизаций: матчинг фильтров + дедуп по item id.
 */
import {
  AUTOMATION_EVENT_TYPES,
  type Automation,
  type AutomationEventType,
  type AutomationEventTypeInfo
} from '@shared/automations'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Item } from '@shared/types'
import { listAutomations } from './store'
import { runAutomation } from './runner'
import { itemContext, matchesFilter } from './itemContext'
import { logInfo, logWarn } from '../log'
import { queryItems } from '../db'

export { itemContext, matchesFilter }

/** itemId → set automation ids уже сработавших (чтобы не дублировать на ресинке). */
const fired = new Map<string, Set<string>>()

/*
 * Отметка «досюда уже разбирали».
 *
 * Сценарии по событию должны срабатывать и на то, что пришло, пока Kontur был
 * закрыт: письмо-алерт в 3 ночи нужно переслать в канал утром, а не потерять.
 * Но и вываливать в чат всю историю при первом запуске нельзя — поэтому
 * догоняем только свежее: новее отметки и не старше CATCHUP_MS, пачкой не
 * больше MAX_PER_DISPATCH. Сама отметка переживает перезапуск.
 */
const CATCHUP_MS = 12 * 60 * 60_000
const MAX_PER_DISPATCH = 25
/** Запас на расхождение часов и задержку доставки. */
const GRACE_MS = 10 * 60_000

interface DispatchState {
  lastItemAt: number
}

function statePath(): string {
  return join(app.getPath('userData'), 'automations-state.json')
}

function readState(): DispatchState | null {
  const p = statePath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<DispatchState>
    return typeof raw.lastItemAt === 'number' ? { lastItemAt: raw.lastItemAt } : null
  } catch {
    return null
  }
}

function writeState(lastItemAt: number): void {
  try {
    const p = statePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ lastItemAt }, null, 2), 'utf8')
  } catch (e) {
    logWarn('automations', `не удалось сохранить отметку разбора: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function eventForItem(item: Item): AutomationEventType | null {
  switch (item.kind) {
    case 'mail': {
      const folder = item.folder ?? 'inbox'
      if (folder === 'sent' || folder === 'drafts') return null
      return 'mail.received'
    }
    case 'message':
      return 'message.received'
    case 'review':
      return 'review.new'
    case 'task':
      return 'task.new'
    default:
      return null
  }
}

function alreadyFired(autoId: string, dedupeKey: string): boolean {
  const set = fired.get(dedupeKey)
  return set?.has(autoId) ?? false
}

function markFired(autoId: string, dedupeKey: string): void {
  let set = fired.get(dedupeKey)
  if (!set) {
    set = new Set()
    fired.set(dedupeKey, set)
  }
  set.add(autoId)
}

function pruneFired(): void {
  if (fired.size <= 2000) return
  const keys = [...fired.keys()]
  for (let i = 0; i < keys.length / 2; i++) fired.delete(keys[i]!)
}

function eventAutos(event: AutomationEventType): Automation[] {
  return listAutomations().filter(
    (a) => a.enabled && a.trigger.type === 'event' && a.trigger.event === event
  )
}

/**
 * Отметки ещё нет — первый запуск после обновления или чистая установка.
 *
 * На чистой установке «новое» — это вся выгруженная почта, и слать её в чат
 * нельзя: молча ставим точку отсчёта. Если же база уже жила до этого синка,
 * точка отсчёта известна точно — последний элемент, который в ней был, и
 * текущая пачка разбирается как обычно.
 */
function initialState(batch: Item[]): DispatchState | null {
  const batchIds = new Set(batch.map((i) => i.id))
  const known = queryItems({ limit: 5000 }).filter((i) => !batchIds.has(i.id))
  if (!known.length) {
    writeState(Date.now())
    logInfo('automations', 'первый синк — ставим точку отсчёта, прошлое не догоняем')
    return null
  }
  const base = latestEventTime(known, 0)
  writeState(base)
  logInfo('automations', `точка отсчёта по базе: ${new Date(base).toISOString()}`)
  return { lastItemAt: base }
}

/**
 * Самый свежий элемент, который вообще умеет запускать событие.
 *
 * Встречи сюда не попадают: у них `updatedAt` — время начала, и одна встреча
 * на январь увела бы отметку на три месяца вперёд, после чего сегодняшняя
 * почта считалась бы «старой» и ни один сценарий больше не сработал. По той
 * же причине будущее подрезаем по «сейчас».
 */
function latestEventTime(items: Item[], from: number): number {
  const now = Date.now()
  let max = from
  for (const i of items) {
    if (eventForItem(i) == null) continue
    const at = Math.min(i.updatedAt ?? 0, now)
    if (at > max) max = at
  }
  return max
}

/**
 * Новые элементы из sync → запуск подходящих event-сценариев.
 *
 * Сюда приходит всё, чего ещё не было в базе, в том числе на первом синке
 * после запуска: что накопилось за время простоя, сценарий должен разобрать,
 * иначе «перешли алерт в канал» работает только при включённом приложении.
 */
export async function dispatchNewItems(items: Item[]): Promise<void> {
  if (!items.length) return

  const state = readState() ?? initialState(items)
  if (!state) return

  // Отметка из файла может быть из будущего (осталась от прошлых версий) —
  // подрезаем, иначе окно догона схлопывается и события не срабатывают.
  const now = Date.now()
  const mark = Math.min(state.lastItemAt, now)
  const cutoff = Math.max(mark - GRACE_MS, now - CATCHUP_MS)
  const recent = items
    .filter((i) => eventForItem(i) != null && (i.updatedAt ?? 0) > cutoff)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const batch = recent.slice(-MAX_PER_DISPATCH)
  if (batch.length < recent.length) {
    logWarn('automations', `пачка большая (${recent.length}) — разбираем последние ${batch.length}`)
  }

  const maxAt = latestEventTime(items, mark)
  if (maxAt !== state.lastItemAt) writeState(maxAt)

  if (!batch.length) return
  pruneFired()
  for (const item of batch) {
    const event = eventForItem(item)
    if (!event) continue
    const autos = eventAutos(event)
    for (const a of autos) {
      const filter = a.trigger.type === 'event' ? a.trigger.filter : undefined
      if (!matchesFilter(item, filter)) continue
      if (alreadyFired(a.id, item.id)) continue
      markFired(a.id, item.id)
      logInfo('automations', `event ${event} → ${a.name} (${item.title})`)
      void runAutomation(a.id, itemContext(item)).catch(() => {
        /* ошибка уже в runtime-полях */
      })
    }
  }
}

function isSkippedMeeting(e: Item): boolean {
  const st = (e.state ?? '').toLowerCase()
  if (st === 'отклонена' || st === 'отменена') return true
  if (e.body.split('\n').some((l) => l === 'allday:1')) return true
  if (e.startsAt != null && e.endsAt != null && e.endsAt - e.startsAt >= 20 * 3_600_000) return true
  return false
}

/**
 * Тик calendar.soon: для каждой event-автоматизации смотрим встречи
 * в окне [startsAt - minutesBefore, +45с].
 */
export async function tickCalendarSoon(now = Date.now()): Promise<void> {
  const autos = eventAutos('calendar.soon')
  if (!autos.length) return

  const events = queryItems({ kinds: ['event'], limit: 2000 })
  const WINDOW_MS = 45_000

  for (const a of autos) {
    const filter = a.trigger.type === 'event' ? a.trigger.filter : undefined
    const minutes = Math.max(1, Math.min(filter?.minutesBefore ?? 10, 24 * 60))
    const lead = minutes * 60_000

    for (const e of events) {
      if (e.startsAt == null || isSkippedMeeting(e)) continue
      if (!matchesFilter(e, filter)) continue
      const fireAt = e.startsAt - lead
      if (now < fireAt || now >= fireAt + WINDOW_MS) continue
      const key = `cal:${e.id}:${minutes}`
      if (alreadyFired(a.id, key)) continue
      markFired(a.id, key)
      logInfo('automations', `calendar.soon ${minutes}м → ${a.name} (${e.title})`)
      void runAutomation(a.id, {
        ...itemContext(e),
        minutesBefore: minutes
      }).catch(() => {})
    }
  }
}

/** Какие элементы базы соответствуют событию — для ручного прогона. */
const KINDS_BY_EVENT: Record<AutomationEventType, Item['kind'][]> = {
  'mail.received': ['mail'],
  'message.received': ['message'],
  'review.new': ['review'],
  'task.new': ['task'],
  'calendar.soon': ['event']
}

/**
 * Контекст для кнопки «Запустить сейчас» у event-сценария: берём последний
 * подходящий элемент из базы. Иначе тестовый прогон отправляет в канал сырой
 * шаблон с {{title}} — именно так это и выглядело у пользователя.
 */
export function latestEventContext(auto: Automation): Record<string, unknown> | null {
  const trigger = auto.trigger
  if (trigger.type !== 'event') return null
  const kinds = KINDS_BY_EVENT[trigger.event]
  if (!kinds) return null
  const item = queryItems({ kinds, limit: 500 })
    .filter((i) =>
      trigger.event === 'calendar.soon' ? i.kind === 'event' : eventForItem(i) === trigger.event
    )
    .filter((i) => matchesFilter(i, trigger.filter))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return item ? itemContext(item) : null
}

export function listEventTypes(): AutomationEventTypeInfo[] {
  return AUTOMATION_EVENT_TYPES.slice()
}
