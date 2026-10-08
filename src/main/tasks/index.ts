import type { Item } from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { getItem, upsertItems } from '../db'
import type { SyncContext } from '../connectors/types'
import {
  fetchJiraBoardColumns,
  jiraTransition,
  parseTaskMeta,
  type JiraBoardColumn
} from '../connectors/jira'

function parseTaskId(id: string): { serviceId: string; issueKey: string } {
  const parts = id.split(':')
  if (parts.length < 3) throw new Error('Некорректный id задачи')
  const serviceId = parts[1]!
  const issueKey = parts.slice(2).join(':')
  if (!serviceId || !issueKey) throw new Error('Некорректный id задачи')
  return { serviceId, issueKey }
}

function contextFor(serviceId: string): SyncContext {
  const cfg = getConfig()
  const service = cfg.services.find((s) => s.id === serviceId)
  if (!service) throw new Error('Сервис Jira не найден')
  const env = cfg.envs.find((e) => e.id === service.envId)
  if (!env) throw new Error('Контур не найден')
  return {
    env,
    service,
    secret: getSecret(`${service.id}.secret`),
    cursor: null
  }
}

function rebuildBody(
  meta: ReturnType<typeof parseTaskMeta>,
  cat: string,
  statusId?: string | null
): string {
  return [
    `cat:${cat}`,
    (statusId ?? meta.statusId) && `sid:${statusId ?? meta.statusId}`,
    meta.priority && `pri:${meta.priority}`,
    meta.type && `type:${meta.type}`,
    meta.storyPoints != null && `sp:${meta.storyPoints}`,
    meta.resolvedAt != null && `res:${meta.resolvedAt}`
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Перевести задачу в колонку канбана (по statusCategory) или в конкретный статус.
 */
export async function transitionTask(
  itemId: string,
  target: { category?: string; statusName?: string; statusIds?: string[] }
): Promise<Item> {
  const existing = getItem(itemId)
  if (!existing || existing.kind !== 'task') throw new Error('Задача не найдена локально')

  const { serviceId, issueKey } = parseTaskId(itemId)
  const ctx = contextFor(serviceId)
  if (ctx.service.kind !== 'jira') throw new Error('Переходы пока только для Jira')

  const result = await jiraTransition(ctx, issueKey, target)
  const meta = parseTaskMeta(existing.body)
  const cat =
    result.category === 'done' || result.category === 'indeterminate' || result.category === 'new'
      ? result.category
      : 'new'

  const next: Item = {
    ...existing,
    state: result.statusName,
    body: rebuildBody(meta, cat),
    updatedAt: Date.now()
  }
  upsertItems([next])
  return next
}

export type TaskBoardColumn = JiraBoardColumn

export type TaskBoard = {
  serviceId: string | null
  projectKey: string | null
  columns: TaskBoardColumn[]
}

const FALLBACK_COLUMNS: TaskBoardColumn[] = [
  { id: 'cat:new', title: 'К выполнению', category: 'new', statusIds: [], statusName: '' },
  {
    id: 'cat:indeterminate',
    title: 'В работе',
    category: 'indeterminate',
    statusIds: [],
    statusName: ''
  },
  { id: 'cat:done', title: 'Готово', category: 'done', statusIds: [], statusName: '' }
]

/**
 * Колонки канбана: берём Jira с projectKey (или первую включённую),
 * статусы — с доски / проекта.
 */
export async function getTaskBoard(serviceId?: string): Promise<TaskBoard> {
  const cfg = getConfig()
  const jiras = cfg.services.filter((s) => s.kind === 'jira' && s.enabled)
  const preferred =
    (serviceId ? jiras.find((s) => s.id === serviceId) : undefined) ??
    jiras.find((s) => s.options.projectKey?.trim()) ??
    jiras[0]

  if (!preferred) {
    return { serviceId: null, projectKey: null, columns: FALLBACK_COLUMNS }
  }

  try {
    const cols = await fetchJiraBoardColumns(contextFor(preferred.id))
    return {
      serviceId: preferred.id,
      projectKey: preferred.options.projectKey?.trim() || null,
      columns: cols.length ? cols : FALLBACK_COLUMNS
    }
  } catch {
    return {
      serviceId: preferred.id,
      projectKey: preferred.options.projectKey?.trim() || null,
      columns: FALLBACK_COLUMNS
    }
  }
}
