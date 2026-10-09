import { ImapFlow } from 'imapflow'
import type { Item, MailFolder, MailMailbox } from '@shared/types'
import type { SyncContext } from './types'
import { itemId } from './types'

function imapClient(ctx: SyncContext): ImapFlow {
  const host = ctx.service.options.imapHost?.trim()
  if (!host) throw new Error('Не задан IMAP-сервер')
  const port = Number(ctx.service.options.imapPort) || 993
  const user = ctx.service.auth.username || ctx.service.options.email || ''
  if (!ctx.secret) throw new Error('Не задан пароль приложения')
  return new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: ctx.secret },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: ctx.env.allowInsecureTls ? { rejectUnauthorized: false } : undefined
  })
}

function specialUseRole(flag?: string | null): MailFolder | null {
  if (flag === '\\Inbox' || flag === 'INBOX') return 'inbox'
  if (flag === '\\Sent') return 'sent'
  if (flag === '\\Drafts') return 'drafts'
  if (flag === '\\Trash' || flag === '\\Deleted') return 'trash'
  return null
}

/** Список почтовых ящиков IMAP. */
export async function listImapFolders(ctx: SyncContext): Promise<MailMailbox[]> {
  const client = imapClient(ctx)
  await client.connect()
  try {
    const boxes = await client.list()
    return boxes.map((b) => {
      const role =
        b.path.toUpperCase() === 'INBOX' ? 'inbox' : specialUseRole(b.specialUse)
      return {
        id: b.path,
        name: b.name || b.path,
        parentId: b.path.includes(b.delimiter)
          ? b.path.slice(0, b.path.lastIndexOf(b.delimiter)) || null
          : null,
        role
      }
    })
  } finally {
    await client.logout().catch(() => {})
  }
}

/** Создать IMAP-папку. parentId — путь родителя (опционально). */
export async function createImapFolder(
  ctx: SyncContext,
  name: string,
  parentId?: string | null
): Promise<MailMailbox> {
  const client = imapClient(ctx)
  await client.connect()
  try {
    const boxes = await client.list()
    const delim = boxes[0]?.delimiter || '/'
    const path = parentId ? `${parentId}${delim}${name}` : name
    await client.mailboxCreate(path)
    return { id: path, name, parentId: parentId ?? null, role: null }
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Переместить письма. itemRefs — { mailboxPath, uid }.
 * mailboxPath / destination — путь или role alias (inbox/sent/drafts).
 */
export async function moveImapMessages(
  ctx: SyncContext,
  itemRefs: { mailboxPath: string; uid: number }[],
  destination: string
): Promise<void> {
  if (!itemRefs.length) return
  const client = imapClient(ctx)
  await client.connect()
  try {
    const boxes = await client.list()
    const resolve = (id: string): string => {
      if (id === 'inbox' || id.toUpperCase() === 'INBOX') return 'INBOX'
      if (id === 'sent') return boxes.find((b) => b.specialUse === '\\Sent')?.path ?? id
      if (id === 'drafts') return boxes.find((b) => b.specialUse === '\\Drafts')?.path ?? id
      if (id === 'trash' || id === 'deleted')
        return (
          boxes.find((b) => b.specialUse === '\\Trash' || b.specialUse === '\\Deleted')?.path ?? id
        )
      return id
    }
    const dest = resolve(destination)
    const byMailbox = new Map<string, number[]>()
    for (const r of itemRefs) {
      const path = resolve(r.mailboxPath)
      const list = byMailbox.get(path) ?? []
      list.push(r.uid)
      byMailbox.set(path, list)
    }
    for (const [path, uids] of byMailbox) {
      const lock = await client.getMailboxLock(path)
      try {
        await client.messageMove(uids.join(','), dest, { uid: true })
      } finally {
        lock.release()
      }
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Почта по IMAP — для серверов с паролем приложения (в т.ч. когда веб-вход
 * закрыт SSO). Берём последние письма из «Входящих» (и прочитанные, и нет).
 *
 * TLS-инспекция контура учитывается: при allowInsecureTls проверка сертификата
 * отключается, как и для остальных запросов этого контура.
 */
export async function syncImap(ctx: SyncContext): Promise<Item[]> {
  const host = ctx.service.options.imapHost?.trim()
  if (!host) throw new Error('Не задан IMAP-сервер')
  const port = Number(ctx.service.options.imapPort) || 993
  const user = ctx.service.auth.username || ctx.service.options.email || ''
  if (!ctx.secret) throw new Error('Не задан пароль приложения')

  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: ctx.secret },
    logger: false,
    // Без таймаутов imapflow ждёт ответа бесконечно, если порт отфильтрован
    // (туннель опущен) — проверка соединения из-за этого и зависала.
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: ctx.env.allowInsecureTls ? { rejectUnauthorized: false } : undefined
  })

  try {
    await client.connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      /auth|login|credential/i.test(msg)
        ? 'IMAP отклонил вход. Проверьте пароль приложения и логин.'
        : `Не удалось подключиться к IMAP: ${msg.slice(0, 160)}`
    )
  }

  /** Одна папка: последние N писем, свежие сверху. */
  const fetchFolder = async (mailboxPath: string, folder: MailFolder): Promise<Item[]> => {
    const out: Item[] = []
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      const exists = typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : 0
      if (!exists) return out
      const cap = folder === 'inbox' ? 99 : 49
      const from = Math.max(1, exists - cap)
      for await (const msg of client.fetch(`${from}:*`, {
        uid: true,
        envelope: true,
        flags: true
      })) {
        // В отправленных/черновиках важнее адресат, а не «от себя же».
        const who = folder === 'inbox' ? msg.envelope?.from?.[0] : msg.envelope?.to?.[0]
        const when = msg.envelope?.date ?? new Date()
        const unread = folder === 'inbox' && !(msg.flags?.has('\\Seen') ?? false)
        out.push({
          id: itemId(ctx.service, `mail:${folder}:${msg.uid}`),
          envId: ctx.service.envId,
          serviceId: ctx.service.id,
          kind: 'mail',
          title: msg.envelope?.subject || '(без темы)',
          body: '',
          author: who ? who.name || who.address || null : null,
          state: folder !== 'inbox' ? null : unread ? 'непрочитано' : 'прочитано',
          url: ctx.service.baseUrl || `imap://${host}`,
          updatedAt: when instanceof Date ? when.getTime() : Date.parse(String(when)) || Date.now(),
          unread,
          mentioned: false,
          startsAt: null,
          endsAt: null,
          folder
        })
      }
    } finally {
      lock.release()
    }
    return out
  }

  const items: Item[] = []
  try {
    items.push(...(await fetchFolder('INBOX', 'inbox')))

    // Папки «Отправленные»/«Черновики» ищем по стандартному флагу RFC 6154
    // (\Sent, \Drafts), а не по имени — оно у каждого провайдера своё.
    try {
      const boxes = await client.list()
      const byUse = (flag: string): string | undefined =>
        boxes.find((b) => b.specialUse === flag)?.path
      const sentPath = byUse('\\Sent')
      const draftsPath = byUse('\\Drafts')
      if (sentPath) items.push(...(await fetchFolder(sentPath, 'sent')))
      if (draftsPath) items.push(...(await fetchFolder(draftsPath, 'drafts')))
    } catch {
      // Сервер не поддерживает SPECIAL-USE или LIST упал — остаёмся на входящих.
    }
  } finally {
    await client.logout().catch(() => {})
  }

  return items
}

/** Полное тело письма по UID. `folder` — где искать, если не «Входящие». */
export async function fetchImapMessage(
  ctx: SyncContext,
  uid: number,
  folder: string = 'inbox'
): Promise<{ subject: string; from: string; to: string; cc: string; date: number; text: string; html: string | null; unread: boolean }> {
  const host = ctx.service.options.imapHost?.trim()
  if (!host) throw new Error('Не задан IMAP-сервер')
  const port = Number(ctx.service.options.imapPort) || 993
  const user = ctx.service.auth.username || ctx.service.options.email || ''
  if (!ctx.secret) throw new Error('Не задан пароль приложения')

  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: ctx.secret },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: ctx.env.allowInsecureTls ? { rejectUnauthorized: false } : undefined
  })

  await client.connect()
  try {
    // Та же папка, что и при синке: по UID из «Отправленных» в INBOX не зайти.
    let mailboxPath = 'INBOX'
    if (folder === 'sent' || folder === 'drafts') {
      const boxes = await client.list()
      const want = folder === 'sent' ? '\\Sent' : '\\Drafts'
      mailboxPath = boxes.find((b) => b.specialUse === want)?.path ?? mailboxPath
    }
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      let found: {
        subject: string
        from: string
        to: string
        cc: string
        date: number
        text: string
        html: string | null
        unread: boolean
      } | null = null

      for await (const msg of client.fetch(
        String(uid),
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true }
      )) {
        const env = msg.envelope
        const source = msg.source?.toString('utf8') ?? ''
        const { text, html } = parseMimeBodies(source)
        found = {
          subject: env?.subject || '(без темы)',
          from: formatAddrs(env?.from),
          to: formatAddrs(env?.to),
          cc: formatAddrs(env?.cc),
          date: env?.date instanceof Date ? env.date.getTime() : Date.now(),
          text,
          html,
          unread: !(msg.flags?.has('\\Seen') ?? false)
        }
        if (found.unread) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {})
        }
      }
      if (!found) throw new Error('Письмо не найдено')
      return found
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

/** Снять \\Seen (пометить непрочитанным). nativeId = `folder:uid`. */
export async function markImapUnread(ctx: SyncContext, nativeId: string): Promise<void> {
  const i = nativeId.indexOf(':')
  const folder = i < 0 ? 'inbox' : nativeId.slice(0, i)
  const uid = Number(i < 0 ? nativeId : nativeId.slice(i + 1))
  if (!Number.isFinite(uid)) throw new Error('Некорректный IMAP uid')
  const client = imapClient(ctx)
  await client.connect()
  try {
    let mailboxPath = folder === 'inbox' ? 'INBOX' : folder
    if (folder === 'sent' || folder === 'drafts' || folder === 'trash') {
      const boxes = await client.list()
      const want =
        folder === 'sent' ? '\\Sent' : folder === 'drafts' ? '\\Drafts' : '\\Trash'
      mailboxPath =
        boxes.find((b) => b.specialUse === want || (want === '\\Trash' && b.specialUse === '\\Deleted'))
          ?.path ?? mailboxPath
    }
    const lock = await client.getMailboxLock(mailboxPath)
    try {
      await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true })
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

function formatAddrs(
  list?: { name?: string | null; address?: string | null }[] | null
): string {
  if (!list?.length) return ''
  return list
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || ''))
    .filter(Boolean)
    .join(', ')
}

/** Грубая вытяжка text/plain и text/html из сырого MIME. */
export function parseMimeBodies(raw: string): { text: string; html: string | null } {
  const lower = raw.toLowerCase()
  const boundaryMatch = /boundary="?([^"\s;]+)"?/i.exec(raw)
  if (!boundaryMatch) {
    // Простое письмо без multipart.
    const headerEnd = raw.search(/\r?\n\r?\n/)
    const body = headerEnd >= 0 ? raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '') : raw
    if (/content-type:\s*text\/html/i.test(raw.slice(0, Math.max(0, headerEnd)))) {
      return { text: stripTags(body), html: body }
    }
    return { text: body.trim(), html: null }
  }

  const boundary = boundaryMatch[1]
  const parts = raw.split(new RegExp(`--${escapeRe(boundary)}(?:--)?`))
  let text = ''
  let html: string | null = null
  for (const part of parts) {
    const hend = part.search(/\r?\n\r?\n/)
    if (hend < 0) continue
    const headers = part.slice(0, hend)
    let body = part.slice(hend).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '')
    if (/content-transfer-encoding:\s*base64/i.test(headers)) {
      try {
        body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
      } catch {
        /* оставляем как есть */
      }
    } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
      body = decodeQuotedPrintable(body)
    }
    if (/content-type:\s*text\/html/i.test(headers)) html = body
    else if (/content-type:\s*text\/plain/i.test(headers)) text = body
  }
  if (!text && html) text = stripTags(html)
  // На случай если boundary нашёлся в заголовках, но части пустые.
  if (!text && !html && !lower.includes('multipart')) {
    const headerEnd = raw.search(/\r?\n\r?\n/)
    text = headerEnd >= 0 ? raw.slice(headerEnd).trim() : raw
  }
  return { text: text.trim(), html }
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
