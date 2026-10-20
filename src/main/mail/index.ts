import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { connect as tlsConnect } from 'node:tls'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import type {
  MailAttachment,
  MailDetail,
  MailFolder,
  MailMailbox,
  MailOutgoingAttachment,
  MailRule,
  MailRuleUpsert,
  MailSendPayload
} from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { getItem, markItemsUnread, setItemFlagged, upsertItems } from '../db'
import type { SyncContext } from '../connectors/types'
import { createEasClient, extractBody, find, findAll, text, type Node } from '../connectors/eas'
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
/**
 * Потолок на письмо: Exchange по умолчанию режет вложения на ~25-35 МБ, а
 * base64 раздувает их ещё на треть. Лучше сказать об этом до отправки.
 */
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024

/** MIME-тип по расширению — сервер присылает ContentType не всегда. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook'
}

export function mimeForName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * Вложения письма из ApplicationData (EAS).
 *
 * `FileReference` — то, чем потом качаем содержимое; без него вложение
 * показывать бессмысленно, такие пропускаем.
 */
function parseEasAttachments(data: Node | null): MailAttachment[] {
  const out: MailAttachment[] = []
  for (const node of findAll(data, 'Attachment')) {
    const id = text(node, 'FileReference')
    if (!id) continue
    const name = text(node, 'DisplayName') || 'Вложение'
    const size = Number(text(node, 'EstimatedDataSize') ?? '')
    out.push({
      id,
      name,
      size: Number.isFinite(size) && size > 0 ? size : null,
      mime: text(node, 'ContentType') || mimeForName(name),
      inline: text(node, 'IsInline') === '1',
      contentId: text(node, 'ContentId')
    })
  }
  return out
}

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
        unread: false,
        attachments: parseEasAttachments(data)
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
        unread: false,
        // Вложения по этому протоколу пока не перечисляем (см. getMailAttachment).
        attachments: []
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
        unread: false,
        // Вложения по этому протоколу пока не перечисляем (см. getMailAttachment).
        attachments: []
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
        unread: false,
        // Вложения по этому протоколу пока не перечисляем (см. getMailAttachment).
        attachments: []
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
        unread: false,
        attachments: []
      }
    }
    throw err
  }

  persistRead(detail.bodyText)
  return { id: itemId, serviceId, ...detail, unread: false }
}

/**
 * Содержимое вложения с сервера.
 *
 * Пока умеет EAS (на нём работают оба почтовых контура). Для остальных
 * протоколов честно говорим, что вложение скачать нечем, — это лучше, чем
 * молча отдать пустой файл.
 */
export async function getMailAttachment(
  itemId: string,
  attachmentId: string
): Promise<{ data: Buffer; mime: string | null }> {
  const { serviceId } = parseMailId(itemId)
  const ctx = contextFor(serviceId)
  const protocol = protocolOf(ctx)
  if (protocol !== 'eas') {
    throw new Error(`Скачивание вложений для протокола «${protocol}» пока не поддерживается`)
  }
  const client = await createEasClient(ctx)
  return client.fetchAttachment(attachmentId)
}

/**
 * Открывать вложение системой можно не всё: исполняемые файлы и образы дисков
 * запускают чужой код одним кликом. Их только сохраняем — как делает Outlook.
 */
const UNSAFE_EXT = new Set([
  'app', 'bat', 'cmd', 'com', 'command', 'dmg', 'exe', 'jar', 'js', 'jse', 'msi',
  'osx', 'pkg', 'ps1', 'reg', 'scpt', 'scr', 'sh', 'terminal', 'vb', 'vbs', 'workflow'
])

/** Имя файла без путей и управляющих символов — его присылает сервер. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'attachment'
  const clean = base.replace(/[\u0000-\u001f:]/g, '_').trim()
  return clean || 'attachment'
}

/** Скачать вложение и открыть системным приложением. */
export async function openMailAttachment(
  itemId: string,
  attachment: { id: string; name: string }
): Promise<void> {
  const name = safeFileName(attachment.name)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (UNSAFE_EXT.has(ext)) {
    throw new Error('Такие вложения Kontur не открывает — сохраните файл и откройте сами')
  }
  const { data } = await getMailAttachment(itemId, attachment.id)
  // Отдельная папка на каждое открытие: одинаковые имена из разных писем
  // не должны перетирать друг друга, пока файл открыт.
  const dir = join(tmpdir(), 'kontur-attachments', randomUUID().slice(0, 8))
  await fsp.mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await fsp.writeFile(file, data, { mode: 0o600 })
  const err = await shell.openPath(file)
  if (err) throw new Error(err)
}

/** Скачать вложение и сохранить через диалог. Возвращает путь или null. */
export async function saveMailAttachment(
  win: BrowserWindow | null,
  itemId: string,
  attachment: { id: string; name: string }
): Promise<string | null> {
  const name = safeFileName(attachment.name)
  const opts = {
    title: 'Сохранить вложение',
    defaultPath: join(app.getPath('downloads'), name)
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return null
  const { data } = await getMailAttachment(itemId, attachment.id)
  await fsp.writeFile(res.filePath, data)
  return res.filePath
}

/** Диалог выбора файлов для письма. Содержимое сразу в base64 — его шлём как есть. */
export async function pickMailAttachments(
  win: BrowserWindow | null
): Promise<MailOutgoingAttachment[]> {
  if (!win) return []
  const res = await dialog.showOpenDialog(win, {
    title: 'Прикрепить файлы',
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled) return []
  const out: MailOutgoingAttachment[] = []
  let total = 0
  for (const path of res.filePaths) {
    const buf = await fsp.readFile(path)
    total += buf.length
    if (total > MAX_ATTACHMENTS_BYTES) {
      throw new Error(`Вложения больше ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} МБ — такое письмо сервер не примет`)
    }
    const name = safeFileName(path.split('/').pop() ?? 'file')
    out.push({ name, mime: mimeForName(name), data: buf.toString('base64') })
  }
  return out
}

/** Фоновая попытка пометить на сервере (для fallback-пути). */
async function markReadOnServer(serviceId: string, nativeId: string): Promise<void> {
  const ctx = contextFor(serviceId)
  const protocol = protocolOf(ctx)
  if (protocol === 'eas') {
    const client = await createEasClient(ctx)
    const folders = await client.folderSync()
    const inbox = folders.find((f) => f.type === '2')
    if (inbox) await client.markRead(inbox.serverId, nativeId, true)
  }
}

async function markUnreadOnServer(
  serviceId: string,
  nativeId: string,
  itemId: string
): Promise<void> {
  const ctx = contextFor(serviceId)
  const protocol = protocolOf(ctx)
  if (protocol === 'eas') {
    const client = await createEasClient(ctx)
    const folders = await client.folderSync()
    const existing = getItem(itemId)
    const role = (existing?.folder ?? 'inbox') as string
    const folder =
      folders.find((f) => f.serverId === role) ??
      (role === 'sent'
        ? folders.find((f) => f.type === '5')
        : role === 'drafts'
          ? folders.find((f) => f.type === '3')
          : role === 'trash'
            ? folders.find((f) => f.type === '4')
            : folders.find((f) => f.type === '2'))
    if (folder) await client.markRead(folder.serverId, stripFolderPrefix(nativeId, protocol), false)
  } else if (protocol === 'imap') {
    const { markImapUnread } = await import('../connectors/imap')
    await markImapUnread(ctx, nativeId)
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

  const inReplyTo = payload.replyToId
    ? `<${payload.replyToId.replace(/[^\w.@+-]/g, '_')}@kontur.local>`
    : undefined

  const attachments = payload.attachments ?? []
  const attachmentsBytes = attachments.reduce((n, a) => n + Math.ceil(a.data.length * 0.75), 0)
  if (attachmentsBytes > MAX_ATTACHMENTS_BYTES) {
    throw new Error(
      `Вложения больше ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)} МБ — такое письмо сервер не примет`
    )
  }

  if (protocol === 'eas') {
    const mime = buildMime({
      from,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      body: payload.body,
      inReplyTo,
      attachments
    })
    const client = await createEasClient(ctx)
    await client.sendMail(mime, randomUUID().replace(/-/g, '').slice(0, 16))
    return
  }

  if (protocol === 'exchange') {
    if (attachments.length) {
      throw new Error('Отправка вложений через EWS пока не поддерживается')
    }
    await sendEwsMail(ctx, {
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      body: payload.body,
      inReplyTo
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
    bcc: payload.bcc,
    subject: payload.subject,
    body: payload.body,
    inReplyTo,
    attachments
  })
}

/** Пометить письмо прочитанным локально (сервер — при getMail). */
export function markMailRead(itemId: string): void {
  const existing = getItem(itemId)
  if (!existing || !existing.unread) return
  upsertItems([{ ...existing, unread: false, state: 'прочитано' }])
  emitItemsChanged()
}

/** Локально + best-effort на сервере (EAS). Для шагов автоматизаций. */
export async function markMailReadFully(itemId: string): Promise<void> {
  markMailRead(itemId)
  try {
    const { serviceId, nativeId } = parseMailId(itemId)
    await markReadOnServer(serviceId, nativeId)
  } catch {
    /* локальной отметки достаточно, чтобы poll не зациклился */
  }
}

/** Пометить непрочитанным локально + best-effort на сервере. */
export function markMailUnread(itemId: string): void {
  const n = markItemsUnread([itemId])
  if (n > 0) emitItemsChanged()
  const { serviceId, nativeId } = parseMailId(itemId)
  void markUnreadOnServer(serviceId, nativeId, itemId).catch(() => {})
}

/** Локальная звезда. */
export function setMailFlagged(itemId: string, flagged: boolean): void {
  if (setItemFlagged(itemId, flagged)) emitItemsChanged()
}

/** base64 строками по 76 символов, как требует RFC 2045. */
function base64Lines(data: string): string {
  return (data.replace(/\s+/g, '').match(/.{1,76}/g) ?? []).join('\r\n')
}

/** Имя файла в заголовке: RFC 2047, если оно не чисто латинское. */
function encodeFileName(name: string): string {
  return /^[\x20-\x7e]*$/.test(name) ? name : encodeSubject(name)
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function mimePart(
  boundary: string,
  headers: string[],
  body: string
): string {
  return [`--${boundary}`, ...headers, '', body].join('\r\n')
}

/**
 * Письмо в MIME. Без вложений — обычный text/plain, как было.
 *
 * С вложениями собираем multipart/mixed. Картинки, вставленные в тело через
 * Ctrl+V, уходят внутри multipart/related с cid-ссылками: получатель в Outlook
 * видит их прямо в письме, а не файлами снизу.
 */
function buildMime(p: {
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  inReplyTo?: string
  attachments?: MailOutgoingAttachment[]
}): string {
  const headers = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    ...(p.cc?.trim() ? [`Cc: ${p.cc.trim()}`] : []),
    ...(p.bcc?.trim() ? [`Bcc: ${p.bcc.trim()}`] : []),
    `Subject: ${encodeSubject(p.subject)}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`] : []),
    'MIME-Version: 1.0'
  ]
  const plain = p.body.replace(/\r?\n/g, '\r\n')
  const all = p.attachments ?? []

  if (!all.length) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      plain
    ].join('\r\n')
  }

  const inline = all.filter((a) => a.inline)
  const files = all.filter((a) => !a.inline)
  const stamp = randomUUID().replace(/-/g, '')
  const mixed = `mixed_${stamp}`
  const related = `related_${stamp}`

  const cidOf = (i: number): string => `img${i}.${stamp}@kontur.local`

  // Тело: либо plain text, либо related с html и картинками.
  let bodyPart: string
  if (inline.length) {
    const html = [
      '<html><body>',
      `<div style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(p.body)}</div>`,
      ...inline.map((_, i) => `<div><img src="cid:${cidOf(i)}" style="max-width:100%"></div>`),
      '</body></html>'
    ].join('')
    bodyPart = [
      mimePart(mixed, [`Content-Type: multipart/related; boundary="${related}"`], ''),
      mimePart(
        related,
        ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit'],
        html
      ),
      ...inline.map((a, i) =>
        mimePart(
          related,
          [
            `Content-Type: ${a.mime}; name="${encodeFileName(a.name)}"`,
            `Content-ID: <${cidOf(i)}>`,
            `Content-Disposition: inline; filename="${encodeFileName(a.name)}"`,
            'Content-Transfer-Encoding: base64'
          ],
          base64Lines(a.data)
        )
      ),
      `--${related}--`
    ].join('\r\n')
  } else {
    bodyPart = mimePart(
      mixed,
      ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'],
      plain
    )
  }

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    bodyPart,
    ...files.map((a) =>
      mimePart(
        mixed,
        [
          `Content-Type: ${a.mime}; name="${encodeFileName(a.name)}"`,
          `Content-Disposition: attachment; filename="${encodeFileName(a.name)}"`,
          'Content-Transfer-Encoding: base64'
        ],
        base64Lines(a.data)
      )
    ),
    `--${mixed}--`,
    ''
  ].join('\r\n')
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
  bcc?: string
  subject: string
  body: string
  inReplyTo?: string
  attachments?: MailOutgoingAttachment[]
}): Promise<void> {
  const recipients = [
    ...opts.to.split(/[,;]/),
    ...(opts.cc ?? '').split(/[,;]/),
    ...(opts.bcc ?? '').split(/[,;]/)
  ]
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
      bcc: opts.bcc,
      subject: opts.subject,
      body: opts.body,
      inReplyTo: opts.inReplyTo,
      attachments: opts.attachments
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
  if (type === '4') return 'trash'
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
              : destFolder === 'trash' || destFolder === 'deleted'
                ? folders.find((f) => f.type === '4')
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
              : role === 'trash'
                ? folders.find((f) => f.type === '4')
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
