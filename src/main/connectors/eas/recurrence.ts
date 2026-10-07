/**
 * Разворот EAS Recurrence в конкретные вхождения (как AAS / dateutil.rrule).
 * Сервер отдаёт мастер + Exceptions, не серию дат.
 *
 * rrule — CJS: named ESM-import в Electron main падает → createRequire.
 */
import { createRequire } from 'node:module'
import type { Frequency, Options, Weekday } from 'rrule'
import type { Node } from './wbxml'
import { find, findAll, text } from './wbxml'
import { logWarn } from '../../log'

const { RRule, datetime } = createRequire(import.meta.url)('rrule') as typeof import('rrule')

export type Occ = { start: number; end: number }

const DOW: Weekday[] = [
  RRule.SU,
  RRule.MO,
  RRule.TU,
  RRule.WE,
  RRule.TH,
  RRule.FR,
  RRule.SA
]

/** EAS DayOfWeek bitmask → rrule weekdays. */
function weekdays(mask: number): Weekday[] {
  const out: Weekday[] = []
  for (let i = 0; i < 7; i++) {
    if (mask & (1 << i)) out.push(DOW[i])
  }
  return out
}

function parseCompactMs(v: string | null | undefined): number | null {
  if (!v) return null
  const s = v.trim()
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(s)
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m
    return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function toUtcParts(ms: number): Date {
  const d = new Date(ms)
  return datetime(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds()
  )
}

function compactKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function normalizeExceptionKey(raw: string | null): string | null {
  const ms = parseCompactMs(raw)
  return ms == null ? raw : compactKey(ms)
}

/**
 * Если у ApplicationData есть Recurrence — разворачиваем в окно [winStart, winEnd].
 * Без Recurrence возвращаем одну дату (или []).
 */
export function expandEventOccurrences(
  data: Node,
  masterStart: number,
  masterEnd: number | null,
  winStart: number,
  winEnd: number
): Occ[] {
  const rec = find(data, 'Recurrence')
  const duration = Math.max(60_000, (masterEnd ?? masterStart + 3_600_000) - masterStart)

  if (!rec) {
    if (masterEnd != null && masterEnd < winStart) return []
    if (masterStart > winEnd) return []
    return [{ start: masterStart, end: masterEnd ?? masterStart + duration }]
  }

  const rtype = text(rec, 'Type') ?? ''
  const interval = Math.max(1, +(text(rec, 'Interval') ?? '1') || 1)
  const count = text(rec, 'Occurrences')
  const untilRaw = text(rec, 'Until')
  const until = parseCompactMs(untilRaw)
  const mask = +(text(rec, 'DayOfWeek') ?? '0') || 0
  const dayOfMonth = text(rec, 'DayOfMonth')
  const weekOfMonth = text(rec, 'WeekOfMonth')
  const monthOfYear = text(rec, 'MonthOfYear')

  // EAS Type: 0 daily, 1 weekly, 2 monthly(day), 3 monthly(nth weekday), 5 yearly, 6 yearly(nth)
  let freq: Frequency | null = null
  if (rtype === '0') freq = RRule.DAILY
  else if (rtype === '1') freq = RRule.WEEKLY
  else if (rtype === '2' || rtype === '3') freq = RRule.MONTHLY
  else if (rtype === '5' || rtype === '6') freq = RRule.YEARLY
  else {
    logWarn('mail', `календарь: нераскрытый Recurrence Type=${rtype}`)
    if (masterStart >= winStart && masterStart <= winEnd) {
      return [{ start: masterStart, end: masterEnd ?? masterStart + duration }]
    }
    return []
  }

  const opts: Partial<Options> = {
    freq,
    interval,
    dtstart: toUtcParts(masterStart)
  }
  if (count) opts.count = Math.min(500, Math.max(1, +count || 1))
  if (until != null) opts.until = toUtcParts(until)
  else if (!count) opts.until = toUtcParts(winEnd)

  if (rtype === '1' && mask) opts.byweekday = weekdays(mask)
  if (rtype === '2' && dayOfMonth) opts.bymonthday = +dayOfMonth
  if ((rtype === '3' || rtype === '6') && mask) {
    opts.byweekday = weekdays(mask)
    const wom = +(weekOfMonth ?? '1') || 1
    opts.bysetpos = wom === 5 ? -1 : wom
  }
  if ((rtype === '5' || rtype === '6') && monthOfYear) opts.bymonth = +monthOfYear

  let rule: InstanceType<typeof RRule>
  try {
    rule = new RRule(opts as Options)
  } catch (err) {
    logWarn('mail', `rrule: ${err instanceof Error ? err.message : String(err)}`)
    return [{ start: masterStart, end: masterEnd ?? masterStart + duration }]
  }

  const deleted = new Set<string>()
  const overrides = new Map<string, { start: number; end: number | null }>()
  for (const ex of findAll(find(data, 'Exceptions'), 'Exception')) {
    const key = normalizeExceptionKey(text(ex, 'ExceptionStartTime'))
    if (!key) continue
    if (text(ex, 'Deleted') === '1') {
      deleted.add(key)
      continue
    }
    const s = parseCompactMs(text(ex, 'StartTime'))
    if (s == null) continue
    overrides.set(key, { start: s, end: parseCompactMs(text(ex, 'EndTime')) })
  }

  const out: Occ[] = []
  // between() — inclusive; даты в «floating» UTC как dtstart
  for (const dt of rule.between(toUtcParts(winStart - duration), toUtcParts(winEnd), true)) {
    const start = Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      dt.getUTCMinutes(),
      dt.getUTCSeconds()
    )
    const key = compactKey(start)
    if (deleted.has(key)) continue
    const ov = overrides.get(key)
    if (ov) {
      out.push({ start: ov.start, end: ov.end ?? ov.start + duration })
    } else {
      out.push({ start, end: start + duration })
    }
  }
  return out
}

/** Окно показа: −14 дней … +90 дней от сейчас. */
export function calendarWindow(now = Date.now()): { start: number; end: number } {
  const DAY = 86_400_000
  return { start: now - 14 * DAY, end: now + 90 * DAY }
}

/**
 * Отменённая встреча — только по приставке в теме, которую дописывает сервер.
 *
 * `MeetingStatus` 5/7 (MS-ASCAL — «отменена») намеренно не смотрим: Exchange
 * банка выставляет этот бит и живым встречам, и в Kontur они висели
 * зачёркнутыми, хотя в самом календаре стоят как обычные. Приставка в теме
 * у того же сервера совпадает с тем, что показывает штатный клиент.
 *
 * Двоеточие после слова обязательно: сервер дописывает именно «Отменено: »
 * («Canceled: »), а без него это просто первое слово темы — встреча
 * «Отменена поставка, обсуждаем сроки» живая, и зачёркивать её нельзя.
 * Граница `\b` тут не годится вовсе: она считает словом только ASCII.
 */
export function isCanceledMeeting(title: string): boolean {
  return /^(отменено|отменена|отменён|отменен|canceled|cancelled)\s*:/iu.test(title.trim())
}
