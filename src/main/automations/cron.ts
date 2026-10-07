/**
 * Минимальный матчер 5-полевого cron + next-fire в заданной TZ.
 * Поддержка: *, N, N-M, star/N, списки через запятую. Без L/W/#.
 */

export type CronParts = {
  minute: number
  hour: number
  day: number
  month: number
  dow: number
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!stepMatch) throw new Error(`Некорректное поле cron: ${field}`)
    const [, range, stepRaw] = stepMatch
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isFinite(step) || step < 1) throw new Error(`Шаг cron «${part}»`)

    let start = min
    let end = max
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number)
        start = a
        end = b
      } else {
        start = end = Number(range)
      }
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Диапазон cron «${part}» вне ${min}–${max}`)
    }
    for (let i = start; i <= end; i += step) out.add(i)
  }
  return out
}

export type ParsedCron = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  dow: Set<number>
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error('Cron должен быть из 5 полей: мин час день месяц день_недели')
  }
  const [mi, h, d, mo, dw] = fields
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    day: parseField(d, 1, 31),
    month: parseField(mo, 1, 12),
    // cron: 0 и 7 = воскресенье
    dow: (() => {
      const s = parseField(dw, 0, 7)
      if (s.has(7)) s.add(0)
      return s
    })()
  }
}

/** Компоненты «сейчас» в IANA-таймзоне. dow: 0=вс … 6=сб (как Date.getDay). */
export function wallClock(date: Date, tz: string): CronParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  })
  const map = new Map(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const weekday = map.get('weekday') ?? 'Sun'
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  }
  return {
    minute: Number(map.get('minute')),
    hour: Number(map.get('hour')),
    day: Number(map.get('day')),
    month: Number(map.get('month')),
    dow: dowMap[weekday] ?? 0
  }
}

export function cronMatches(parsed: ParsedCron, parts: CronParts): boolean {
  if (!parsed.minute.has(parts.minute)) return false
  if (!parsed.hour.has(parts.hour)) return false
  if (!parsed.month.has(parts.month)) return false
  // День месяца и день недели: как в Vixie — если оба не *, достаточно одного.
  const dayStar = parsed.day.size === 31
  const dowStar = parsed.dow.size >= 7
  if (dayStar && dowStar) return true
  if (!dayStar && !dowStar) {
    return parsed.day.has(parts.day) || parsed.dow.has(parts.dow)
  }
  if (!dayStar) return parsed.day.has(parts.day)
  return parsed.dow.has(parts.dow)
}

export function matchesCron(expr: string, date: Date, tz: string): boolean {
  return cronMatches(parseCron(expr), wallClock(date, tz))
}

/** Следующий тик после `after` (не включая), грубый перебор по минутам. */
export function nextCronFire(expr: string, after: Date, tz: string, horizonMin = 60 * 24 * 40): number | null {
  const parsed = parseCron(expr)
  const cursor = new Date(after.getTime())
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  for (let i = 0; i < horizonMin; i++) {
    if (cronMatches(parsed, wallClock(cursor, tz))) return cursor.getTime()
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return null
}
