import type { Item, MailMailbox, MailRule, MailRuleUpsert } from '@shared/types'
import { base, stripHtml } from './http'
import { easHttpPost, type EasAuthMode } from './eas/http'
import { itemId, type Connector, type PruneWindow, type SyncContext, type SyncResult } from './types'
import { syncJmap } from './jmap'
import { syncImap } from './imap'
import { caldavWindow, syncCaldav } from './caldav'
import { syncEas } from './eas'
import { logInfo, logError, logWarn } from '../log'

/** Basic → Negotiate: как у EAS. Многие Exchange рвут TCP на Basic вместо 401. */
const ewsAuthMode = new Map<string, EasAuthMode>()

/**
 * Выполнить источник, но не ронять остальные: ошибку пишем в лог с деталями.
 * `ok` говорит, что выдача настоящая, а не пустышка после ошибки — по пустышке
 * чистить локальную копию нельзя.
 */
async function trySource(
  ctx: SyncContext,
  label: string,
  fn: () => Promise<Item[]>
): Promise<{ items: Item[]; ok: boolean }> {
  try {
    const items = await fn()
    logInfo('mail', `${ctx.service.id}/${label}: получено ${items.length}`)
    return { items, ok: true }
  } catch (err) {
    logError('mail', `${ctx.service.id}/${label}: ${err instanceof Error ? err.message : String(err)}`)
    return { items: [], ok: false }
  }
}

/**
 * Exchange через EWS (SOAP). Для локального Exchange/OWA это штатный API:
 * один и тот же сервер отдаёт и непрочитанную почту, и ближайшие события
 * календаря — поэтому один коннектор питает и «Почту», и «Календарь».
 */

const EWS_NS = 'http://schemas.microsoft.com/exchange/services/2006/messages'
const T_NS = 'http://schemas.microsoft.com/exchange/services/2006/types'

function ewsUrl(ctx: SyncContext): string {
  const explicit = ctx.service.options.ewsUrl?.trim()
  if (explicit) return explicit
  // Для EAS-ящиков webUrl часто указывает на OWA; иначе — baseUrl.
  const root = ctx.service.options.webUrl?.trim() || ctx.service.baseUrl
  return `${base(root)}/EWS/Exchange.asmx`
}

/** Имя операции из тела → SOAPAction (без него часть IIS/Exchange рвёт сокет). */
function soapAction(body: string): string {
  const op = /<m:([A-Za-z0-9]+)/.exec(body)?.[1] ?? 'Exchange'
  return `http://schemas.microsoft.com/exchange/services/2006/messages/${op}`
}

function isTransientSocketError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
  return /other side closed|ECONNRESET|EPIPE|socket hang up|UND_ERR_SOCKET|ECONNREFUSED/i.test(
    `${msg} ${code}`
  )
}

async function soapWithAuth(
  ctx: SyncContext,
  body: string,
  authMode: EasAuthMode
): Promise<{ text: string; status: number; wwwAuth: string }> {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:m="${EWS_NS}" xmlns:t="${T_NS}">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013"/>
  </soap:Header>
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`

  const user = ctx.service.auth.username || ctx.service.options.email || ''
  // Тот же транспорт, что EAS: undici Basic или Electron Negotiate/NTLM.
  // Connection: close — не держим keep-alive через VPN (иначе other side closed).
  const res = await easHttpPost({
    url: ewsUrl(ctx),
    body: Buffer.from(envelope, 'utf8'),
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      SOAPAction: `"${soapAction(body)}"`,
      connection: 'close'
    },
    user,
    password: ctx.secret ?? '',
    env: ctx.env,
    authMode,
    headersTimeout: 45_000
  })
  return { text: res.buffer.toString('utf8'), status: res.status, wwwAuth: res.wwwAuth }
}

function throwIfSoapFailed(text: string, status: number, wwwAuth: string): void {
  if (status === 401) {
    throw Object.assign(
      new Error(
        /ntlm|negotiate/i.test(wwwAuth)
          ? 'EWS отклонил вход (401/NTLM). Проверьте доменный логин (DOMAIN\\user) и пароль AD.'
          : 'EWS отклонил доступ (401). Проверьте логин и пароль почты.'
      ),
      { status: 401 as const, wwwAuth }
    )
  }
  if (status >= 400) {
    throw new Error(`EWS ответил ${status}: ${text.slice(0, 160)}`)
  }
  if (/<faultcode\b|<s:Fault\b|<soap:Fault\b/i.test(text)) {
    const fault =
      /<(?:faultstring|s:faultstring|soap:faultstring)[^>]*>([\s\S]*?)<\//i.exec(text)?.[1]?.trim() ??
      text.slice(0, 200)
    throw new Error(`EWS: ${fault.replace(/<[^>]+>/g, '').slice(0, 220)}`)
  }
}

async function soap(ctx: SyncContext, body: string): Promise<string> {
  const sid = ctx.service.id
  let mode = ewsAuthMode.get(sid) ?? 'basic'

  const run = async (authMode: EasAuthMode): Promise<string> => {
    const res = await soapWithAuth(ctx, body, authMode)
    throwIfSoapFailed(res.text, res.status, res.wwwAuth)
    return res.text
  }

  try {
    return await run(mode)
  } catch (err) {
    const www =
      err && typeof err === 'object' && 'wwwAuth' in err
        ? String((err as { wwwAuth?: unknown }).wwwAuth ?? '')
        : ''
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status?: unknown }).status)
        : 0

    // Basic отвергнут с NTLM challenge или сокет оборван — как у EAS, пробуем Negotiate.
    if (
      mode === 'basic' &&
      (status === 401 || isTransientSocketError(err) || /ntlm|negotiate/i.test(www))
    ) {
      logWarn(
        'mail',
        `EWS ${isTransientSocketError(err) ? 'socket' : '401'} Basic → negotiate (${ctx.service.id})`
      )
      mode = 'negotiate'
      ewsAuthMode.set(sid, mode)
      try {
        return await run(mode)
      } catch (retryErr) {
        if (isTransientSocketError(retryErr)) {
          throw new Error(
            'EWS оборвал соединение (NTLM). Проверьте VPN, ewsUrl и что контур поднят.'
          )
        }
        throw retryErr
      }
    }

    if (isTransientSocketError(err)) {
      throw new Error(
        'EWS оборвал соединение. Проверьте VPN/ewsUrl и что контур поднят, затем повторите.'
      )
    }
    throw err
  }
}

/* Регэкспы вместо полноценного XML-парсера: ответы EWS предсказуемы, а лишней
   зависимости так не тянем. Берём только нужные поля. */
const between = (xml: string, tag: string): string[] => {
  const out: string[] = []
  const re = new RegExp(`<t:${tag}[^>]*>([\\s\\S]*?)</t:${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}
const attr = (xml: string, tag: string, name: string): string | null =>
  new RegExp(`<t:${tag}[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? null
const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')

function splitItems(xml: string, wrapper: string): string[] {
  const re = new RegExp(`<t:${wrapper}[^>]*>([\\s\\S]*?)</t:${wrapper}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

async function fetchMail(ctx: SyncContext): Promise<Item[]> {
  // Все письма из «Входящих», до 100, свежие сверху (не только непрочитанные).
  const xml = await soap(
    ctx,
    `<m:FindItem Traversal="Shallow">
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Preview"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="100" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="inbox"/></m:ParentFolderIds>
    </m:FindItem>`
  )

  return splitItems(xml, 'Message').map((m) => {
    const id = attr(m, 'ItemId', 'Id') ?? Math.random().toString(36)
    const subject = unescape(between(m, 'Subject')[0] ?? '(без темы)')
    const from = unescape(between(m, 'Name')[0] ?? '')
    const received = between(m, 'DateTimeReceived')[0] ?? ''
    const isRead = /<t:IsRead[^>]*>true<\/t:IsRead>/i.test(m)
    const preview = unescape(between(m, 'Preview')[0] ?? '')
    return {
      id: itemId(ctx.service, `mail:${id}`),
      envId: ctx.service.envId,
      serviceId: ctx.service.id,
      kind: 'mail' as const,
      title: subject,
      body: preview,
      author: from || null,
      state: isRead ? 'прочитано' : 'непрочитано',
      url: base(ctx.service.baseUrl),
      updatedAt: received ? Date.parse(received) : Date.now(),
      unread: !isRead,
      mentioned: false,
      startsAt: null,
      endsAt: null
    }
  })
}

/** Полное письмо по EWS ItemId. */
export async function fetchEwsMessage(
  ctx: SyncContext,
  itemIdRaw: string
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
  const xml = await soap(
    ctx,
    `<m:GetItem>
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:BodyType>Best</t:BaseType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="message:CcRecipients"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds><t:ItemId Id="${itemIdRaw.replace(/"/g, '')}"/></m:ItemIds>
    </m:GetItem>`
  )
  const m = splitItems(xml, 'Message')[0] ?? xml
  const subject = unescape(between(m, 'Subject')[0] ?? '(без темы)')
  const from = unescape(between(m, 'Name')[0] ?? '')
  const received = between(m, 'DateTimeReceived')[0] ?? ''
  const bodyRaw = unescape(between(m, 'Body')[0] ?? '')
  const bodyType = /<t:Body[^>]*BodyType="([^"]+)"/i.exec(m)?.[1] ?? 'Text'
  const isRead = /<t:IsRead[^>]*>true<\/t:IsRead>/i.test(m)
  const toNames = between(m, 'EmailAddress')
  return {
    subject,
    from,
    to: toNames.map(unescape).join(', '),
    cc: '',
    date: received ? Date.parse(received) : Date.now(),
    text: bodyType === 'HTML' ? stripHtml(bodyRaw) : bodyRaw,
    html: bodyType === 'HTML' ? bodyRaw : null,
    unread: !isRead
  }
}

/** Отправка письма через EWS CreateItem + SendAndSaveCopy. */
export async function sendEwsMail(
  ctx: SyncContext,
  payload: { to: string; cc?: string; subject: string; body: string }
): Promise<void> {
  const toXml = payload.to
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => `<t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox>`)
    .join('')
  const ccXml = (payload.cc ?? '')
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => `<t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox>`)
    .join('')
  await soap(
    ctx,
    `<m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${escapeXml(payload.subject)}</t:Subject>
          <t:Body BodyType="Text">${escapeXml(payload.body)}</t:Body>
          <t:ToRecipients>${toXml}</t:ToRecipients>
          ${ccXml ? `<t:CcRecipients>${ccXml}</t:CcRecipients>` : ''}
        </t:Message>
      </m:Items>
    </m:CreateItem>`
  )
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ROLE_BY_DISTINGUISHED: Record<string, MailMailbox['role']> = {
  inbox: 'inbox',
  sentitems: 'sent',
  drafts: 'drafts'
}

/** Список папок через EWS FindFolder (msgfolderroot). */
export async function listEwsFolders(ctx: SyncContext): Promise<MailMailbox[]> {
  const xml = await soap(
    ctx,
    `<m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:FolderClass"/>
          <t:FieldURI FieldURI="folder:UnreadCount"/>
          <t:FieldURI FieldURI="folder:TotalCount"/>
        </t:AdditionalProperties>
      </m:FolderShape>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
    </m:FindFolder>`
  )
  const folders = splitItems(xml, 'Folder')
  const out: MailMailbox[] = []
  for (const f of folders) {
    const id = attr(f, 'FolderId', 'Id')
    if (!id) continue
    const folderClass = between(f, 'FolderClass')[0] ?? ''
    if (folderClass && !folderClass.startsWith('IPF.Note')) continue
    const name = unescape(between(f, 'DisplayName')[0] ?? '')
    const parentId = attr(f, 'ParentFolderId', 'Id')
    const total = Number(between(f, 'TotalCount')[0] ?? '') || undefined
    const unread = Number(between(f, 'UnreadCount')[0] ?? '') || undefined
    out.push({ id, name, parentId: parentId ?? null, role: null, total, unread })
  }
  // Distinguished aliases — отдельно, чтобы UI мог фильтровать по role.
  for (const [dist, role] of Object.entries(ROLE_BY_DISTINGUISHED)) {
    const hit = out.find((m) => m.name.toLowerCase() === dist || m.role === role)
    if (hit) hit.role = role
  }
  // Fallback: GetFolder по distinguished, если FindFolder не дал role.
  for (const [dist, role] of Object.entries(ROLE_BY_DISTINGUISHED)) {
    if (out.some((m) => m.role === role)) continue
    try {
      const g = await soap(
        ctx,
        `<m:GetFolder>
          <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>
            <t:AdditionalProperties>
              <t:FieldURI FieldURI="folder:DisplayName"/>
            </t:AdditionalProperties>
          </m:FolderShape>
          <m:FolderIds><t:DistinguishedFolderId Id="${dist}"/></m:FolderIds>
        </m:GetFolder>`
      )
      const id = attr(g, 'FolderId', 'Id')
      const name = unescape(between(g, 'DisplayName')[0] ?? dist)
      if (!id) continue
      const existing = out.find((m) => m.id === id)
      if (existing) existing.role = role
      else out.unshift({ id, name, parentId: null, role })
    } catch {
      /* distinguished недоступен */
    }
  }
  return out
}

/** Создать папку в EWS. parentId пустой → msgfolderroot. */
export async function createEwsFolder(
  ctx: SyncContext,
  name: string,
  parentId?: string | null
): Promise<MailMailbox> {
  const parentXml = parentId
    ? `<t:FolderId Id="${escapeXml(parentId)}"/>`
    : `<t:DistinguishedFolderId Id="msgfolderroot"/>`
  const xml = await soap(
    ctx,
    `<m:CreateFolder>
      <m:ParentFolderId>${parentXml}</m:ParentFolderId>
      <m:Folders>
        <t:Folder>
          <t:DisplayName>${escapeXml(name)}</t:DisplayName>
        </t:Folder>
      </m:Folders>
    </m:CreateFolder>`
  )
  const id = attr(xml, 'FolderId', 'Id')
  if (!id) throw new Error('EWS CreateFolder: нет FolderId в ответе')
  return { id, name, parentId: parentId ?? null, role: null }
}

/** Переместить письма (EWS MoveItem). itemIds — сырые EWS ItemId. */
export async function moveEwsItems(
  ctx: SyncContext,
  itemIds: string[],
  folderId: string
): Promise<void> {
  if (!itemIds.length) return
  const idsXml = itemIds
    .map((id) => `<t:ItemId Id="${escapeXml(id)}"/>`)
    .join('')
  const dest =
    folderId === 'inbox' || folderId === 'sent' || folderId === 'drafts'
      ? `<t:DistinguishedFolderId Id="${folderId === 'sent' ? 'sentitems' : folderId}"/>`
      : `<t:FolderId Id="${escapeXml(folderId)}"/>`
  await soap(
    ctx,
    `<m:MoveItem>
      <m:ToFolderId>${dest}</m:ToFolderId>
      <m:ItemIds>${idsXml}</m:ItemIds>
    </m:MoveItem>`
  )
}

function firstContains(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<t:${tag}[^>]*>[\\s\\S]*?<t:String>([\\s\\S]*?)</t:String>`, 'i').exec(xml)
  return m ? unescape(m[1]).trim() || undefined : undefined
}

function parseEwsRule(block: string): MailRule | null {
  const id = between(block, 'RuleId')[0]?.trim()
  if (!id) return null
  const name = unescape(between(block, 'DisplayName')[0] ?? 'Правило')
  const enabled = /<t:IsEnabled[^>]*>true<\/t:IsEnabled>/i.test(block)
  const conditions = {
    fromContains: firstContains(block, 'ContainsSenderStrings'),
    toContains: firstContains(block, 'ContainsRecipientStrings'),
    subjectContains: firstContains(block, 'ContainsSubjectStrings')
  }
  const moveMatch = /<t:MoveToFolder>[\s\S]*?<t:FolderId[^>]*\bId="([^"]+)"/i.exec(block)
  const markRead = /<t:MarkAsRead\s*\/>/i.test(block) || /<t:MarkAsRead>true<\/t:MarkAsRead>/i.test(block)
  const markImportant =
    /<t:MarkImportance>High<\/t:MarkImportance>/i.test(block) ||
    /<t:Importance>High<\/t:Importance>/i.test(block)
  return {
    id,
    name,
    enabled,
    conditions,
    actions: {
      moveToFolder: moveMatch?.[1],
      markRead: markRead || undefined,
      markImportant: markImportant || undefined
    }
  }
}

/** Inbox rules через EWS GetInboxRules. */
export async function listEwsRules(ctx: SyncContext): Promise<MailRule[]> {
  const email = ctx.service.options.email || ctx.service.auth.username || ''
  const mailbox = email
    ? `<m:MailboxSmtpAddress>${escapeXml(email)}</m:MailboxSmtpAddress>`
    : ''
  const xml = await soap(ctx, `<m:GetInboxRules>${mailbox}</m:GetInboxRules>`)
  const re = /<t:Rule(?:\s[^>]*)?>([\s\S]*?)<\/t:Rule>/gi
  const out: MailRule[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const rule = parseEwsRule(m[1])
    if (rule) out.push(rule)
  }
  return out
}

function ruleConditionsXml(c: MailRuleUpsert['conditions']): string {
  const parts: string[] = []
  if (c.fromContains?.trim()) {
    parts.push(
      `<t:ContainsSenderStrings><t:String>${escapeXml(c.fromContains.trim())}</t:String></t:ContainsSenderStrings>`
    )
  }
  if (c.toContains?.trim()) {
    parts.push(
      `<t:ContainsRecipientStrings><t:String>${escapeXml(c.toContains.trim())}</t:String></t:ContainsRecipientStrings>`
    )
  }
  if (c.subjectContains?.trim()) {
    parts.push(
      `<t:ContainsSubjectStrings><t:String>${escapeXml(c.subjectContains.trim())}</t:String></t:ContainsSubjectStrings>`
    )
  }
  return parts.length ? `<t:Conditions>${parts.join('')}</t:Conditions>` : '<t:Conditions/>'
}

function ruleActionsXml(a: MailRuleUpsert['actions']): string {
  const parts: string[] = []
  if (a.moveToFolder?.trim()) {
    parts.push(
      `<t:MoveToFolder><t:FolderId Id="${escapeXml(a.moveToFolder.trim())}"/></t:MoveToFolder>`
    )
  }
  if (a.markRead) parts.push('<t:MarkAsRead/>')
  if (a.markImportant) parts.push('<t:MarkImportance>High</t:MarkImportance>')
  if (!parts.length) throw new Error('Укажите хотя бы одно действие правила')
  return `<t:Actions>${parts.join('')}</t:Actions>`
}

function ruleBodyXml(payload: MailRuleUpsert, priority = 1): string {
  return `<t:DisplayName>${escapeXml(payload.name)}</t:DisplayName>
        <t:Priority>${priority}</t:Priority>
        <t:IsEnabled>${payload.enabled === false ? 'false' : 'true'}</t:IsEnabled>
        ${ruleConditionsXml(payload.conditions)}
        ${ruleActionsXml(payload.actions)}`
}

/** Создать или обновить inbox-правило. */
export async function upsertEwsRule(ctx: SyncContext, payload: MailRuleUpsert): Promise<MailRule> {
  if (!payload.name.trim()) throw new Error('Укажите название правила')
  const op = payload.id
    ? `<t:SetRuleOperation>
        <t:Rule>
          <t:RuleId>${escapeXml(payload.id)}</t:RuleId>
          ${ruleBodyXml(payload)}
        </t:Rule>
      </t:SetRuleOperation>`
    : `<t:CreateRuleOperation>
        <t:Rule>
          ${ruleBodyXml(payload)}
        </t:Rule>
      </t:CreateRuleOperation>`
  await soap(
    ctx,
    `<m:UpdateInboxRules>
      <m:RemoveOutlookRuleBlob>true</m:RemoveOutlookRuleBlob>
      <m:Operations>${op}</m:Operations>
    </m:UpdateInboxRules>`
  )
  // Список после записи — best-effort: создание уже прошло, обрыв сокета
  // на GetInboxRules не должен откатывать успех в UI.
  try {
    const rules = await listEwsRules(ctx)
    if (payload.id) {
      const hit = rules.find((r) => r.id === payload.id)
      if (hit) return hit
    }
    const byName = rules.filter((r) => r.name === payload.name)
    if (byName.length) return byName[byName.length - 1]!
  } catch (err) {
    logWarn('mail', `GetInboxRules после upsert: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    id: payload.id ?? 'unknown',
    name: payload.name,
    enabled: payload.enabled !== false,
    conditions: payload.conditions,
    actions: payload.actions
  }
}

export async function deleteEwsRule(ctx: SyncContext, ruleId: string): Promise<void> {
  await soap(
    ctx,
    `<m:UpdateInboxRules>
      <m:RemoveOutlookRuleBlob>true</m:RemoveOutlookRuleBlob>
      <m:Operations>
        <t:DeleteRuleOperation>
          <t:RuleId>${escapeXml(ruleId)}</t:RuleId>
        </t:DeleteRuleOperation>
      </m:Operations>
    </m:UpdateInboxRules>`
  )
}

export async function setEwsRuleEnabled(
  ctx: SyncContext,
  ruleId: string,
  enabled: boolean
): Promise<MailRule> {
  const rules = await listEwsRules(ctx)
  const existing = rules.find((r) => r.id === ruleId)
  if (!existing) throw new Error('Правило не найдено')
  return upsertEwsRule(ctx, {
    id: ruleId,
    name: existing.name,
    enabled,
    conditions: existing.conditions,
    actions: existing.actions
  })
}

/** То же окно, что просит CalendarView: по нему же чистится локальная копия. */
function ewsCalendarWindow(now = Date.now()): { from: number; to: number } {
  return { from: now, to: now + 30 * 86400_000 }
}

/** Потолок CalendarView. Упёрлись в него — выдача обрезана, чистить нельзя. */
const EWS_CALENDAR_LIMIT = 100

async function fetchCalendar(
  ctx: SyncContext,
  win: { from: number; to: number }
): Promise<{ items: Item[]; complete: boolean }> {
  // События на ближайшие 30 дней через CalendarView — он сам разворачивает серии.
  const now = new Date(win.from)
  const end = new Date(win.to)
  const xml = await soap(
    ctx,
    `<m:FindItem Traversal="Shallow">
      <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView MaxEntriesReturned="${EWS_CALENDAR_LIMIT}" StartDate="${now.toISOString()}" EndDate="${end.toISOString()}"/>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>
    </m:FindItem>`
  )

  const raw = splitItems(xml, 'CalendarItem')
  const items = raw
    .map((c) => {
      const id = attr(c, 'ItemId', 'Id')
      if (!id) return null
      const subject = unescape(between(c, 'Subject')[0] ?? '').trim()
      const start = between(c, 'Start')[0] ?? ''
      const endAt = between(c, 'End')[0] ?? ''
      const loc = unescape(between(c, 'Location')[0] ?? '')
      const startMs = start ? Date.parse(start) : NaN
      if (Number.isNaN(startMs)) return null
      const title =
        subject ||
        loc ||
        `${String(new Date(startMs).getHours()).padStart(2, '0')}:${String(new Date(startMs).getMinutes()).padStart(2, '0')}`
      return {
        id: itemId(ctx.service, `event:${id}`),
        envId: ctx.service.envId,
        serviceId: ctx.service.id,
        kind: 'event' as const,
        title,
        body: loc ? stripHtml(loc) : '',
        author: null,
        state: 'встреча',
        url: base(ctx.service.baseUrl),
        updatedAt: startMs,
        unread: false,
        mentioned: false,
        startsAt: startMs,
        endsAt: endAt ? Date.parse(endAt) : null
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
  return { items, complete: raw.length < EWS_CALENDAR_LIMIT }
}

/**
 * Единый почтовый коннектор: выбирает протокол по настройке сервиса. Exchange
 * (EWS) даёт и почту, и календарь; JMAP пока — почту. Так один «mail»-сервис
 * обслуживает и банк (Exchange), и ecom (JMAP).
 */
export const mailConnector: Connector = {
  kind: 'mail',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    if (!ctx.service.baseUrl && !ctx.service.options.jmapUrl) {
      throw new Error('Не задан адрес почты')
    }
    const protocol =
      ctx.service.options.protocol || (ctx.service.options.jmapUrl ? 'jmap' : 'exchange')

    // EAS — один источник; ошибку не глотаем, иначе диагностика врёт «0 записей».
    if (protocol === 'eas') return syncEas(ctx)

    if (protocol === 'jmap' || protocol === 'imap') {
      // Почта и календарь ecom на разных хостах: письма по JMAP/IMAP, события —
      // по CalDAV, если его адрес задан. Сбой одного не рушит другой, но пишется в лог.
      const mail =
        protocol === 'jmap'
          ? await trySource(ctx, 'jmap', () => syncJmap(ctx))
          : await trySource(ctx, 'imap', () => syncImap(ctx))
      const events = ctx.service.options.caldavUrl
        ? await trySource(ctx, 'caldav', () => syncCaldav(ctx))
        : null
      // Отчёт CalDAV отдаёт диапазон целиком — значит встречи, которых в нём
      // нет, на сервере уже не существуют и из локальной копии их пора убрать.
      const prune: PruneWindow[] = events?.ok ? [{ kind: 'event', ...caldavWindow() }] : []
      return { items: [...mail.items, ...(events?.items ?? [])], cursor: String(Date.now()), prune }
    }

    // Exchange: почта и календарь с одного сервера; сбой одного не рушит другой.
    const win = ewsCalendarWindow()
    const [mail, events] = await Promise.all([
      trySource(ctx, 'ews-mail', () => fetchMail(ctx)),
      fetchCalendar(ctx, win).catch((err: unknown) => {
        logError(
          'mail',
          `${ctx.service.id}/ews-calendar: ${err instanceof Error ? err.message : String(err)}`
        )
        return { items: [] as Item[], complete: false }
      })
    ])
    logInfo('mail', `${ctx.service.id}/ews-calendar: получено ${events.items.length}`)
    // Упёрлись в потолок CalendarView — выдача обрезана, чистить по ней нельзя.
    const prune: PruneWindow[] = events.complete ? [{ kind: 'event', ...win }] : []
    return { items: [...mail.items, ...events.items], cursor: String(Date.now()), prune }
  }
}
