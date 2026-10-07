import { request } from 'undici'
import type { Item, MailFolder, MailMailbox } from '@shared/types'
import { dispatcherFor } from '../net/transport'
import { base, stripHtml } from './http'
import { itemId, type SyncContext } from './types'

/**
 * Почта по JMAP (RFC 8620/8621). Авторизация — Basic (email:пароль приложения).
 */

interface JmapSession {
  apiUrl: string
  primaryAccounts: Record<string, string>
}

function creds(ctx: SyncContext): string {
  const user = ctx.service.auth.username || ctx.service.options.email || ''
  return `Basic ${Buffer.from(`${user}:${ctx.secret ?? ''}`).toString('base64')}`
}

async function jmapGet<T>(ctx: SyncContext, url: string): Promise<T> {
  const res = await request(url, {
    method: 'GET',
    dispatcher: dispatcherFor(ctx.env),
    headers: { accept: 'application/json', authorization: creds(ctx) },
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  })
  if (res.statusCode >= 400) {
    throw new Error(
      res.statusCode === 401
        ? 'Почта отклонила доступ (401). Нужен пароль приложения, а не пароль SSO.'
        : `JMAP ответил ${res.statusCode}`
    )
  }
  return (await res.body.json()) as T
}

async function jmapCall<T>(ctx: SyncContext, apiUrl: string, methodCalls: unknown[]): Promise<T> {
  const res = await request(apiUrl, {
    method: 'POST',
    dispatcher: dispatcherFor(ctx.env),
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: creds(ctx) },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls
    }),
    headersTimeout: 15_000,
    bodyTimeout: 15_000
  })
  if (res.statusCode >= 400) throw new Error(`JMAP ответил ${res.statusCode}`)
  return (await res.body.json()) as T
}

export async function jmapSession(ctx: SyncContext): Promise<{ session: JmapSession; accountId: string }> {
  const root = base(ctx.service.options.jmapUrl || ctx.service.baseUrl)
  const session = await jmapGet<JmapSession>(ctx, `${root}/.well-known/jmap`)
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']
  if (!accountId) throw new Error('JMAP: нет почтового аккаунта в сессии')
  return { session, accountId }
}

/** Роль → id почтового ящика (Mailbox/get), чтобы различать папки писем. */
async function mailboxRoles(
  ctx: SyncContext,
  apiUrl: string,
  accountId: string
): Promise<Map<string, MailFolder>> {
  const res = await jmapCall<{
    methodResponses: [string, { list?: { id: string; role?: string | null }[] }, string][]
  }>(ctx, apiUrl, [['Mailbox/get', { accountId, properties: ['id', 'role'] }, '0']])
  const byId = new Map<string, MailFolder>()
  for (const box of res.methodResponses[0]?.[1]?.list ?? []) {
    if (box.role === 'inbox') byId.set(box.id, 'inbox')
    else if (box.role === 'sent') byId.set(box.id, 'sent')
    else if (box.role === 'drafts') byId.set(box.id, 'drafts')
  }
  return byId
}

/** Последние письма через JMAP: Email/query → Email/get (все, не только непрочитанные). */
export async function syncJmap(ctx: SyncContext): Promise<Item[]> {
  const { session, accountId } = await jmapSession(ctx)
  const roleById = await mailboxRoles(ctx, session.apiUrl, accountId).catch(() => new Map<string, MailFolder>())

  const query = await jmapCall<{
    methodResponses: [string, { ids?: string[] }, string][]
  }>(ctx, session.apiUrl, [
    [
      'Email/query',
      {
        accountId,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 150
      },
      '0'
    ]
  ])
  const ids = query.methodResponses[0]?.[1]?.ids ?? []
  if (!ids.length) return []

  const got = await jmapCall<{
    methodResponses: [
      string,
      {
        list?: {
          id: string
          subject?: string
          receivedAt?: string
          preview?: string
          keywords?: Record<string, boolean>
          from?: { name?: string; email?: string }[]
          to?: { name?: string; email?: string }[]
          mailboxIds?: Record<string, boolean>
        }[]
      },
      string
    ][]
  }>(ctx, session.apiUrl, [
    [
      'Email/get',
      {
        accountId,
        ids,
        properties: ['id', 'subject', 'receivedAt', 'from', 'to', 'preview', 'keywords', 'mailboxIds']
      },
      '1'
    ]
  ])

  const list = got.methodResponses[0]?.[1]?.list ?? []
  return list.map((m) => {
    // Письмо может лежать в нескольких ящиках — берём первую узнанную роль,
    // иначе считаем входящим (как было до поддержки папок).
    const folder: MailFolder =
      Object.keys(m.mailboxIds ?? {})
        .map((id) => roleById.get(id))
        .find((r): r is MailFolder => r != null) ?? 'inbox'
    const who = folder === 'inbox' ? m.from?.[0] : m.to?.[0]
    const unread = folder === 'inbox' && !m.keywords?.['$seen']
    return {
      id: itemId(ctx.service, `mail:${folder}:${m.id}`),
      envId: ctx.service.envId,
      serviceId: ctx.service.id,
      kind: 'mail' as const,
      title: m.subject || '(без темы)',
      body: m.preview ?? '',
      author: who?.name || who?.email || null,
      state: folder !== 'inbox' ? null : unread ? 'непрочитано' : 'прочитано',
      url: base(ctx.service.baseUrl),
      updatedAt: m.receivedAt ? Date.parse(m.receivedAt) : Date.now(),
      unread,
      mentioned: false,
      startsAt: null,
      endsAt: null,
      folder
    }
  })
}

/** Список почтовых ящиков JMAP. */
export async function listJmapFolders(ctx: SyncContext): Promise<MailMailbox[]> {
  const { session, accountId } = await jmapSession(ctx)
  const res = await jmapCall<{
    methodResponses: [
      string,
      {
        list?: {
          id: string
          name?: string
          parentId?: string | null
          role?: string | null
          totalEmails?: number
          unreadEmails?: number
        }[]
      },
      string
    ][]
  }>(ctx, session.apiUrl, [
    [
      'Mailbox/get',
      {
        accountId,
        properties: ['id', 'name', 'parentId', 'role', 'totalEmails', 'unreadEmails']
      },
      '0'
    ]
  ])
  return (res.methodResponses[0]?.[1]?.list ?? []).map((b) => {
    const role: MailFolder | null =
      b.role === 'inbox' || b.role === 'sent' || b.role === 'drafts' ? b.role : null
    return {
      id: b.id,
      name: b.name || b.id,
      parentId: b.parentId ?? null,
      role,
      total: b.totalEmails,
      unread: b.unreadEmails
    }
  })
}

/** Создать JMAP-папку. */
export async function createJmapFolder(
  ctx: SyncContext,
  name: string,
  parentId?: string | null
): Promise<MailMailbox> {
  const { session, accountId } = await jmapSession(ctx)
  const create: Record<string, unknown> = { name }
  if (parentId) create.parentId = parentId
  const res = await jmapCall<{
    methodResponses: [string, { created?: Record<string, { id: string }> }, string][]
  }>(ctx, session.apiUrl, [['Mailbox/set', { accountId, create: { new: create } }, '0']])
  const created = res.methodResponses[0]?.[1]?.created?.new
  if (!created?.id) throw new Error('JMAP Mailbox/set: папка не создана')
  return { id: created.id, name, parentId: parentId ?? null, role: null }
}

/**
 * Переместить письма в папку: mailboxIds = { [folderId]: true }.
 * emailIds — сырые JMAP Email id.
 */
export async function moveJmapEmails(
  ctx: SyncContext,
  emailIds: string[],
  folderId: string
): Promise<void> {
  if (!emailIds.length) return
  const { session, accountId } = await jmapSession(ctx)
  let destId = folderId
  if (folderId === 'inbox' || folderId === 'sent' || folderId === 'drafts') {
    const boxes = await listJmapFolders(ctx)
    const hit = boxes.find((b) => b.role === folderId)
    if (!hit) throw new Error(`JMAP: папка «${folderId}» не найдена`)
    destId = hit.id
  }
  const update: Record<string, { mailboxIds: Record<string, boolean> }> = {}
  for (const id of emailIds) {
    update[id] = { mailboxIds: { [destId]: true } }
  }
  await jmapCall(ctx, session.apiUrl, [['Email/set', { accountId, update }, '0']])
}

export async function fetchJmapMessage(
  ctx: SyncContext,
  emailId: string
): Promise<{
  subject: string
  from: string
  to: string
  cc: string
  date: number
  text: string
  html: string | null
  unread: boolean
}> {
  const { session, accountId } = await jmapSession(ctx)
  const got = await jmapCall<{
    methodResponses: [
      string,
      {
        list?: {
          id: string
          subject?: string
          receivedAt?: string
          keywords?: Record<string, boolean>
          from?: { name?: string; email?: string }[]
          to?: { name?: string; email?: string }[]
          cc?: { name?: string; email?: string }[]
          bodyValues?: Record<string, { value?: string; type?: string }>
          textBody?: { partId?: string }[]
          htmlBody?: { partId?: string }[]
        }[]
      },
      string
    ][]
  }>(ctx, session.apiUrl, [
    [
      'Email/get',
      {
        accountId,
        ids: [emailId],
        properties: [
          'id',
          'subject',
          'receivedAt',
          'from',
          'to',
          'cc',
          'keywords',
          'bodyValues',
          'textBody',
          'htmlBody'
        ],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 200_000
      },
      '0'
    ]
  ])
  const m = got.methodResponses[0]?.[1]?.list?.[0]
  if (!m) throw new Error('Письмо не найдено')

  const fmt = (list?: { name?: string; email?: string }[]): string =>
    (list ?? [])
      .map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : a.email || a.name || ''))
      .filter(Boolean)
      .join(', ')

  const bodies = m.bodyValues ?? {}
  const textPart = m.textBody?.[0]?.partId
  const htmlPart = m.htmlBody?.[0]?.partId
  const text = (textPart && bodies[textPart]?.value) || ''
  const html = (htmlPart && bodies[htmlPart]?.value) || null
  const unread = !m.keywords?.['$seen']

  if (unread) {
    await jmapCall(ctx, session.apiUrl, [
      [
        'Email/set',
        { accountId, update: { [emailId]: { 'keywords/$seen': true } } },
        'seen'
      ]
    ]).catch(() => {})
  }

  return {
    subject: m.subject || '(без темы)',
    from: fmt(m.from),
    to: fmt(m.to),
    cc: fmt(m.cc),
    date: m.receivedAt ? Date.parse(m.receivedAt) : Date.now(),
    text: text || (html ? stripHtml(html) : ''),
    html,
    unread
  }
}
