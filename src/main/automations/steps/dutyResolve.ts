/**
 * Разбор таблицы дежурств из markdown-заметки.
 * Колонки: имя | @login | id | дата начала мониторинга | дата начала релизов.
 * Неделя = [start, start+7 дней).
 */

export type DutyPair = {
  monitor: string
  releases: string
  range: string
  weekStart: string
  weekEnd: string
  monitorName: string
  releasesName: string
}

type Row = {
  name: string
  login: string
  monitorStart: Date
  releasesStart: Date
}

function parseRuDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (!m) return null
  const d = Number(m[1])
  const mo = Number(m[2]) - 1
  const y = Number(m[3])
  const dt = new Date(y, mo, d, 0, 0, 0, 0)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function fmtRu(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

function parseRows(markdown: string): Row[] {
  const rows: Row[] = []
  for (const line of markdown.split('\n')) {
    if (!line.includes('|')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
    if (cells.length < 5) continue
    if (/^-{2,}$/.test(cells[0]) || /дежурный/i.test(cells[0])) continue
    const login = cells[1]
    if (!login.startsWith('@')) continue
    const monitorStart = parseRuDate(cells[3])
    const releasesStart = parseRuDate(cells[4])
    if (!monitorStart || !releasesStart) continue
    rows.push({
      name: cells[0],
      login,
      monitorStart,
      releasesStart
    })
  }
  return rows
}

function inDutyWeek(start: Date, now: Date): boolean {
  const t = now.getTime()
  const from = start.getTime()
  const to = from + 7 * 86_400_000
  return t >= from && t < to
}

function weekBounds(now: Date): { start: Date; end: Date } {
  // Неделя пн–вс по локали процесса (Kontur на Mac пользователя).
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const dow = start.getDay() // 0=вс
  const back = dow === 0 ? 6 : dow - 1
  start.setDate(start.getDate() - back)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return { start, end }
}

export function resolveDutyFromMarkdown(markdown: string, now = new Date()): DutyPair {
  const rows = parseRows(markdown)
  if (rows.length === 0) {
    throw new Error('В заметке не найдена таблица дежурств (@login + даты)')
  }

  const monitor = rows.find((r) => inDutyWeek(r.monitorStart, now))
  const releases = rows.find((r) => inDutyWeek(r.releasesStart, now))
  if (!monitor) throw new Error('Нет дежурного по мониторингу на текущую неделю')
  if (!releases) throw new Error('Нет дежурного по релизам на текущую неделю')

  const { start, end } = weekBounds(now)
  return {
    monitor: monitor.login,
    releases: releases.login,
    monitorName: monitor.name,
    releasesName: releases.name,
    weekStart: fmtRu(start),
    weekEnd: fmtRu(end),
    range: `${fmtRu(start)}–${fmtRu(end)}`
  }
}
