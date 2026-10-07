/**
 * Локальные сценарии Kontur: cron + типизированные шаги.
 * Общая модель для main / preload / renderer / MCP.
 */

export type AutomationStatus = 'idle' | 'ok' | 'error' | 'running'

export interface AutomationSchedule {
  /** Классический 5-полевой cron: мин час день месяц день_недели */
  cron: string
  /** IANA, по умолчанию Europe/Moscow */
  tz?: string
}

export interface AutomationStep {
  /** Тип из реестра шагов: notes.read, duty.resolve, … */
  type: string
  /** Параметры шага; строки могут содержать {{vars}} из контекста */
  params?: Record<string, unknown>
}

export interface Automation {
  id: string
  name: string
  enabled: boolean
  schedule: AutomationSchedule
  steps: AutomationStep[]
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastStatus: AutomationStatus
  lastError: string | null
  /** Краткий итог последнего прогона (для виджета) */
  lastSummary: string | null
}

/** Черновик создания / полной замены (без runtime-полей). */
export interface AutomationUpsert {
  id?: string
  name: string
  enabled?: boolean
  schedule: AutomationSchedule
  steps: AutomationStep[]
}

export interface AutomationStepTypeInfo {
  type: string
  title: string
  description: string
  /** JSON Schema-подобное описание params для агента */
  params: Record<
    string,
    {
      type: string
      description: string
      required?: boolean
      default?: unknown
    }
  >
}

export interface AutomationRunResult {
  id: string
  ok: boolean
  summary: string | null
  error: string | null
  startedAt: number
  finishedAt: number
  /** Контекст после шагов (без сырого markdown, если длинный) */
  context?: Record<string, unknown>
}

/** Automation + вычисленный следующий запуск (для UI/MCP). */
export type AutomationView = Automation & { nextRunAt: number | null }
