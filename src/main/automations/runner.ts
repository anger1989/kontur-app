import type { Automation, AutomationRunResult } from '@shared/automations'
import { matchesCron, wallClock } from './cron'
import { runStep } from './steps'
import {
  getAutomation,
  listAutomations,
  patchAutomationRuntime
} from './store'
import { logError, logInfo } from '../log'
import { emitAutomationsChanged } from './notify'

const running = new Set<string>()
/** Минута последнего успешного матча cron → не гоняем дважды в ту же минуту. */
const firedKey = new Map<string, string>()

function minuteKey(d: Date, tz: string): string {
  const p = wallClock(d, tz)
  return `${tz}:${p.month}-${p.day}-${p.hour}-${p.minute}`
}

export async function runAutomation(id: string): Promise<AutomationRunResult> {
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
    automationName: auto.name
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

/** Тик планировщика: найти сценарии, у которых сейчас сработал cron. */
export async function tickAutomations(now = new Date()): Promise<void> {
  const list = listAutomations().filter((a) => a.enabled)
  for (const a of list) {
    await maybeFire(a, now)
  }
}

async function maybeFire(a: Automation, now: Date): Promise<void> {
  const tz = a.schedule.tz || 'Europe/Moscow'
  try {
    if (!matchesCron(a.schedule.cron, now, tz)) return
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
  await runAutomation(a.id)
}
