import type { AutomationStepTypeInfo } from '@shared/automations'
import * as actions from '../../ai/actions'
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
