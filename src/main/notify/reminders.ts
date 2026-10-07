/**
 * Напоминания: встречи (15/5 мин) + локальные todos по полю remind:.
 */
import { Notification } from 'electron'
import type { Item, NavTarget } from '@shared/types'
import { getConfig } from '../config/store'
import { queryItems } from '../db'
import { logInfo } from '../log'
import { extractMeetingUrl } from './meetingLink'
import { isTodoDone, todoRemindAt } from '../todos'

const POLL_MS = 30_000
/** За сколько до начала напомнить о встрече (мс). */
const LEADS_MS = [15 * 60_000, 5 * 60_000] as const
/** Окно срабатывания: опрос каждые 30с, берём небольшой допуск. */
const WINDOW_MS = 45_000

const fired = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let onOpen: ((target: NavTarget) => void) | null = null
let onJoin: ((url: string) => void) | null = null

function isSkipped(e: Item): boolean {
  const st = (e.state ?? '').toLowerCase()
  if (st === 'отклонена' || st === 'отменена') return true
  if (e.body.split('\n').some((l) => l === 'allday:1')) return true
  if (e.startsAt != null && e.endsAt != null && e.endsAt - e.startsAt >= 20 * 3_600_000) return true
  return false
}

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function show(title: string, body: string, target: NavTarget, joinUrl?: string | null): void {
  if (!Notification.isSupported()) return
  if (!getConfig().notifications) return
  const n = new Notification({
    title,
    body,
    silent: false,
    actions: joinUrl ? [{ type: 'button', text: 'Подключиться' }] : undefined
  })
  n.on('click', () => onOpen?.(target))
  if (joinUrl) n.on('action', () => onJoin?.(joinUrl))
  n.show()
}

function tickMeetings(now: number): void {
  const events = queryItems({ kinds: ['event'], limit: 2000 })

  for (const e of events) {
    if (e.startsAt == null || isSkipped(e)) continue
    for (const lead of LEADS_MS) {
      const fireAt = e.startsAt - lead
      if (now < fireAt || now >= fireAt + WINDOW_MS) continue
      const key = `${e.id}:${lead}`
      if (fired.has(key)) continue
      fired.add(key)
      const mins = Math.round(lead / 60_000)
      const when = fmtWhen(e.startsAt)
      show(
        mins >= 15 ? 'Встреча через 15 минут' : 'Встреча через 5 минут',
        `${when} · ${e.title}`,
        { kind: 'page', page: 'calendar', itemId: e.id },
        extractMeetingUrl(e)
      )
      logInfo('notify', `напоминание ${mins}м: ${e.title}`)
    }
  }

  for (const key of [...fired]) {
    if (!key.includes(':')) continue
    const id = key.slice(0, key.lastIndexOf(':'))
    const ev = events.find((x) => x.id === id)
    if (!ev?.startsAt || ev.startsAt < now - 60 * 60_000) fired.delete(key)
  }
}

function tickTodos(now: number): void {
  const todos = queryItems({ kinds: ['todo'], limit: 2000, mode: 'full' })
  for (const t of todos) {
    if (isTodoDone(t)) continue
    const remindAt = todoRemindAt(t)
    if (remindAt == null) continue
    if (now < remindAt || now >= remindAt + WINDOW_MS) continue
    const key = `${t.id}:remind`
    if (fired.has(key)) continue
    fired.add(key)
    const due =
      t.startsAt != null
        ? `к ${fmtWhen(t.startsAt)} · ${new Date(t.startsAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
        : 'без срока'
    show('Напоминание', `${t.title}\n${due}`, { kind: 'page', page: 'planner', itemId: t.id })
    logInfo('notify', `todo remind: ${t.title}`)
  }

  for (const key of [...fired]) {
    if (!key.endsWith(':remind')) continue
    const id = key.slice(0, -':remind'.length)
    const t = todos.find((x) => x.id === id)
    if (!t || isTodoDone(t)) fired.delete(key)
    else {
      const r = todoRemindAt(t)
      if (r == null || r < now - 60 * 60_000) fired.delete(key)
    }
  }
}

function tick(): void {
  if (!getConfig().notifications) return
  const now = Date.now()
  tickMeetings(now)
  tickTodos(now)
}

/** Запросить у macOS право на баннеры (тихо, без тестового тоста). */
export function ensureNotificationPermission(): void {
  if (!Notification.isSupported()) {
    logInfo('notify', 'Notification API недоступен')
    return
  }
  logInfo('notify', 'уведомления включены в конфиге: ' + String(getConfig().notifications))
}

export function startMeetingReminders(
  open: (target: NavTarget) => void,
  join: (url: string) => void
): void {
  onOpen = open
  onJoin = join
  ensureNotificationPermission()
  tick()
  timer = setInterval(tick, POLL_MS)
}

export function stopMeetingReminders(): void {
  if (timer) clearInterval(timer)
  timer = null
  onOpen = null
  onJoin = null
}
