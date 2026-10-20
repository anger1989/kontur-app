/**
 * Локальные сценарии Kontur: cron или событие + типизированные шаги.
 * Общая модель для main / preload / renderer / MCP.
 */

export type AutomationStatus = 'idle' | 'ok' | 'error' | 'running'

/** События, на которые может подписаться сценарий. */
export type AutomationEventType =
  | 'mail.received'
  | 'message.received'
  | 'review.new'
  | 'task.new'
  | 'calendar.soon'

export interface AutomationEventFilter {
  /** Контур: bank / ecom / shared */
  envId?: string
  /** Подстрока в author (без регистра) */
  authorContains?: string
  /** Подстрока в title */
  titleContains?: string
  /** Подстрока в body */
  bodyContains?: string
  /** Только mentioned (для message.received) */
  mentioned?: boolean
  /** Папка письма: inbox / sent / … */
  folder?: string
  /** За сколько минут до встречи (calendar.soon), по умолчанию 10 */
  minutesBefore?: number
}

export interface AutomationCronTrigger {
  type: 'cron'
  /** Классический 5-полевой cron: мин час день месяц день_недели */
  cron: string
  /** IANA, по умолчанию Europe/Moscow */
  tz?: string
  /**
   * Если задан — на тике опрашиваем непрочитанную почту по фильтру,
   * гоняем шаги на каждое письмо и (после успеха) помечаем прочитанным.
   */
  filter?: AutomationEventFilter
}

export interface AutomationEventTrigger {
  type: 'event'
  event: AutomationEventType
  filter?: AutomationEventFilter
}

export type AutomationTrigger = AutomationCronTrigger | AutomationEventTrigger

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
  trigger: AutomationTrigger
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
  trigger: AutomationTrigger
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

export interface AutomationEventTypeInfo {
  event: AutomationEventType
  title: string
  description: string
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

/** @deprecated старый формат store — только для миграции */
export interface LegacyAutomationSchedule {
  cron: string
  tz?: string
}

export const AUTOMATION_EVENT_TYPES: AutomationEventTypeInfo[] = [
  {
    event: 'mail.received',
    title: 'Новое письмо',
    description:
      'Свежее письмо во входящих (не sent/drafts). Контекст: title, author, body, url, item.*'
  },
  {
    event: 'message.received',
    title: 'Сообщение Mattermost',
    description: 'Новое сообщение/упоминание. Фильтр mentioned=true — только @you.'
  },
  {
    event: 'review.new',
    title: 'Новое ревью',
    description: 'MR/PR попал в attention (GitLab/Bitbucket).'
  },
  {
    event: 'task.new',
    title: 'Новая задача',
    description: 'Задача Jira (или аналог) появилась в attention.'
  },
  {
    event: 'calendar.soon',
    title: 'Скоро встреча',
    description: 'До начала встречи minutesBefore минут (по умолчанию 10).'
  }
]

export function isAutomationEventType(v: string): v is AutomationEventType {
  return AUTOMATION_EVENT_TYPES.some((e) => e.event === v)
}
