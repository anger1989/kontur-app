import { randomUUID } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { Socket } from 'node:net'
import type {
  MailDetail,
  MailFolder,
  MailMailbox,
  MailRule,
  MailRuleUpsert,
  MailSendPayload
} from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { getItem, upsertItems } from '../db'
import type { SyncContext } from '../connectors/types'
import { createEasClient, extractBody, find, text } from '../connectors/eas'
import {
  createEwsFolder,
  deleteEwsRule,
  fetchEwsMessage,
  listEwsFolders,
  listEwsRules,
  moveEwsItems,
  sendEwsMail,
  setEwsRuleEnabled,
  upsertEwsRule
} from '../connectors/exchange'
import {
  createImapFolder,
  fetchImapMessage,
  listImapFolders,
  moveImapMessages
} from '../connectors/imap'
import {
  createJmapFolder,
  fetchJmapMessage,
  listJmapFolders,
  moveJmapEmails
} from '../connectors/jmap'
import { emitItemsChanged } from '../notify/itemsChanged'

/** Разобрать id элемента `env:service:mail:native` → serviceId + native server id. */
function parseMailId(id: string): { serviceId: string; nativeId: string } {
  const marker = ':mail:'
  const i = id.indexOf(marker)
  if (i < 0) throw new Error('Некорректный id письма')
  const prefix = id.slice(0, i) // envId:serviceId
  const serviceId = prefix.includes(':') ? prefix.slice(prefix.indexOf(':') + 1) : prefix
  const nativeId = id.slice(i + marker.length)
  if (!serviceId || !nativeId) throw new Error('Некорректный id письма')
  return { serviceId, nativeId }
}

function contextFor(serviceId: string): SyncContext {
  const cfg = getConfig()
  const service = cfg.services.find((s) => s.id === serviceId)
  if (!service) throw new Error('Сервис почты не найден')
  const env = cfg.envs.find((e) => e.id === service.envId)
  if (!env) throw new Error('Контур не найден')
  return {
    env,
    service,
    secret: getSecret(`${service.id}.secret`),
    cursor: null
  }
}

function protocolOf(ctx: SyncContext): string {
  return ctx.service.options.protocol || (ctx.service.options.jmapUrl ? 'jmap' : 'eas')
}

/**
 * IMAP/JMAP кодируют папку прямо в id письма (`mail:<folder>:<native>`) —
 * нужно различать одинаковые UID/id в разных папках. EAS так не делает
 * (ServerId и без того уникален), поэтому для него id не трогаем.
 */
function stripFolderPrefix(nativeId: string, protocol: string): string {
  if (protocol !== 'imap' && protocol !== 'jmap') return nativeId
  const i = nativeId.indexOf(':')
  return i < 0 ? nativeId : nativeId.slice(i + 1)
}

/** Прочитать письмо целиком (с телом). Помечает прочитанным локально и на сервере.
 *  Если сервер недоступен/401 — отдаём кэш, но локально всё равно «прочитано». */
export async function getMail(itemId: string): Promise<MailDetail> {
  const { serviceId, nativeId } = parseMailId(itemId)
  const existing = getItem(itemId)

  /** Сразу пишем в БД — иначе при уходе со страницы список снова подтянет unread. */
  const persistRead = (body?: string): void => {
    if (!existing) return
    const wasAttention = existing.unread || existing.mentioned
    upsertItems([
      {
        ...existing,
        body: body && body.length > 0 ? body.slice(0, 4000) : existing.body,
        unread: false,
        state: 'прочитано'
      }
    ])
    // Без emit виджет «Требует внимания» висит, пока не придёт чужой sync:
    // письмо уже прочитано в окне Почты, а не через клик по виджету.
    if (wasAttention) emitItemsChanged()
  }

  let detail: Omit<MailDetail, 'id' | 'serviceId'>
  try {
    const ctx = contextFor(serviceId)
    const protocol = protocolOf(ctx)

    if (protocol === 'eas') {
      const client = await createEasClient(ctx)
      const folders = await client.folderSync()
      // Папка письма не кодируется в его id (ServerId и так уникален) — берём
      // подсказку из уже засинканного item, иначе ищем во «Входящих» как раньше.
      const folderType = existing?.folder === 'sent' ? '5' : existing?.folder === 'drafts' ? '3' : '2'
      const folder = folders.find((f) => f.type === folderType) ?? folders.find((f) => f.type === '2')
      if (!folder) throw new Error('Папка «Входящие» не найдена')
      // Сначала помечаем прочитанным на сервере — чтобы следующий sync не вернул unread.
      // Для отправленных/черновиков «прочитано» не имеет смысла — не трогаем.
      if (folderType === '2') await client.markRead(folder.serverId, nativeId).catch(() => {})
      const props = await client.fetchItem(folder.serverId, nativeId)
      if (!props) throw new Error('Письмо не найдено на сервере')
      const data = find(props, 'ApplicationData') ?? props
      const { text: bodyText, html } = extractBody(data)
      const from = text(data, 'From') ?? ''
      const received = text(data, 'DateReceived')
      detail = {
        subject: text(data, 'Subject') || '(без темы)',
        from,
        to: text(data, 'To') ?? '',
        cc: text(data, 'Cc') ?? '',
        date: received ? Date.parse(received) || Date.now() : Date.now(),
        bodyText: bodyText || '(пустое письмо)',
        bodyHtml: html,
        unread: false
      }
    } else if (protocol === 'exchange') {
      const m = await fetchEwsMessage(ctx, nativeId)
      detail = {
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: m.date,
        bodyText: m.text,
        bodyHtml: m.html,
        unread: false
      }
    } else if (protocol === 'jmap') {
      const m = await fetchJmapMessage(ctx, stripFolderPrefix(nativeId, protocol))
      detail = {
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: m.date,
        bodyText: m.text,
        bodyHtml: m.html,
        unread: false
      }
    } else if (protocol === 'imap') {
      const folder = nativeId.includes(':') ? nativeId.split(':')[0] : 'inbox'
      const m = await fetchImapMessage(ctx, Number(stripFolderPrefix(nativeId, protocol)), folder)
      detail = {
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: m.date,
        bodyText: m.text,
        bodyHtml: m.html,
        unread: false
      }
    } else {
      throw new Error(`Протокол «${protocol}» не поддерживает чтение писем`)
    }
  } catch (err) {
    // Кэш + локально прочитано. На сервер попробуем пометить отдельно.
    persistRead()
    void markReadOnServer(serviceId, nativeId).catch(() => {})
    if (existing && (existing.body || existing.title)) {
      return {
        id: itemId,
        serviceId,
        subject: existing.title,
        from: existing.author ?? '',
        to: '',
        cc: '',
        date: existing.updatedAt,
        bodyText:
          existing.body ||
          `Не удалось загрузить полное письмо: ${err instanceof Error ? err.message : String(err)}`,
        bodyHtml: null,
        unread: false
      }
    }
    throw err
  }

  persistRead(detail.bodyText)
  return { id: itemId, serviceId, ...detail, unread: false }
}

/** Фоновая попытка пометить на сервере (для fallback-пути). */
async function markReadOnServer(serviceId: string, nativeId: string): Promise<void> {
  const ctx = contextFor(serviceId)
  const protocol = protocolOf(ctx)
  if (protocol === 'eas') {
    const client = await createEasClient(ctx)
    const folders = await client.folderSync()
    const inbox = folders.find((f) => f.type === '2')
    if (inbox) await client.markRead(inbox.serverId, nativeId)
  }
}

/** Отправить письмо (новое или ответ). */
export async function sendMail(payload: MailSendPayload): Promise<void> {
  const ctx = contextFor(payload.serviceId)
  if (!payload.to.trim()) throw new Error('Укажите получателя')
  if (!payload.subject.trim() && !payload.body.trim()) throw new Error('Пустое письмо')

  const protocol = protocolOf(ctx)
  const from =
    ctx.service.options.email ||
    ctx.service.auth.username ||
    ''
  if (!from) throw new Error('Не задан адрес отправителя (email в настройках сервиса)')

  if (protocol === 'eas') {
    const mime = buildMime({
      from,
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      body: payload.body
    })
    const client = await createEasClient(ctx)
    await client.sendMail(mime, randomUUID().replace(/-/g, '').slice(0, 16))
    return
  }

  if (protocol === 'exchange') {
    await sendEwsMail(ctx, {
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      body: payload.body
    })
    return
  }

  // JMAP / IMAP — через SMTP, если задан.
  const host = ctx.service.options.smtpHost?.trim()
  if (!host) {
    throw new Error('Для отправки задайте SMTP-сервер в настройках почты')
  }
  const port = Number(ctx.service.options.smtpPort) || 465
  await sendSmtp({
    host,
    port,
    user: ctx.service.auth.username || from,
    pass: ctx.secret ?? '',
    insecure: ctx.env.allowInsecureTls,
    from,
    to: payload.to,
    cc: payload.cc,
    subject: payload.subject,
    body: payload.body
  })
}

/** Пометить письмо прочитанным локально (сервер — при getMail). */
export function markMailRead(itemId: string): void {
  const existing = getItem(itemId)
  if (!existing || !existing.unread) return
  upsertItems([{ ...existing, unread: false, state: 'прочитано' }])
  emitItemsChanged()
}

function buildMime(p: {
  from: string
  to: string
  cc?: string
  subject: string
  body: string
}): string {
  const lines = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    ...(p.cc?.trim() ? [`Cc: ${p.cc.trim()}`] : []),
    `Subject: ${encodeSubject(p.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    p.body.replace(/\r?\n/g, '\r\n')
  ]
  return lines.join('\r\n')
}

function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

/** Минимальный SMTP-клиент: AUTH LOGIN + DATA. */
async function sendSmtp(opts: {
  host: string
  port: number
  user: string
  pass: string
  insecure?: boolean
  from: string
  to: string
  cc?: string
  subject: string
  body: string
}): Promise<void> {
  const recipients = [...opts.to.split(/[,;]/), ...(opts.cc ?? '').split(/[,;]/)]
    .map((a) => a.trim())
    .filter(Boolean)

  const socket: Socket =
    opts.port === 465
      ? tlsConnect({ host: opts.host, port: opts.port, rejectUnauthorized: !opts.insecure, servername: opts.host })
      : new Socket()

  if (opts.port !== 465) {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(opts.port, opts.host, resolve)
    })
  } else {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('secureConnect', resolve)
    })
  }

  const read = (): Promise<string> =>
    new Promise((resolve, reject) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (/^\d{3}[ \-].*\n/m.test(buf) && !/^\d{3}-/m.test(buf.split('\n').filter(Boolean).pop() ?? '')) {
          socket.off('data', onData)
          socket.off('error', reject)
          resolve(buf)
        }
      }
      socket.on('data', onData)
      socket.once('error', reject)
    })

  const write = async (line: string): Promise<string> => {
    socket.write(line + '\r\n')
    return read()
  }

  try {
    await read() // greeting
    let r = await write(`EHLO kontur.local`)
    if (opts.port === 587 && /STARTTLS/i.test(r)) {
      await write('STARTTLS')
      // После STARTTLS нужен TLS-upgrade — упрощённо требуем 465.
      throw new Error('SMTP STARTTLS на 587 пока не поддерживается — укажите порт 465 (SMTPS)')
    }
    r = await write('AUTH LOGIN')
    if (!r.startsWith('334')) throw new Error(`SMTP AUTH: ${r.slice(0, 80)}`)
    r = await write(Buffer.from(opts.user).toString('base64'))
    if (!r.startsWith('334')) throw new Error(`SMTP user: ${r.slice(0, 80)}`)
    r = await write(Buffer.from(opts.pass).toString('base64'))
    if (!r.startsWith('235')) throw new Error('SMTP отклонил логин/пароль')
    r = await write(`MAIL FROM:<${extractAddr(opts.from)}>`)
    if (!r.startsWith('250')) throw new Error(`SMTP MAIL FROM: ${r.slice(0, 80)}`)
    for (const rcpt of recipients) {
      r = await write(`RCPT TO:<${extractAddr(rcpt)}>`)
      if (!r.startsWith('250')) throw new Error(`SMTP RCPT ${rcpt}: ${r.slice(0, 80)}`)
    }
    r = await write('DATA')
    if (!r.startsWith('354')) throw new Error(`SMTP DATA: ${r.slice(0, 80)}`)
    const mime = buildMime({
      from: opts.from,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      body: opts.body
    })
    socket.write(mime.replace(/^\./gm, '..') + '\r\n.\r\n')
    r = await read()
    if (!r.startsWith('250')) throw new Error(`SMTP send: ${r.slice(0, 80)}`)
    await write('QUIT').catch(() => {})
  } finally {
    socket.destroy()
  }
}

function extractAddr(s: string): string {
  const m = /<([^>]+)>/.exec(s)
  return (m?.[1] ?? s).trim()
}

/* ── Папки / перемещение / inbox rules ─────────────────────────────── */

const EAS_MAIL_TYPES = new Set(['1', '2', '3', '4', '5', '6', '12'])

function easRole(type: string): MailFolder | null {
  if (type === '2') return 'inbox'
  if (type === '3') return 'drafts'
  if (type === '5') return 'sent'
  return null
}

function resolveMailServiceId(serviceId?: string, envId?: string): string {
  if (serviceId) return serviceId
  const cfg = getConfig()
  const s = cfg.services.find(
    (x) => x.kind === 'mail' && x.enabled && (!envId || x.envId === envId)
  )
  if (!s) throw new Error('Нет подключённой почты')
  return s.id
}

/** Live-список папок с сервера. */
export async function listMailFolders(opts: {
  serviceId?: string
  envId?: string
}): Promise<MailMailbox[]> {
  const ctx = contextFor(resolveMailServiceId(opts.serviceId, opts.envId))
  const protocol = protocolOf(ctx)

  if (protocol === 'eas') {
    const client = await createEasClient(ctx)
    const folders = await client.folderSync()
    return folders
      .filter((f) => EAS_MAIL_TYPES.has(f.type) && f.serverId)
      .map((f) => ({
        id: f.serverId,
        name: f.name || f.serverId,
        parentId: f.parentId && f.parentId !== '0' ? f.parentId : null,
        role: easRole(f.type)
      }))
  }
  if (protocol === 'exchange') return listEwsFolders(ctx)
  if (protocol === 'imap') return listImapFolders(ctx)
  if (protocol === 'jmap') return listJmapFolders(ctx)
  throw new Error(`Протокол «${protocol}» не поддерживает список папок`)
}

export async function createMailFolder(opts: {
  serviceId: string
  name: string
  parentId?: string | null
}): Promise<MailMailbox> {
  const name = opts.name.trim()
  if (!name) throw new Error('Укажите имя папки')
  const ctx = contextFor(opts.serviceId)
  const protocol = protocolOf(ctx)

  if (protocol === 'eas') {
    const client = await createEasClient(ctx)
    const serverId = await client.folderCreate(opts.parentId || '0', name)
    return { id: serverId, name, parentId: opts.parentId ?? null, role: null }
  }
  if (protocol === 'exchange') return createEwsFolder(ctx, name, opts.parentId)
  if (protocol === 'imap') return createImapFolder(ctx, name, opts.parentId)
  if (protocol === 'jmap') return createJmapFolder(ctx, name, opts.parentId)
  throw new Error(`Протокол «${protocol}» не поддерживает создание папок`)
}

/**
 * Переместить письма. itemIds — полные id элементов `env:service:mail:…`.
 * folderId — server id папки или role alias (inbox/sent/drafts).
 */
export async function moveMail(opts: {
  itemIds: string[]
  folderId: string
}): Promise<void> {
  if (!opts.itemIds.length) return
  if (!opts.folderId.trim()) throw new Error('Укажите папку назначения')

  const byService = new Map<string, string[]>()
  for (const id of opts.itemIds) {
    const { serviceId } = parseMailId(id)
    const list = byService.get(serviceId) ?? []
    list.push(id)
    byService.set(serviceId, list)
  }

  for (const [serviceId, ids] of byService) {
    const ctx = contextFor(serviceId)
    const protocol = protocolOf(ctx)
    const destFolder = opts.folderId.trim()

    if (protocol === 'eas') {
      const client = await createEasClient(ctx)
      const folders = await client.folderSync()
      let dst =
        folders.find((f) => f.serverId === destFolder) ??
        (destFolder === 'inbox'
          ? folders.find((f) => f.type === '2')
          : destFolder === 'sent'
            ? folders.find((f) => f.type === '5')
            : destFolder === 'drafts'
              ? folders.find((f) => f.type === '3')
              : undefined)
      if (!dst) throw new Error(`Папка назначения «${destFolder}» не найдена`)

      // Группируем по исходной папке (из локального item.folder).
      const bySrc = new Map<string, { itemId: string; nativeId: string }[]>()
      for (const itemId of ids) {
        const { nativeId } = parseMailId(itemId)
        const existing = getItem(itemId)
        const role = (existing?.folder ?? 'inbox') as string
        const src =
          folders.find((f) => f.serverId === role) ??
          (role === 'sent'
            ? folders.find((f) => f.type === '5')
            : role === 'drafts'
              ? folders.find((f) => f.type === '3')
              : folders.find((f) => f.type === '2'))
        if (!src) throw new Error('Исходная папка письма не найдена')
        const list = bySrc.get(src.serverId) ?? []
        list.push({ itemId, nativeId })
        bySrc.set(src.serverId, list)
      }
      const destRole = easRole(dst.type)
      const folderLabel = destRole ?? dst.serverId
      for (const [srcId, group] of bySrc) {
        const moved = await client.moveItems(
          srcId,
          group.map((g) => g.nativeId),
          dst.serverId
        )
        const dstBySrc = new Map(moved.map((m) => [m.srcMsgId, m.dstMsgId]))
        for (const g of group) {
          const existing = getItem(g.itemId)
          if (!existing) continue
          const newNative = dstBySrc.get(g.nativeId) ?? g.nativeId
          // ServerId после move часто меняется — обновляем id элемента.
          const newId =
            newNative !== g.nativeId
              ? g.itemId.replace(`:mail:${g.nativeId}`, `:mail:${newNative}`)
              : g.itemId
          upsertItems([{ ...existing, id: newId, folder: folderLabel }])
        }
      }
    } else if (protocol === 'exchange') {
      const nativeIds = ids.map((id) => parseMailId(id).nativeId)
      await moveEwsItems(ctx, nativeIds, destFolder)
      const folders = await listEwsFolders(ctx).catch(() => [] as MailMailbox[])
      const dest = folders.find((f) => f.id === destFolder || f.role === destFolder)
      const folderLabel = dest?.role ?? destFolder
      for (const itemId of ids) {
        const existing = getItem(itemId)
        if (existing) upsertItems([{ ...existing, folder: folderLabel }])
      }
    } else if (protocol === 'imap') {
      const refs = ids.map((itemId) => {
        const { nativeId } = parseMailId(itemId)
        const folder = nativeId.includes(':') ? nativeId.split(':')[0] : 'inbox'
        return {
          itemId,
          mailboxPath: folder,
          uid: Number(stripFolderPrefix(nativeId, 'imap')),
          srcFolder: folder
        }
      })
      await moveImapMessages(
        ctx,
        refs.map((r) => ({ mailboxPath: r.mailboxPath, uid: r.uid })),
        destFolder
      )
      const destLabel = destFolder
      for (const r of refs) {
        const existing = getItem(r.itemId)
        if (!existing) continue
        const newId = r.itemId.replace(
          `:mail:${r.srcFolder}:${r.uid}`,
          `:mail:${destLabel}:${r.uid}`
        )
        upsertItems([{ ...existing, id: newId, folder: destLabel }])
      }
    } else if (protocol === 'jmap') {
      const nativeIds = ids.map((id) =>
        stripFolderPrefix(parseMailId(id).nativeId, 'jmap')
      )
      await moveJmapEmails(ctx, nativeIds, destFolder)
      const boxes = await listJmapFolders(ctx).catch(() => [] as MailMailbox[])
      const dest = boxes.find((f) => f.id === destFolder || f.role === destFolder)
      const folderLabel = dest?.role ?? destFolder
      for (const itemId of ids) {
        const existing = getItem(itemId)
        if (!existing) continue
        const { nativeId } = parseMailId(itemId)
        const raw = stripFolderPrefix(nativeId, 'jmap')
        const oldFolder = nativeId.includes(':') ? nativeId.split(':')[0] : 'inbox'
        const newId = itemId.replace(`:mail:${oldFolder}:${raw}`, `:mail:${folderLabel}:${raw}`)
        upsertItems([{ ...existing, id: newId, folder: folderLabel }])
      }
    } else {
      throw new Error(`Протокол «${protocol}» не поддерживает перемещение писем`)
    }
  }

  emitItemsChanged()
}

function ewsCtxForRules(serviceId?: string, envId?: string): SyncContext {
  const ctx = contextFor(resolveMailServiceId(serviceId, envId))
  const protocol = protocolOf(ctx)
  if (protocol === 'exchange') return ctx
  if (protocol === 'eas') {
    if (!ctx.service.options.ewsUrl?.trim() && !ctx.service.options.webUrl?.trim()) {
      throw new Error(
        'Правила доступны только через EWS. Укажите ewsUrl (или webUrl) в настройках почты.'
      )
    }
    return ctx
  }
  throw new Error(
    'Правила доступны только через EWS (протокол exchange или eas + ewsUrl/webUrl).'
  )
}

export async function listMailRules(opts: {
  serviceId?: string
  envId?: string
}): Promise<MailRule[]> {
  return listEwsRules(ewsCtxForRules(opts.serviceId, opts.envId))
}

/** Папки для форм правил — всегда EWS FolderId (на EAS-ящиках id ActiveSync другие). */
export async function listMailFoldersForRules(opts: {
  serviceId?: string
  envId?: string
}): Promise<MailMailbox[]> {
  return listEwsFolders(ewsCtxForRules(opts.serviceId, opts.envId))
}

export async function upsertMailRule(opts: {
  serviceId?: string
  envId?: string
  rule: MailRuleUpsert
}): Promise<MailRule> {
  return upsertEwsRule(ewsCtxForRules(opts.serviceId, opts.envId), opts.rule)
}

export async function deleteMailRule(opts: {
  serviceId?: string
  envId?: string
  ruleId: string
}): Promise<void> {
  await deleteEwsRule(ewsCtxForRules(opts.serviceId, opts.envId), opts.ruleId)
}

export async function setMailRuleEnabled(opts: {
  serviceId?: string
  envId?: string
  ruleId: string
  enabled: boolean
}): Promise<MailRule> {
  return setEwsRuleEnabled(
    ewsCtxForRules(opts.serviceId, opts.envId),
    opts.ruleId,
    opts.enabled
  )
}

/** Поддерживает ли сервис inbox rules (EWS). */
export function mailRulesSupported(serviceId: string): boolean {
  try {
    const ctx = contextFor(serviceId)
    const protocol = protocolOf(ctx)
    if (protocol === 'exchange') return true
    if (protocol === 'eas') {
      return Boolean(ctx.service.options.ewsUrl?.trim() || ctx.service.options.webUrl?.trim())
    }
    return false
  } catch {
    return false
  }
}
