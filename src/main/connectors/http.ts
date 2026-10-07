import { request } from 'undici'
import { dispatcherFor } from '../net/transport'
import type { SyncContext } from './types'

/** Заголовок авторизации по способу, выбранному для сервиса. */
export function authHeader(ctx: SyncContext): Record<string, string> {
  const { auth } = ctx.service
  const secret = ctx.secret ?? ''
  switch (auth.kind) {
    case 'pat':
    case 'bearer':
      return { authorization: `Bearer ${secret}` }
    case 'basic': {
      const user = auth.username ?? ''
      return { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` }
    }
    default:
      return {}
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** GET с авторизацией контура и JSON-ответом. Вся сеть — через dispatcher контура. */
export async function getJson<T>(ctx: SyncContext, url: string): Promise<T> {
  const res = await request(url, {
    method: 'GET',
    dispatcher: dispatcherFor(ctx.env),
    headers: { accept: 'application/json', ...authHeader(ctx) },
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  })
  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => '')
    throw new HttpError(
      res.statusCode === 401 || res.statusCode === 403
        ? 'Доступ отклонён — проверьте токен и его права.'
        : `Сервер ответил ${res.statusCode}: ${text.slice(0, 160)}`,
      res.statusCode
    )
  }
  return (await res.body.json()) as T
}

/**
 * GET с авторизацией контура и текстовым ответом.
 *
 * Нужен там, где API отдаёт не JSON: сырой diff пул-реквеста Bitbucket агент
 * читает куда легче, чем его же дерево хунков в JSON.
 */
export async function getText(ctx: SyncContext, url: string, accept = 'text/plain'): Promise<string> {
  const res = await request(url, {
    method: 'GET',
    dispatcher: dispatcherFor(ctx.env),
    headers: { accept, ...authHeader(ctx) },
    headersTimeout: 20_000,
    bodyTimeout: 20_000
  })
  const text = await res.body.text()
  if (res.statusCode >= 400) {
    throw new HttpError(
      res.statusCode === 401 || res.statusCode === 403
        ? 'Доступ отклонён — проверьте токен и его права.'
        : `Сервер ответил ${res.statusCode}: ${text.slice(0, 160)}`,
      res.statusCode
    )
  }
  return text
}

/** POST JSON с авторизацией контура. Для действий ассистента (создать задачу и т.п.). */
export async function postJson<T>(
  ctx: SyncContext,
  url: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST'
): Promise<T> {
  const res = await request(url, {
    method: method as 'POST',
    dispatcher: dispatcherFor(ctx.env),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...authHeader(ctx) },
    body: JSON.stringify(body),
    headersTimeout: 20_000,
    bodyTimeout: 20_000
  })
  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => '')
    throw new HttpError(
      res.statusCode === 401 || res.statusCode === 403
        ? 'Доступ отклонён — проверьте токен и его права.'
        : `Сервер ответил ${res.statusCode}: ${text.slice(0, 200)}`,
      res.statusCode
    )
  }
  const text = await res.body.text()
  return (text ? JSON.parse(text) : {}) as T
}

/** Короткий текст из HTML/вики-разметки для тела элемента. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const base = (url: string): string => url.replace(/\/+$/, '')
