import { Notification } from 'electron'
import type { AutomationStepTypeInfo } from '@shared/automations'
import * as actions from '../../ai/actions'
import { getConfig } from '../../config/store'
import { resolveDutyFromMarkdown } from './dutyResolve'
import { renderParams } from '../template'

export type StepContext = Record<string, unknown>

export type StepResult = {
  /** Что смержить в контекст */
  patch?: Record<string, unknown>
  /** Короткий итог шага */
  summary?: string
}

type StepHandler = (params: Record<string, unknown>, ctx: StepContext) => Promise<StepResult>

const catalog: AutomationStepTypeInfo[] = [
  {
    type: 'notes.read',
    title: 'Прочитать заметку',
    description: 'Читает markdown из vault; кладёт content/path/title в контекст.',
    params: {
      path: { type: 'string', description: 'Путь или заголовок заметки', required: true },
      as: {
        type: 'string',
        description: 'Ключ в контексте для content (по умолчанию noteContent)',
        default: 'noteContent'
      }
    }
  },
  {
    type: 'duty.resolve',
    title: 'Дежурства из заметки',
    description:
      'Парсит таблицу дежурств; в контекст: monitor, releases, range, weekStart, weekEnd.',
    params: {
      from: {
        type: 'string',
        description: 'Ключ контекста с markdown (по умолчанию noteContent)',
        default: 'noteContent'
      }
    }
  },
  {
    type: 'mattermost.set_banner',
    title: 'Баннер канала Mattermost',
    description: 'Ставит Channel Banner. Текст и цвет поддерживают {{vars}}.',
    params: {
      channel: { type: 'string', description: 'Id, имя или URL канала', required: true },
      text: { type: 'string', description: 'Текст баннера (markdown)', required: true },
      color: { type: 'string', description: 'Hex фона, напр. #e8f5e9', required: true },
      enabled: { type: 'boolean', description: 'false — снять баннер', default: true },
      env: { type: 'string', description: 'Контур bank/ecom/shared (опционально)' }
    }
  },
  {
    type: 'mattermost.set_header',
    title: 'Шапка канала Mattermost',
    description: 'Обновляет header канала. Поддерживает {{vars}}.',
    params: {
      channel: { type: 'string', description: 'Id, имя или URL канала', required: true },
      header: { type: 'string', description: 'Текст шапки', required: true },
      env: { type: 'string', description: 'Контур (опционально)' }
    }
  },
  {
    type: 'mattermost.post',
    title: 'Пост в Mattermost',
    description:
      'Пишет сообщение в канал от твоего аккаунта. Текст поддерживает {{title}}, {{author}}, {{url}}, …',
    params: {
      channel: { type: 'string', description: 'Id, имя или URL канала', required: true },
      message: { type: 'string', description: 'Текст поста (markdown)', required: true },
      env: { type: 'string', description: 'Контур bank/ecom/shared (опционально)' }
    }
  },
  {
    type: 'mattermost.mark_alert_resolved',
    title: 'Пометить FIRING как RESOLVED',
    description:
      'Если {{title}} содержит [RESOLVED] — находит свежий FIRING-пост с тем же алертом, ставит ✅ и дописывает RESOLVED. Иначе no-op.',
    params: {
      channel: { type: 'string', description: 'Id, имя или URL канала', required: true },
      title: {
        type: 'string',
        description: 'Тема письма/алерта (обычно {{title}})',
        required: true
      },
      env: { type: 'string', description: 'Контур (опционально)' }
    }
  },
  {
    type: 'notify',
    title: 'Уведомление macOS',
    description: 'Системный баннер. Учитывает настройку notifications в Kontur.',
    params: {
      title: { type: 'string', description: 'Заголовок', required: true },
      body: { type: 'string', description: 'Текст', required: true }
    }
  },
  {
    type: 'todos.create',
    title: 'Создать дело',
    description: 'Локальный todo Kontur. title/note поддерживают {{vars}}.',
    params: {
      title: { type: 'string', description: 'Название', required: true },
      note: { type: 'string', description: 'Заметка (опционально)' },
      dueAt: { type: 'string', description: 'Срок ISO-8601 (опционально)' },
      remindAt: { type: 'string', description: 'Напоминание ISO-8601 (опционально)' },
      showInCalendar: { type: 'boolean', description: 'Показать в календаре', default: false }
    }
  },
  {
    type: 'mail.mark_read',
    title: 'Пометить письмо прочитанным',
    description:
      'Снимает unread с текущего письма ({{item.id}}) или с id из params. Для cron+filter делается и так после успеха.',
    params: {
      id: {
        type: 'string',
        description: 'Id письма (по умолчанию {{item.id}} из контекста)',
        required: false
      }
    }
  }
]

const handlers: Record<string, StepHandler> = {
  async 'notes.read'(params) {
    const path = String(params.path ?? '').trim()
    if (!path) throw new Error('notes.read: нужен path')
    const as = String(params.as ?? 'noteContent').trim() || 'noteContent'
    const doc = (await actions.notesRead(path)) as {
      path: string
      title: string
      content: string
    }
    return {
      patch: {
        [as]: doc.content,
        notePath: doc.path,
        noteTitle: doc.title
      },
      summary: `заметка ${doc.path}`
    }
  },

  async 'duty.resolve'(params, ctx) {
    const from = String(params.from ?? 'noteContent').trim() || 'noteContent'
    const md = ctx[from]
    if (typeof md !== 'string' || !md.trim()) {
      throw new Error(`duty.resolve: в контексте нет markdown («${from}»)`)
    }
    const duty = resolveDutyFromMarkdown(md)
    return {
      patch: { ...duty },
      summary: `${duty.range}: мониторинг ${duty.monitor} · релизы ${duty.releases}`
    }
  },

  async 'mattermost.set_banner'(params) {
    const channel = String(params.channel ?? '').trim()
    const text = String(params.text ?? '')
    const color = String(params.color ?? '').trim()
    const enabled = params.enabled !== false
    const env = params.env != null ? String(params.env) : undefined
    const result = await actions.mattermostSetBanner({ channel, text, color, enabled, envId: env })
    return {
      patch: { bannerResult: result },
      summary: enabled ? `баннер → ${channel}` : `баннер снят: ${channel}`
    }
  },

  async 'mattermost.set_header'(params) {
    const channel = String(params.channel ?? '').trim()
    const header = String(params.header ?? '')
    const env = params.env != null ? String(params.env) : undefined
    const result = await actions.mattermostSetHeader(channel, header, env)
    return {
      patch: { headerResult: result },
      summary: `шапка → ${channel}`
    }
  },

  async 'mattermost.post'(params) {
    const channel = String(params.channel ?? '').trim()
    const message = String(params.message ?? '')
    if (!channel) throw new Error('mattermost.post: нужен channel')
    if (!message.trim()) throw new Error('mattermost.post: нужен message')
    const env = params.env != null ? String(params.env) : undefined
    const result = await actions.mattermostPost(channel, message, env)
    return {
      patch: { postResult: result },
      summary: `пост → ${channel}`
    }
  },

  async 'mattermost.mark_alert_resolved'(params) {
    const channel = String(params.channel ?? '').trim()
    const title = String(params.title ?? '')
    if (!channel) throw new Error('mattermost.mark_alert_resolved: нужен channel')
    const env = params.env != null ? String(params.env) : undefined
    const result = (await actions.mattermostMarkAlertResolved(channel, title, env)) as {
      skipped?: boolean
      reason?: string
      postId?: string
    }
    if (result.skipped) {
      return { patch: { resolveResult: result }, summary: `resolve skip: ${result.reason ?? 'ok'}` }
    }
    return {
      patch: { resolveResult: result },
      summary: `resolve → ${result.postId ?? channel}`
    }
  },

  async 'notify'(params) {
    const title = String(params.title ?? '').trim()
    const body = String(params.body ?? '')
    if (!title) throw new Error('notify: нужен title')
    if (!Notification.isSupported()) {
      return { summary: 'notify: не поддерживается' }
    }
    if (!getConfig().notifications) {
      return { summary: 'notify: выключены в настройках' }
    }
    new Notification({ title, body, silent: false }).show()
    return { summary: `notify: ${title}` }
  },

  async 'todos.create'(params) {
    const title = String(params.title ?? '').trim()
    if (!title) throw new Error('todos.create: нужен title')
    const note = params.note != null ? String(params.note) : undefined
    const dueAt = params.dueAt != null ? String(params.dueAt) : undefined
    const remindAt = params.remindAt != null ? String(params.remindAt) : undefined
    const showInCalendar = params.showInCalendar === true
    const result = actions.todosCreate({ title, note, dueAt, remindAt, showInCalendar })
    return {
      patch: { todo: result },
      summary: `todo: ${title}`
    }
  },

  async 'mail.mark_read'(params, ctx) {
    const fromParams = params.id != null ? String(params.id).trim() : ''
    const fromItem =
      ctx.item && typeof ctx.item === 'object' && ctx.item !== null && 'id' in ctx.item
        ? String((ctx.item as { id?: unknown }).id ?? '').trim()
        : ''
    const id = fromParams || fromItem
    if (!id) throw new Error('mail.mark_read: нужен id письма (params.id или item.id)')
    await actions.mailMarkRead(id)
    return { summary: `прочитано ${id.slice(-12)}` }
  }
}

export function listStepTypes(): AutomationStepTypeInfo[] {
  return catalog.slice()
}

export async function runStep(
  type: string,
  rawParams: Record<string, unknown> | undefined,
  ctx: StepContext
): Promise<StepResult> {
  const handler = handlers[type]
  if (!handler) throw new Error(`Неизвестный тип шага: ${type}`)
  const params = renderParams(rawParams, ctx)
  return handler(params, ctx)
}
