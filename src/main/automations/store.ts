import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { Automation, AutomationUpsert } from '@shared/automations'
import { parseCron } from './cron'
import { logWarn } from '../log'

type FileShape = { version: 1; items: Automation[] }

let cache: Automation[] | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'automations.json')
}

function load(): Automation[] {
  if (cache) return cache
  const file = filePath()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as FileShape
      if (raw?.version === 1 && Array.isArray(raw.items)) {
        cache = raw.items
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

function validateUpsert(input: AutomationUpsert): void {
  if (!input.name?.trim()) throw new Error('Нужно имя автоматизации')
  if (!input.schedule?.cron?.trim()) throw new Error('Нужен cron')
  parseCron(input.schedule.cron)
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('Нужен хотя бы один шаг')
  }
  for (const s of input.steps) {
    if (!s?.type?.trim()) throw new Error('У шага должен быть type')
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
  const items = load()
  const now = Date.now()
  const existing = input.id ? items.find((a) => a.id === input.id) : null
  if (input.id && !existing) throw new Error(`Автоматизация не найдена: ${input.id}`)

  const next: Automation = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: input.name.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    schedule: {
      cron: input.schedule.cron.trim(),
      tz: input.schedule.tz?.trim() || 'Europe/Moscow'
    },
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
