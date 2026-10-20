import type {
  Automation,
  AutomationRunResult,
  AutomationUpsert,
  AutomationView
} from '@shared/automations'
import { nextCronFire } from './cron'
import {
  deleteAutomation,
  getAutomation,
  listAutomations,
  setAutomationEnabled,
  upsertAutomation
} from './store'
import { runAutomation, runCronMailPoll, tickAutomations } from './runner'
import { dispatchNewItems, latestEventContext, listEventTypes, tickCalendarSoon } from './events'
import { emitAutomationsChanged } from './notify'
import type { Item } from '@shared/types'

export { bindAutomationsChanged, emitAutomationsChanged } from './notify'
export { listStepTypes } from './steps'
export { listEventTypes, dispatchNewItems }

let timer: ReturnType<typeof setInterval> | null = null

async function tickAll(): Promise<void> {
  await tickAutomations()
  await tickCalendarSoon()
}

export function startAutomations(): void {
  if (timer) return
  void tickAll()
  // Раз в 30с — не пропустить минутный cron / calendar.soon при дрейфе таймера.
  timer = setInterval(() => void tickAll(), 30_000)
  timer.unref?.()
}

export function stopAutomations(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export function listAutomationsView(): AutomationView[] {
  const now = new Date()
  return listAutomations().map((a) => {
    let nextRunAt: number | null = null
    if (a.enabled && a.trigger.type === 'cron') {
      try {
        nextRunAt = nextCronFire(a.trigger.cron, now, a.trigger.tz || 'Europe/Moscow')
      } catch {
        nextRunAt = null
      }
    }
    return { ...a, nextRunAt }
  })
}

export function automationsUpsert(input: AutomationUpsert): AutomationView {
  const a = upsertAutomation(input)
  emitAutomationsChanged()
  return listAutomationsView().find((x) => x.id === a.id)!
}

export function automationsDelete(id: string): boolean {
  const ok = deleteAutomation(id)
  if (ok) emitAutomationsChanged()
  return ok
}

export function automationsSetEnabled(id: string, enabled: boolean): AutomationView {
  setAutomationEnabled(id, enabled)
  emitAutomationsChanged()
  return listAutomationsView().find((x) => x.id === id)!
}

export function automationsGet(id: string): AutomationView | null {
  return listAutomationsView().find((a) => a.id === id) ?? null
}

export async function automationsRunNow(id: string): Promise<AutomationRunResult> {
  const auto = getAutomation(id)
  if (!auto) throw new Error(`Автоматизация не найдена: ${id}`)
  // cron+filter — тот же poll непрочитанных, что и по расписанию.
  if (auto.trigger.type === 'cron' && auto.trigger.filter) {
    return runCronMailPoll(auto)
  }
  // Event: последний подходящий элемент, иначе в канал уйдёт сырой {{title}}.
  const seed = latestEventContext(auto)
  return runAutomation(id, seed ?? {})
}

export function resolveAutomationRef(ref: string): Automation {
  const list = listAutomations()
  const byId = list.find((a) => a.id === ref)
  if (byId) return byId
  const q = ref.trim().toLowerCase()
  const byName = list.filter((a) => a.name.toLowerCase() === q)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new Error(`Несколько автоматизаций с именем «${ref}»`)
  throw new Error(`Автоматизация не найдена: ${ref}`)
}

export function onNewAttentionItems(items: Item[]): void {
  void dispatchNewItems(items)
}

export { getAutomation, listAutomations }
