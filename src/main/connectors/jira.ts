/**
 * Jira (Server/Data Center): мои задачи + метаданные для аналитики (SP, resolution).
 */
import type { Item, ServiceConfig } from '@shared/types'
import { itemId, type Connector, type SyncContext, type SyncResult } from './types'
import { base, getJson, postJson } from './http'
import { patchConfig, getConfig } from '../config/store'
import { logInfo } from '../log'

interface JiraIssue {
  key: string
  fields: Record<string, unknown> & {
    summary?: string
    updated?: string
    resolutiondate?: string | null
    status?: {
      id?: string
      name: string
      statusCategory?: { key?: string; name?: string }
    }
    priority?: { name: string }
    assignee?: { name?: string; displayName?: string }
    issuetype?: { name?: string }
  }
}
interface JiraSearch {
  issues: JiraIssue[]
}
interface JiraField {
  id: string
  name: string
  custom?: boolean
  clauseNames?: string[]
  schema?: { type?: string; custom?: string; customId?: number }
}

interface JiraTransition {
  id: string
  name: string
  to: { name: string; statusCategory?: { key?: string } }
}
interface JiraTransitions {
  transitions: JiraTransition[]
}

/** Имена/схемы поля Story Points — у разных Jira/плагинов называются по-разному. */
function scoreSpField(f: JiraField): number {
  const name = f.name.trim()
  const custom = f.schema?.custom ?? ''
  const clauses = (f.clauseNames ?? []).join(' ')
  if (/^story\s*points?$/i.test(name)) return 100
  if (/story\s*point\s*estimate/i.test(name)) return 95
  if (/оценк\w*\s*(story|стори)/i.test(name) || /стори\s*поинт/i.test(name)) return 90
  if (/story\s*points?/i.test(name) || /storypoints/i.test(name)) return 80
  if (/story.?point/i.test(custom) || /jsw-story-points/i.test(custom)) return 85
  if (/story.?point/i.test(clauses)) return 70
  if (/^оценк/i.test(name) && (f.schema?.type === 'number' || /:float|:string$/i.test(custom))) {
    return 20
  }
  return 0
}

function rememberSpField(serviceId: string, fieldId: string): void {
  const cfg = getConfig()
  const cur = cfg.services.find((s) => s.id === serviceId)
  if (cur?.options.storyPointsField === fieldId) return
  patchConfig({
    services: cfg.services.map((s: ServiceConfig) =>
      s.id === serviceId ? { ...s, options: { ...s.options, storyPointsField: fieldId } } : s
    )
  })
}

async function resolveStoryPointsField(ctx: SyncContext): Promise<string | null> {
  const cached = ctx.service.options.storyPointsField?.trim()
  if (cached && cached !== '__none__') return cached
  try {
    const root = base(ctx.service.baseUrl)
    const fields = await getJson<JiraField[]>(ctx, `${root}/rest/api/2/field`)
    const ranked = fields
      .map((f) => ({ f, score: scoreSpField(f) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    const hit = ranked[0]?.f
    if (hit) {
      rememberSpField(ctx.service.id, hit.id)
      logInfo('mail', `Jira Story Points field: ${hit.id} (${hit.name}, score=${ranked[0]!.score})`)
      return hit.id
    }
    const sample = fields
      .filter((f) => f.custom)
      .slice(0, 12)
      .map((f) => f.name)
      .join(', ')
    logInfo('mail', `Jira Story Points: поле не найдено. Примеры custom: ${sample}`)
    return null
  } catch (e) {
    logInfo('mail', `Jira Story Points: не удалось получить /field — ${String(e)}`)
    return null
  }
}

function numField(fields: Record<string, unknown>, key: string | null): number | null {
  if (!key) return null
  const v = fields[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(+v.replace(',', '.'))) {
    return +v.replace(',', '.')
  }
  // Некоторые плагины кладут { value: 3 } / { value: "3" }.
  if (v && typeof v === 'object' && 'value' in (v as object)) {
    return numField({ value: (v as { value: unknown }).value } as Record<string, unknown>, 'value')
  }
  return null
}

/**
 * Jira: assignee = me, открытые + закрытые за 90 дней (для капасити-аналитики).
 * Если в options.projectKey задан ключ проекта — фильтруем по нему (колонки доски).
 */
export const jiraConnector: Connector = {
  kind: 'jira',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const root = base(ctx.service.baseUrl)
    const spField = await resolveStoryPointsField(ctx)
    const projectKey = ctx.service.options.projectKey?.trim()
    const fieldList = [
      'summary',
      'updated',
      'status',
      'priority',
      'assignee',
      'issuetype',
      'resolutiondate',
      spField
    ]
      .filter(Boolean)
      .join(',')

    const projectClause = projectKey ? `project = ${projectKey} AND ` : ''
    const jql = encodeURIComponent(
      `${projectClause}assignee = currentUser() AND (resolution = Unresolved OR (statusCategory = Done AND resolutiondate >= -90d)) ORDER BY updated DESC`
    )
    const data = await getJson<JiraSearch>(
      ctx,
      `${root}/rest/api/2/search?jql=${jql}&maxResults=100&fields=${fieldList}`
    )

    const items: Item[] = data.issues.map((is) => {
      const cat = is.fields.status?.statusCategory?.key ?? 'new'
      const statusId = is.fields.status?.id ?? ''
      const priority = is.fields.priority?.name ?? ''
      const type = is.fields.issuetype?.name ?? ''
      const sp = numField(is.fields, spField)
      const resolved = is.fields.resolutiondate
        ? Date.parse(is.fields.resolutiondate)
        : NaN
      const body = [
        `cat:${cat}`,
        statusId && `sid:${statusId}`,
        priority && `pri:${priority}`,
        type && `type:${type}`,
        sp != null && `sp:${sp}`,
        Number.isFinite(resolved) && `res:${resolved}`
      ]
        .filter(Boolean)
        .join('\n')

      return {
        id: itemId(ctx.service, is.key),
        envId: ctx.service.envId,
        serviceId: ctx.service.id,
        kind: 'task' as const,
        title: `${is.key}: ${is.fields.summary ?? ''}`,
        body,
        author: is.fields.assignee?.displayName ?? null,
        state: is.fields.status?.name ?? null,
        url: `${root}/browse/${is.key}`,
        updatedAt: Date.parse(String(is.fields.updated ?? '')) || Date.now(),
        unread: false,
        mentioned: false,
        startsAt: null,
        endsAt: null
      }
    })

    const withSp = items.filter((it) => it.body.includes('sp:')).length
    logInfo(
      'mail',
      `Jira ${ctx.service.id}: project=${projectKey || '—'}, SP field=${spField ?? '—'}, с оценкой ${withSp}/${items.length}`
    )

    return { items, cursor: String(Date.now()) }
  }
}

export type JiraBoardColumn = {
  id: string
  title: string
  /** Jira statusCategory.key → иконка колонки. */
  category: 'new' | 'indeterminate' | 'done'
  /** Id статусов, попадающих в эту колонку (доска может группировать несколько). */
  statusIds: string[]
  /** Имя статуса для transition (первый в колонке). */
  statusName: string
}

interface JiraStatusDto {
  id: string
  name: string
  statusCategory?: { key?: string; name?: string }
}

function categoryOf(key?: string): 'new' | 'indeterminate' | 'done' {
  if (key === 'done') return 'done'
  if (key === 'indeterminate') return 'indeterminate'
  return 'new'
}

/**
 * Колонки канбана: с Agile-доски проекта (если projectKey задан),
 * иначе статусы проекта, иначе три statusCategory.
 */
export async function fetchJiraBoardColumns(ctx: SyncContext): Promise<JiraBoardColumn[]> {
  const root = base(ctx.service.baseUrl)
  const projectKey = ctx.service.options.projectKey?.trim()
  const boardIdOpt = ctx.service.options.boardId?.trim()

  let statusById = new Map<string, JiraStatusDto>()
  try {
    const all = await getJson<JiraStatusDto[]>(ctx, `${root}/rest/api/2/status`)
    statusById = new Map(all.map((s) => [s.id, s]))
  } catch (e) {
    logInfo('mail', `Jira statuses: ${String(e)}`)
  }

  // 1) Agile board configuration
  if (projectKey) {
    try {
      let boardId = boardIdOpt
      if (!boardId) {
        const boards = await getJson<{ values: { id: number; name: string; type: string }[] }>(
          ctx,
          `${root}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`
        )
        const pick =
          boards.values.find((b) => b.type === 'kanban') ??
          boards.values.find((b) => b.type === 'scrum') ??
          boards.values[0]
        boardId = pick ? String(pick.id) : ''
      }
      if (boardId) {
        const cfg = await getJson<{
          columnConfig?: {
            columns?: { name: string; statuses?: { id: string }[] }[]
          }
        }>(ctx, `${root}/rest/agile/1.0/board/${boardId}/configuration`)
        const cols = cfg.columnConfig?.columns ?? []
        const mapped: JiraBoardColumn[] = []
        for (const col of cols) {
          const ids = (col.statuses ?? []).map((s) => s.id).filter(Boolean)
          if (!ids.length) continue
          const first = statusById.get(ids[0]!)
          const cat = categoryOf(first?.statusCategory?.key)
          // Для transition берём первый статус колонки; имя — из Jira или заголовок колонки.
          const statusName = first?.name ?? col.name
          mapped.push({
            id: `col:${boardId}:${col.name}`,
            title: col.name,
            category: cat,
            statusIds: ids,
            statusName
          })
        }
        if (mapped.length) {
          logInfo('mail', `Jira board ${boardId}: ${mapped.length} колонок`)
          return mapped
        }
      }
    } catch (e) {
      logInfo('mail', `Jira board columns: ${String(e)}`)
    }

    // 2) Статусы проекта (по типам задач — уникальные)
    try {
      const types = await getJson<
        { name: string; statuses: JiraStatusDto[] }[]
      >(ctx, `${root}/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`)
      const seen = new Set<string>()
      const mapped: JiraBoardColumn[] = []
      const order: Array<'new' | 'indeterminate' | 'done'> = ['new', 'indeterminate', 'done']
      const buckets: Record<string, JiraBoardColumn[]> = { new: [], indeterminate: [], done: [] }
      for (const t of types) {
        for (const st of t.statuses ?? []) {
          if (seen.has(st.id)) continue
          seen.add(st.id)
          const cat = categoryOf(st.statusCategory?.key)
          buckets[cat]!.push({
            id: `status:${st.id}`,
            title: st.name,
            category: cat,
            statusIds: [st.id],
            statusName: st.name
          })
        }
      }
      for (const cat of order) mapped.push(...(buckets[cat] ?? []))
      if (mapped.length) return mapped
    } catch (e) {
      logInfo('mail', `Jira project statuses: ${String(e)}`)
    }
  }

  // 3) Fallback — три категории
  return [
    { id: 'cat:new', title: 'К выполнению', category: 'new', statusIds: [], statusName: '' },
    { id: 'cat:indeterminate', title: 'В работе', category: 'indeterminate', statusIds: [], statusName: '' },
    { id: 'cat:done', title: 'Готово', category: 'done', statusIds: [], statusName: '' }
  ]
}

/** Перевести задачу: по имени статуса или по statusCategory.key (new/indeterminate/done). */
export async function jiraTransition(
  ctx: SyncContext,
  issueKey: string,
  target: { statusName?: string; category?: string }
): Promise<{ statusName: string; category: string }> {
  const root = base(ctx.service.baseUrl)
  const data = await getJson<JiraTransitions>(ctx, `${root}/rest/api/2/issue/${issueKey}/transitions`)
  const hit =
    (target.statusName
      ? data.transitions.find((t) => t.to.name.toLowerCase() === target.statusName!.toLowerCase())
      : undefined) ??
    (target.category
      ? data.transitions.find((t) => t.to.statusCategory?.key === target.category)
      : undefined)

  if (!hit) {
    const names = data.transitions.map((t) => t.to.name).join(', ')
    throw new Error(
      names
        ? `Нет подходящего перехода. Доступно: ${names}`
        : `Нет доступных переходов для ${issueKey}`
    )
  }
  await postJson(ctx, `${root}/rest/api/2/issue/${issueKey}/transitions`, {
    transition: { id: hit.id }
  })
  return {
    statusName: hit.to.name,
    category: hit.to.statusCategory?.key ?? target.category ?? 'new'
  }
}

export function parseTaskMeta(body: string): {
  category: 'new' | 'indeterminate' | 'done'
  priority: string
  type: string
  storyPoints: number | null
  resolvedAt: number | null
  statusId: string | null
} {
  let category: 'new' | 'indeterminate' | 'done' = 'new'
  let priority = ''
  let type = ''
  let storyPoints: number | null = null
  let resolvedAt: number | null = null
  let statusId: string | null = null
  for (const line of body.split('\n')) {
    if (line.startsWith('cat:')) {
      const k = line.slice(4)
      if (k === 'indeterminate' || k === 'done' || k === 'new') category = k
    } else if (line.startsWith('sid:')) statusId = line.slice(4)
    else if (line.startsWith('pri:')) priority = line.slice(4)
    else if (line.startsWith('type:')) type = line.slice(4)
    else if (line.startsWith('sp:')) {
      const n = +line.slice(3)
      if (Number.isFinite(n)) storyPoints = n
    } else if (line.startsWith('res:')) {
      const n = +line.slice(4)
      if (Number.isFinite(n)) resolvedAt = n
    }
  }
  return { category, priority, type, storyPoints, resolvedAt, statusId }
}
