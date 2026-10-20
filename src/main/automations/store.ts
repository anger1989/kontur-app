import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type {
  Automation,
  AutomationEventFilter,
  AutomationTrigger,
  AutomationUpsert,
  LegacyAutomationSchedule
} from '@shared/automations'
import { isAutomationEventType } from '@shared/automations'
import { parseCron } from './cron'
import { listStepTypes } from './steps'
import { logWarn } from '../log'

type FileShape = { version: 1; items: unknown[] }

let cache: Automation[] | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'automations.json')
}

function cloneFilter(filter?: AutomationEventFilter): AutomationEventFilter | undefined {
  if (!filter) return undefined
  const out: AutomationEventFilter = {
    envId: filter.envId?.trim() || undefined,
    authorContains: filter.authorContains?.trim() || undefined,
    titleContains: filter.titleContains?.trim() || undefined,
    bodyContains: filter.bodyContains?.trim() || undefined,
    mentioned: filter.mentioned,
    folder: filter.folder?.trim() || undefined,
    minutesBefore:
      filter.minutesBefore != null && Number.isFinite(filter.minutesBefore)
        ? Math.max(1, Math.min(Math.round(filter.minutesBefore), 24 * 60))
        : undefined
  }
  if (
    !out.envId &&
    !out.authorContains &&
    !out.titleContains &&
    !out.bodyContains &&
    out.mentioned == null &&
    !out.folder &&
    out.minutesBefore == null
  ) {
    return undefined
  }
  return out
}

function normalizeTrigger(raw: Record<string, unknown>): AutomationTrigger {
  const trigger = raw.trigger as AutomationTrigger | undefined
  if (trigger?.type === 'cron' && typeof trigger.cron === 'string') {
    return {
      type: 'cron',
      cron: trigger.cron.trim(),
      tz: trigger.tz?.trim() || 'Europe/Moscow',
      filter: cloneFilter(trigger.filter)
    }
  }
  if (trigger?.type === 'event' && typeof trigger.event === 'string') {
    if (!isAutomationEventType(trigger.event)) {
      throw new Error(`Неизвестное событие: ${trigger.event}`)
    }
    return {
      type: 'event',
      event: trigger.event,
      filter: cloneFilter(trigger.filter)
    }
  }
  // Миграция v1: schedule.cron → trigger.cron
  const schedule = raw.schedule as LegacyAutomationSchedule | undefined
  if (schedule?.cron?.trim()) {
    return {
      type: 'cron',
      cron: schedule.cron.trim(),
      tz: schedule.tz?.trim() || 'Europe/Moscow'
    }
  }
  throw new Error('Нужен trigger (cron или event)')
}

function normalizeItem(raw: unknown): Automation | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  try {
    const trigger = normalizeTrigger(r)
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled !== false,
      trigger,
      steps: Array.isArray(r.steps)
        ? (r.steps as Automation['steps']).map((s) => ({
            type: String(s.type ?? '').trim(),
            params: s.params ? { ...s.params } : {}
          }))
        : [],
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
      lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      lastStatus:
        r.lastStatus === 'ok' ||
        r.lastStatus === 'error' ||
        r.lastStatus === 'running' ||
        r.lastStatus === 'idle'
          ? r.lastStatus
          : 'idle',
      lastError: typeof r.lastError === 'string' ? r.lastError : null,
      lastSummary: typeof r.lastSummary === 'string' ? r.lastSummary : null
    }
  } catch (e) {
    logWarn(
      'automations',
      `пропуск битой записи ${String(r.id)}: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

function load(): Automation[] {
  if (cache) return cache
  const file = filePath()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as FileShape
      if (raw?.version === 1 && Array.isArray(raw.items)) {
        cache = raw.items.map(normalizeItem).filter((x): x is Automation => x != null)
        return cache
      }
    }
  } catch (e) {
    logWarn('automations', `не прочитал store: ${e instanceof Error ? e.message : String(e)}`)
  }
  cache = []
  return cache
}

function persist(): void {
  const file = filePath()
  mkdirSync(dirname(file), { recursive: true })
  const body: FileShape = { version: 1, items: cache ?? [] }
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
}

function validateTrigger(trigger: AutomationTrigger): AutomationTrigger {
  if (trigger.type === 'cron') {
    if (!trigger.cron?.trim()) throw new Error('Нужен cron')
    parseCron(trigger.cron)
    return {
      type: 'cron',
      cron: trigger.cron.trim(),
      tz: trigger.tz?.trim() || 'Europe/Moscow',
      filter: cloneFilter(trigger.filter)
    }
  }
  if (trigger.type === 'event') {
    if (!isAutomationEventType(trigger.event)) {
      throw new Error(`Неизвестное событие: ${trigger.event}`)
    }
    return {
      type: 'event',
      event: trigger.event,
      filter: cloneFilter(trigger.filter)
    }
  }
  throw new Error('Нужен trigger.type = cron | event')
}

function validateUpsert(input: AutomationUpsert): void {
  if (!input.name?.trim()) throw new Error('Нужно имя автоматизации')
  validateTrigger(input.trigger)
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('Нужен хотя бы один шаг')
  }
  // Тип шага проверяем здесь, а не при запуске: сценарий с выдуманным шагом
  // иначе сохраняется молча и падает только ночью, на живом письме.
  const known = listStepTypes().map((t) => t.type)
  for (const s of input.steps) {
    if (!s?.type?.trim()) throw new Error('У шага должен быть type')
    const type = s.type.trim()
    if (!known.includes(type)) {
      throw new Error(`Неизвестный тип шага: ${type}. Доступны: ${known.join(', ')}`)
    }
  }
}

export function listAutomations(): Automation[] {
  // Готовых сценариев не заводим: автоматизация ходит в чужие каналы и заметки,
  // и предустановленный пример у кого-то сработает не туда.
  return load()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export function getAutomation(id: string): Automation | null {
  return load().find((a) => a.id === id) ?? null
}

export function upsertAutomation(input: AutomationUpsert): Automation {
  validateUpsert(input)
  const trigger = validateTrigger(input.trigger)
  const items = load()
  const now = Date.now()
  const existing = input.id ? items.find((a) => a.id === input.id) : null
  if (input.id && !existing) throw new Error(`Автоматизация не найдена: ${input.id}`)

  const next: Automation = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: input.name.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    trigger,
    steps: input.steps.map((s) => ({
      type: s.type.trim(),
      params: s.params ? { ...s.params } : {}
    })),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt ?? null,
    lastStatus: existing?.lastStatus ?? 'idle',
    lastError: existing?.lastError ?? null,
    lastSummary: existing?.lastSummary ?? null
  }

  if (existing) {
    const i = items.findIndex((a) => a.id === existing.id)
    items[i] = next
  } else {
    items.push(next)
  }
  persist()
  return next
}

export function deleteAutomation(id: string): boolean {
  const items = load()
  const next = items.filter((a) => a.id !== id)
  if (next.length === items.length) return false
  cache = next
  persist()
  return true
}

export function setAutomationEnabled(id: string, enabled: boolean): Automation {
  const a = getAutomation(id)
  if (!a) throw new Error(`Автоматизация не найдена: ${id}`)
  a.enabled = enabled
  a.updatedAt = Date.now()
  persist()
  return a
}

export function patchAutomationRuntime(
  id: string,
  patch: Partial<Pick<Automation, 'lastRunAt' | 'lastStatus' | 'lastError' | 'lastSummary'>>
): Automation {
  const a = getAutomation(id)
  if (!a) throw new Error(`Автоматизация не найдена: ${id}`)
  Object.assign(a, patch)
  persist()
  return a
}
