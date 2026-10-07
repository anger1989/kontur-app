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
import { runAutomation, tickAutomations } from './runner'
import { emitAutomationsChanged } from './notify'

export { bindAutomationsChanged, emitAutomationsChanged } from './notify'
export { listStepTypes } from './steps'

let timer: ReturnType<typeof setInterval> | null = null

export function startAutomations(): void {
  if (timer) return
  void tickAutomations()
  // Раз в 30с — не пропустить минутный cron при дрейфе таймера.
  timer = setInterval(() => void tickAutomations(), 30_000)
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
    try {
      nextRunAt = a.enabled
        ? nextCronFire(a.schedule.cron, now, a.schedule.tz || 'Europe/Moscow')
        : null
    } catch {
      nextRunAt = null
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
  return runAutomation(id)
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

export { getAutomation, listAutomations }
