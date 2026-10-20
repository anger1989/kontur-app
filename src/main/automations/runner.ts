import type { Automation, AutomationRunResult } from '@shared/automations'
import { matchesCron, wallClock } from './cron'
import { runStep } from './steps'
import {
  getAutomation,
  listAutomations,
  patchAutomationRuntime
} from './store'
import { itemContext, matchesFilter } from './itemContext'
import { queryItems } from '../db'
import { markMailReadFully } from '../mail'
import { logError, logInfo } from '../log'
import { emitAutomationsChanged } from './notify'

const running = new Set<string>()
/** Минута последнего успешного матча cron → не гоняем дважды в ту же минуту. */
const firedKey = new Map<string, string>()

/** Сколько непрочитанных писем разбирать за один тик cron+filter. */
const MAX_MAIL_POLL = 25

function minuteKey(d: Date, tz: string): string {
  const p = wallClock(d, tz)
  return `${tz}:${p.month}-${p.day}-${p.hour}-${p.minute}`
}

export async function runAutomation(
  id: string,
  seed: Record<string, unknown> = {}
): Promise<AutomationRunResult> {
  const auto = getAutomation(id)
  if (!auto) throw new Error(`Автоматизация не найдена: ${id}`)
  if (running.has(id)) throw new Error('Уже выполняется')

  running.add(id)
  const startedAt = Date.now()
  patchAutomationRuntime(id, { lastStatus: 'running', lastError: null })
  emitAutomationsChanged()

  const ctx: Record<string, unknown> = {
    now: new Date(startedAt).toISOString(),
    automationId: auto.id,
    automationName: auto.name,
    ...seed
  }
  const summaries: string[] = []

  try {
    for (const step of auto.steps) {
      const result = await runStep(step.type, step.params, ctx)
      if (result.patch) Object.assign(ctx, result.patch)
      if (result.summary) summaries.push(result.summary)
    }
    const summary = summaries.join(' · ') || 'ok'
    const finishedAt = Date.now()
    patchAutomationRuntime(id, {
      lastRunAt: finishedAt,
      lastStatus: 'ok',
      lastError: null,
      lastSummary: summary
    })
    emitAutomationsChanged()
    logInfo('automations', `${auto.name}: ok — ${summary}`)
    return {
      id,
      ok: true,
      summary,
      error: null,
      startedAt,
      finishedAt,
      context: slimContext(ctx)
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const finishedAt = Date.now()
    patchAutomationRuntime(id, {
      lastRunAt: finishedAt,
      lastStatus: 'error',
      lastError: error,
      lastSummary: null
    })
    emitAutomationsChanged()
    logError('automations', `${auto.name}: ${error}`)
    return { id, ok: false, summary: null, error, startedAt, finishedAt }
  } finally {
    running.delete(id)
  }
}

function slimContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string' && v.length > 400) out[k] = `${v.slice(0, 400)}…`
    else out[k] = v
  }
  return out
}

/**
 * Cron + filter: опрос непрочитанной почты.
 * На каждое письмо — шаги; после успеха помечаем прочитанным (курсор = unread).
 */
export async function runCronMailPoll(auto: Automation): Promise<AutomationRunResult> {
  if (auto.trigger.type !== 'cron' || !auto.trigger.filter) {
    return runAutomation(auto.id)
  }
  const filter = auto.trigger.filter
  const items = queryItems({ kinds: ['mail'], unreadOnly: true, limit: 200 })
    .filter((i) => {
      const folder = i.folder ?? 'inbox'
      return folder !== 'sent' && folder !== 'drafts'
    })
    .filter((i) => matchesFilter(i, filter))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, MAX_MAIL_POLL)

  if (!items.length) {
    const finishedAt = Date.now()
    const summary = 'нет непрочитанных'
    patchAutomationRuntime(auto.id, {
      lastRunAt: finishedAt,
      lastStatus: 'ok',
      lastError: null,
      lastSummary: summary
    })
    emitAutomationsChanged()
    logInfo('automations', `${auto.name}: ${summary}`)
    return {
      id: auto.id,
      ok: true,
      summary,
      error: null,
      startedAt: finishedAt,
      finishedAt
    }
  }

  const startedAt = Date.now()
  const summaries: string[] = []
  let lastError: string | null = null
  let okCount = 0

  for (const item of items) {
    logInfo('automations', `cron poll → ${auto.name} (${item.title})`)
    const result = await runAutomation(auto.id, itemContext(item))
    if (result.ok) {
      okCount++
      if (result.summary) summaries.push(result.summary)
      await markMailReadFully(item.id).catch(() => {})
    } else {
      lastError = result.error
      break
    }
  }

  const finishedAt = Date.now()
  const summary =
    summaries.length > 0
      ? `${okCount}/${items.length}: ${summaries[summaries.length - 1]}`
      : lastError
        ? null
        : 'ok'

  if (lastError && okCount === 0) {
    return {
      id: auto.id,
      ok: false,
      summary: null,
      error: lastError,
      startedAt,
      finishedAt
    }
  }

  // Частичный успех тоже ok — прочитанные уже сняты с курсора.
  patchAutomationRuntime(auto.id, {
    lastRunAt: finishedAt,
    lastStatus: lastError ? 'error' : 'ok',
    lastError,
    lastSummary: summary ?? (lastError ? null : 'ok')
  })
  emitAutomationsChanged()

  return {
    id: auto.id,
    ok: !lastError,
    summary,
    error: lastError,
    startedAt,
    finishedAt
  }
}

/** Тик планировщика: найти cron-сценарии, у которых сейчас сработал cron. */
export async function tickAutomations(now = new Date()): Promise<void> {
  const list = listAutomations().filter((a) => a.enabled && a.trigger.type === 'cron')
  for (const a of list) {
    await maybeFireCron(a, now)
  }
}

async function maybeFireCron(a: Automation, now: Date): Promise<void> {
  if (a.trigger.type !== 'cron') return
  const tz = a.trigger.tz || 'Europe/Moscow'
  try {
    if (!matchesCron(a.trigger.cron, now, tz)) return
  } catch (e) {
    logError(
      'automations',
      `${a.name}: плохой cron — ${e instanceof Error ? e.message : String(e)}`
    )
    return
  }
  const key = minuteKey(now, tz)
  if (firedKey.get(a.id) === key) return
  if (running.has(a.id)) return
  firedKey.set(a.id, key)
  if (a.trigger.filter) {
    await runCronMailPoll(a)
  } else {
    await runAutomation(a.id)
  }
}
