import type { Item, ServiceConfig } from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { base, getJson, getText, postJson } from '../connectors/http'
import {
  MattermostClient,
  type MmChannel,
  type MmChannelMember,
  type MmTeam,
  type MmUser
} from '../connectors/mattermost/client'
import { searchItems, queryItems } from '../db'
import { dispatcherFor } from '../net/transport'
import type { SyncContext } from '../connectors/types'
import { createMeeting } from '../calendar'
import {
  createMailFolder,
  deleteMailRule,
  getMail,
  listMailFolders,
  listMailRules,
  moveMail,
  setMailRuleEnabled,
  upsertMailRule
} from '../mail'
import type { MailRuleUpsert } from '@shared/types'
import { emitItemsChanged } from '../notify/itemsChanged'
import * as notes from '../notes/vault'
import { createTodo, isTodoDone, listTodos, removeTodo, todoRemindAt, updateTodo } from '../todos'

/**
 * Действия ассистента над подключёнными сервисами. Это та же логика, что и у
 * коннекторов (контур, авторизация, транспорт), но для точечных операций,
 * которые вызывает AI: найти, создать задачу, прокомментировать, написать страницу.
 *
 * Всё идёт через контур нужного сервиса — ассистент не обходит ни туннель,
 * ни авторизацию.
 */

function ctxFor(serviceKind: string, envId?: string): SyncContext {
  const cfg = getConfig()
  const service = cfg.services.find(
    (s) => s.kind === serviceKind && s.enabled && (!envId || s.envId === envId)
  )
  if (!service) throw new Error(`Нет подключённого сервиса ${serviceKind}${envId ? ` в контуре ${envId}` : ''}`)
  const env = cfg.envs.find((e) => e.id === service.envId)
  if (!env) throw new Error('Контур не найден')
  return { env, service, secret: getSecret(`${service.id}.secret`), cursor: null }
}

export function listServices(): { id: string; kind: string; env: string; name: string; enabled: boolean }[] {
  return getConfig().services.map((s) => ({
    id: s.id,
    kind: s.kind,
    env: s.envId,
    name: s.name,
    enabled: s.enabled
  }))
}

/** Сквозной поиск по всему, что уже синхронизировано (задачи, письма, переписка). */
export function searchEverything(query: string): unknown[] {
  return searchItems(query, 50).map((i) => ({
    id: i.id,
    kind: i.kind,
    env: i.envId,
    title: i.title,
    state: i.state,
    url: i.url,
    /** Превью из локального кэша; полное тело письма — через mail_read(id). */
    preview: i.kind === 'mail' ? (i.body || '').slice(0, 280) : undefined
  }))
}

/** «Мой день»: что требует внимания. */
export function myDay(): unknown[] {
  return queryItems({ limit: 100 }).map((i) => ({
    id: i.id,
    kind: i.kind,
    env: i.envId,
    title: i.title,
    state: i.state,
    url: i.url,
    preview: i.kind === 'mail' ? (i.body || '').slice(0, 280) : undefined
  }))
}

/** Список писем из локальной БД (после синка). id нужен для mail_read. */
export function mailList(opts?: {
  unreadOnly?: boolean
  limit?: number
  envId?: string
}): unknown[] {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100)
  let items = queryItems({ kinds: ['mail'], limit: 200 })
  if (opts?.envId) items = items.filter((i) => i.envId === opts.envId)
  if (opts?.unreadOnly) items = items.filter((i) => i.unread)
  items.sort((a, b) => b.updatedAt - a.updatedAt)
  return items.slice(0, limit).map((i) => ({
    id: i.id,
    env: i.envId,
    serviceId: i.serviceId,
    subject: i.title,
    from: i.author,
    unread: i.unread,
    folder: i.folder ?? 'inbox',
    date: i.updatedAt,
    preview: (i.body || '').slice(0, 400)
  }))
}

/**
 * Прочитать письмо целиком (тело с сервера через getMail).
 * HTML урезаем — агенту обычно хватает text.
 */
export async function mailRead(id: string): Promise<unknown> {
  if (!id.includes(':mail:')) throw new Error('Ожидается id письма вида env:service:mail:…')
  const d = await getMail(id)
  const maxText = 60_000
  const text =
    d.bodyText.length > maxText
      ? `${d.bodyText.slice(0, maxText)}\n\n…[обрезано, было ${d.bodyText.length} символов]`
      : d.bodyText
  return {
    id: d.id,
    serviceId: d.serviceId,
    subject: d.subject,
    from: d.from,
    to: d.to,
    cc: d.cc || undefined,
    date: d.date,
    unread: d.unread,
    bodyText: text,
    hasHtml: Boolean(d.bodyHtml)
  }
}

/** Список папок почты (live с сервера). */
export async function mailListFolders(envId?: string): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  return listMailFolders({ serviceId: ctx.service.id, envId })
}

export async function mailCreateFolder(
  name: string,
  parentId?: string,
  envId?: string
): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  return createMailFolder({ serviceId: ctx.service.id, name, parentId })
}

export async function mailMove(
  ids: string[],
  folderId: string,
  _envId?: string
): Promise<unknown> {
  if (!ids.length) throw new Error('Укажите ids писем (из mail_list / mail_read)')
  await moveMail({ itemIds: ids, folderId })
  return { moved: ids.length, folderId }
}

export async function mailListRules(envId?: string): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  return listMailRules({ serviceId: ctx.service.id, envId })
}

export async function mailUpsertRule(
  rule: MailRuleUpsert,
  envId?: string
): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  return upsertMailRule({ serviceId: ctx.service.id, envId, rule })
}

export async function mailDeleteRule(ruleId: string, envId?: string): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  await deleteMailRule({ serviceId: ctx.service.id, envId, ruleId })
  return { deleted: ruleId }
}

export async function mailSetRuleEnabled(
  ruleId: string,
  enabled: boolean,
  envId?: string
): Promise<unknown> {
  const ctx = ctxFor('mail', envId)
  return setMailRuleEnabled({ serviceId: ctx.service.id, envId, ruleId, enabled })
}

/* ── Jira ────────────────────────────────────────────────────────── */

export async function jiraSearch(jql: string, envId?: string): Promise<unknown> {
  const ctx = ctxFor('jira', envId)
  const root = base(ctx.service.baseUrl)
  return getJson(ctx, `${root}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=30&fields=summary,status,assignee`)
}

export async function jiraCreateIssue(
  projectKey: string,
  summary: string,
  description: string,
  issueType = 'Task',
  envId?: string,
  parentKey?: string
): Promise<{ key?: string }> {
  const ctx = ctxFor('jira', envId)
  const root = base(ctx.service.baseUrl)
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    summary,
    description,
    issuetype: { name: issueType }
  }
  if (parentKey?.trim()) fields.parent = { key: parentKey.trim() }
  const res = await postJson<{ key?: string }>(ctx, `${root}/rest/api/2/issue`, { fields })
  return { key: res.key }
}

export async function jiraComment(issueKey: string, body: string, envId?: string): Promise<unknown> {
  const ctx = ctxFor('jira', envId)
  const root = base(ctx.service.baseUrl)
  return postJson(ctx, `${root}/rest/api/2/issue/${issueKey}/comment`, { body })
}

/* ── Confluence ──────────────────────────────────────────────────── */

export async function confluenceSearch(cql: string, envId?: string): Promise<unknown> {
  const ctx = ctxFor('confluence', envId)
  const root = base(ctx.service.baseUrl)
  return getJson(ctx, `${root}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=20`)
}

export async function confluenceCreatePage(
  spaceKey: string,
  title: string,
  htmlBody: string,
  envId?: string
): Promise<{ id?: string }> {
  const ctx = ctxFor('confluence', envId)
  const root = base(ctx.service.baseUrl)
  const res = await postJson<{ id?: string }>(ctx, `${root}/rest/api/content`, {
    type: 'page',
    title,
    space: { key: spaceKey },
    body: { storage: { value: htmlBody, representation: 'storage' } }
  })
  return { id: res.id }
}

/* ── GitLab ──────────────────────────────────────────────────────── */

export async function gitlabReviews(envId?: string): Promise<unknown> {
  const ctx = ctxFor('gitlab', envId)
  const root = base(ctx.service.baseUrl)
  return getJson(ctx, `${root}/api/v4/merge_requests?scope=all&reviewer_username=me&state=opened&per_page=30`)
}

export async function gitlabApproveMr(projectId: number, mrIid: number, envId?: string): Promise<unknown> {
  const ctx = ctxFor('gitlab', envId)
  const root = base(ctx.service.baseUrl)
  return postJson(ctx, `${root}/api/v4/projects/${projectId}/merge_requests/${mrIid}/approve`, {})
}

export async function gitlabCommentMr(
  projectId: number,
  mrIid: number,
  body: string,
  envId?: string
): Promise<unknown> {
  const ctx = ctxFor('gitlab', envId)
  const root = base(ctx.service.baseUrl)
  return postJson(ctx, `${root}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`, { body })
}

/* ── Bitbucket ───────────────────────────────────────────────────── */

/**
 * Bitbucket Server / Data Center, REST 1.0.
 *
 * Адрес пул-реквеста всюду один и тот же — ключ проекта, слаг репозитория и
 * номер. Агент обычно берёт их из ссылки вида
 * `…/projects/ABC/repos/payments/pull-requests/42`, поэтому принимаем ровно
 * эти три значения, а не внутренние id.
 */
function bbPr(envId: string | undefined, project: string, repo: string, prId: number): {
  ctx: SyncContext
  url: string
} {
  const ctx = ctxFor('bitbucket', envId)
  const root = base(ctx.service.baseUrl)
  const p = encodeURIComponent(project.trim())
  const r = encodeURIComponent(repo.trim())
  return { ctx, url: `${root}/rest/api/1.0/projects/${p}/repos/${r}/pull-requests/${prId}` }
}

/** Пул-реквесты, ждущие моего ревью (дашборд по всем репозиториям сразу). */
export async function bitbucketReviews(envId?: string): Promise<unknown> {
  const ctx = ctxFor('bitbucket', envId)
  const root = base(ctx.service.baseUrl)
  return getJson(
    ctx,
    `${root}/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=REVIEWER&limit=50&avatarSize=0`
  )
}

/** Пул-реквесты конкретного репозитория. */
export async function bitbucketListPrs(
  project: string,
  repo: string,
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'ALL' = 'OPEN',
  envId?: string
): Promise<unknown> {
  const ctx = ctxFor('bitbucket', envId)
  const root = base(ctx.service.baseUrl)
  const p = encodeURIComponent(project.trim())
  const r = encodeURIComponent(repo.trim())
  return getJson(
    ctx,
    `${root}/rest/api/1.0/projects/${p}/repos/${r}/pull-requests?state=${state}&limit=50&avatarSize=0`
  )
}

/** Карточка пул-реквеста: описание, ветки, ревьюеры и их статусы. */
export async function bitbucketGetPr(
  project: string,
  repo: string,
  prId: number,
  envId?: string
): Promise<unknown> {
  const { ctx, url } = bbPr(envId, project, repo, prId)
  return getJson(ctx, url)
}

/**
 * Diff пул-реквеста в обычном unified-формате.
 *
 * Берём `.diff`, а не JSON-дерево хунков: текстовый патч агент читает как
 * есть, а из JSON его пришлось бы собирать обратно. Ответ подрезаем — целиком
 * крупный PR в контекст всё равно не влезет, а обрыв лучше делать честно.
 */
export async function bitbucketPrDiff(
  project: string,
  repo: string,
  prId: number,
  contextLines = 3,
  envId?: string
): Promise<{ diff: string; truncated: boolean }> {
  const { ctx, url } = bbPr(envId, project, repo, prId)
  const raw = await getText(ctx, `${url}.diff?contextLines=${contextLines}`)
  const LIMIT = 200_000
  return { diff: raw.slice(0, LIMIT), truncated: raw.length > LIMIT }
}

/** Лента активности пул-реквеста: комментарии, апрувы, пуши. */
export async function bitbucketPrActivity(
  project: string,
  repo: string,
  prId: number,
  envId?: string
): Promise<unknown> {
  const { ctx, url } = bbPr(envId, project, repo, prId)
  return getJson(ctx, `${url}/activities?limit=100&avatarSize=0`)
}

/**
 * Комментарий к пул-реквесту. С `path` и `line` — привязанный к строке диффа
 * (как в веб-интерфейсе), без них — общий к обсуждению.
 *
 * `lineType` ADDED — строка из новой версии (по умолчанию), REMOVED — из
 * старой, CONTEXT — неизменённая.
 */
export async function bitbucketCommentPr(
  project: string,
  repo: string,
  prId: number,
  text: string,
  anchor?: { path: string; line?: number; lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT' },
  envId?: string
): Promise<unknown> {
  const { ctx, url } = bbPr(envId, project, repo, prId)
  const body: Record<string, unknown> = { text }
  if (anchor?.path) {
    const lineType = anchor.lineType ?? 'ADDED'
    body.anchor = {
      path: anchor.path,
      // fileType TO — файл после изменений; для удалённой строки смотрим FROM.
      fileType: lineType === 'REMOVED' ? 'FROM' : 'TO',
      ...(anchor.line != null ? { line: anchor.line, lineType } : {})
    }
  }
  return postJson(ctx, `${url}/comments`, body)
}

/**
 * Статус ревью. APPROVED — апрув; NEEDS_WORK и UNAPPROVED снимают его.
 *
 * Апрув ставится отдельной ручкой, а остальные статусы — через участника PR,
 * и для них нужен слаг пользователя: берём логин, указанный в настройках
 * сервиса, своего «кто я» REST 1.0 не отдаёт.
 */
export async function bitbucketReviewPr(
  project: string,
  repo: string,
  prId: number,
  status: 'APPROVED' | 'UNAPPROVED' | 'NEEDS_WORK' = 'APPROVED',
  envId?: string
): Promise<unknown> {
  const { ctx, url } = bbPr(envId, project, repo, prId)
  if (status === 'APPROVED') return postJson(ctx, `${url}/approve`, {})

  const slug = ctx.service.auth.username?.trim()
  if (!slug) {
    throw new Error(
      `Чтобы снять апрув, укажите логин Bitbucket в настройках сервиса «${ctx.service.name}»`
    )
  }
  return postJson(ctx, `${url}/participants/${encodeURIComponent(slug)}`, { status }, 'PUT')
}

/** Поиск по коду (Bitbucket Search API). */
export async function bitbucketSearchCode(query: string, envId?: string): Promise<unknown> {
  const ctx = ctxFor('bitbucket', envId)
  const root = base(ctx.service.baseUrl)
  return postJson(ctx, `${root}/rest/search/latest/search`, {
    query,
    entities: { code: {} },
    limits: { primary: 25, secondary: 10 }
  })
}

/* ── Mattermost ──────────────────────────────────────────────────── */

function mmClient(envId?: string): { api: MattermostClient; baseUrl: string } {
  const ctx = ctxFor('mattermost', envId)
  if (!ctx.service.baseUrl) throw new Error('Не задан адрес Mattermost')
  if (!ctx.secret) throw new Error('Не задан токен Mattermost')
  return {
    api: new MattermostClient(ctx.service.baseUrl, ctx.secret, dispatcherFor(ctx.env)),
    baseUrl: ctx.service.baseUrl.replace(/\/+$/, '')
  }
}

const mmDisplay = (u: MmUser | undefined): string =>
  u ? (u.nickname || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username) : 'кто-то'

/** Id Mattermost — 26 символов [a-z0-9]. */
const MM_ID = /^[a-z0-9]{26}$/

function channelLabel(ch: MmChannel, meId: string, users: Map<string, MmUser>): string {
  if (ch.type !== 'D') return ch.display_name || ch.name
  const other = ch.name.split('__').find((id) => id !== meId)
  return other ? `@${users.get(other)?.username ?? 'личные'}` : 'личные сообщения'
}

/** channelId / имя / URL канала или permalink поста → id канала. */
async function resolveChannelId(api: MattermostClient, channel: string, teams: MmTeam[]): Promise<string> {
  const raw = channel.trim()
  if (MM_ID.test(raw)) return raw

  // …/pl/<postId> — permalink
  const pl = raw.match(/\/pl\/([a-z0-9]{26})(?:\b|$)/i)
  if (pl) {
    const post = await api.post(pl[1])
    return post.channel_id
  }

  // …/channels/<name> или просто name / @user
  const fromUrl = raw.match(/\/channels\/([^/?#]+)/i)
  const name = decodeURIComponent((fromUrl?.[1] ?? raw).replace(/^@/, '')).toLowerCase()

  for (const team of teams) {
    try {
      const ch = await api.channelByName(team.id, name)
      return ch.id
    } catch {
      /* DM/GM channelByName часто не отдаёт — ниже сканируем myChannels */
    }
  }

  // Fallback: display_name / name среди каналов всех команд (в т.ч. DM).
  for (const team of teams) {
    const channels = await api.myChannels(team.id)
    const hit = channels.find(
      (ch) =>
        ch.name.toLowerCase() === name ||
        ch.display_name.toLowerCase() === name ||
        ch.display_name.toLowerCase() === `@${name}`
    )
    if (hit) return hit.id
  }
  throw new Error(`Канал не найден: ${channel}`)
}

export async function mattermostPost(channelId: string, message: string, envId?: string): Promise<unknown> {
  // cookie-auth: postJson не кладёт Bearer — пишем через MattermostClient, как read/banner.
  const { api } = mmClient(envId)
  const teams = await api.myTeams()
  const resolved = await resolveChannelId(api, channelId, teams)
  const post = await api.createPost(resolved, message)
  const team = teams[0]?.name ?? 'team'
  return { id: post.id, channelId: post.channel_id, url: api.permalink(team, post.id) }
}

/**
 * Обновить шапку канала (header). channel — id, имя или URL.
 * Markdown ок, «цветных» плашек Mattermost в header не даёт.
 */
export async function mattermostSetHeader(
  channel: string,
  header: string,
  envId?: string
): Promise<unknown> {
  const { api } = mmClient(envId)
  const teams = await api.myTeams()
  const channelId = await resolveChannelId(api, channel, teams)
  const updated = await api.patchChannel(channelId, { header })
  return {
    channelId: updated.id,
    name: updated.name,
    displayName: updated.display_name,
    header: updated.header ?? header
  }
}

/** Цвет фона баннера: сервер принимает только `#rgb` / `#rrggbb`. */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
/** Ограничение сервера на длину текста баннера (ChannelBannerInfoMaxLength). */
const BANNER_MAX = 1024

/** Что за сборка Mattermost и на что она лицензирована. */
export async function mattermostLicense(envId?: string): Promise<unknown> {
  const { api, baseUrl } = mmClient(envId)
  const lic = await api.clientLicense()
  const sku = lic.SkuShortName ?? null
  const licensed = lic.IsLicensed === 'true'
  // Баннеры каналов — с 10.9 и только на платных планах Entry / Enterprise Advanced.
  const banners = licensed && ['entry', 'enterpriseadvanced'].includes((sku ?? '').toLowerCase())
  return {
    server: baseUrl,
    licensed,
    sku,
    skuName: lic.SkuName ?? null,
    cloud: lic.Cloud === 'true',
    channelBanners: banners
      ? 'доступны'
      : licensed
        ? `плана «${lic.SkuName ?? sku}» для баннеров каналов не хватает — нужен Entry или Enterprise Advanced`
        : 'сервер без лицензии: баннеры каналов недоступны'
  }
}

/**
 * Поставить или снять плашку вверху канала (Channel Banner).
 *
 * Это не заголовок канала: баннер нельзя скрыть, он виден всем участникам во
 * всех клиентах. Нужны права админа канала и платная лицензия сервера.
 */
export async function mattermostSetBanner(input: {
  channel: string
  text?: string
  color?: string
  enabled?: boolean
  envId?: string
}): Promise<unknown> {
  const enabled = input.enabled !== false
  const text = input.text?.trim() ?? ''
  const color = input.color?.trim() ?? ''

  // Проверяем до похода за каналом: сервер на эти же случаи отвечает 400 без
  // объяснения, а агенту нужно понять, что чинить.
  if (enabled) {
    if (!text) throw new Error('Для включённого баннера нужен текст')
    if (Buffer.byteLength(text, 'utf8') > BANNER_MAX) {
      throw new Error(`Текст баннера длиннее ${BANNER_MAX} байт (кириллица — два байта на символ)`)
    }
    if (!color) throw new Error('Укажите цвет фона в hex, напр. #90c695')
    if (!HEX_COLOR.test(color)) {
      throw new Error(`Цвет «${color}» не подходит: нужен hex вида #90c695 или #9c6`)
    }
  }

  const { api } = mmClient(input.envId)
  const teams = await api.myTeams()
  const channelId = await resolveChannelId(api, input.channel, teams)
  const channel = await api.channel(channelId)
  if (channel.type !== 'O' && channel.type !== 'P') {
    throw new Error('Баннер можно поставить только в публичном или приватном канале')
  }

  try {
    const updated = await api.patchChannel(channelId, {
      // Выключая, текст и цвет не стираем: сервер их помнит, и включить
      // обратно можно одним флагом.
      banner_info: enabled ? { enabled: true, text, background_color: color } : { enabled: false }
    })
    return {
      channelId: updated.id,
      name: updated.name,
      displayName: updated.display_name,
      banner: updated.banner_info ?? { enabled }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 400/403 здесь почти всегда означают «нет лицензии» или «не админ канала».
    if (/\b(400|403|501)\b/.test(msg)) {
      const lic = (await mattermostLicense(input.envId).catch(() => null)) as {
        channelBanners?: string
      } | null
      throw new Error(
        `${msg}. Баннеры каналов: ${lic?.channelBanners ?? 'статус лицензии не удалось получить'}. ` +
          'Ещё нужны права админа канала или разрешение «Manage Channel Banners».'
      )
    }
    throw e
  }
}

/** Каналы с непрочитанным (живые счётчики с API). */
export async function mattermostUnread(envId?: string): Promise<unknown> {
  const { api, baseUrl } = mmClient(envId)
  const me = await api.me()
  const teams = await api.myTeams()
  const out: {
    channelId: string
    name: string
    displayName: string
    type: string
    unread: number
    mentions: number
    url: string
    lastPostAt: string | null
  }[] = []

  for (const team of teams) {
    const [channels, members] = await Promise.all([api.myChannels(team.id), api.myChannelMembers(team.id)])
    const memberBy = new Map<string, MmChannelMember>(members.map((m) => [m.channel_id, m]))
    const dmIds = new Set<string>()
    for (const ch of channels) {
      if (ch.type === 'D') ch.name.split('__').forEach((id) => dmIds.add(id))
    }
    const users = new Map<string, MmUser>(
      (await api.usersByIds([...dmIds])).map((u) => [u.id, u])
    )

    for (const ch of channels) {
      const m = memberBy.get(ch.id)
      if (!m) continue
      const unread = Math.max(0, ch.total_msg_count - m.msg_count)
      if (unread === 0 && m.mention_count === 0) continue
      out.push({
        channelId: ch.id,
        name: ch.name,
        displayName: channelLabel(ch, me.id, users),
        type: ch.type,
        unread,
        mentions: m.mention_count,
        url: `${baseUrl}/${team.name}/channels/${ch.name}`,
        lastPostAt: ch.last_post_at ? new Date(ch.last_post_at).toISOString() : null
      })
    }
  }

  out.sort((a, b) => b.unread - a.unread || b.mentions - a.mentions)
  return { totalChannels: out.length, channels: out.slice(0, 50) }
}

/** Прочитать последние сообщения канала (id, имя или URL). */
export async function mattermostRead(
  channel: string,
  limit = 30,
  envId?: string
): Promise<unknown> {
  const { api, baseUrl } = mmClient(envId)
  const me = await api.me()
  const teams = await api.myTeams()
  const channelId = await resolveChannelId(api, channel, teams)
  const ch = await api.channel(channelId)
  const team = teams.find((t) => t.id === ch.team_id) ?? teams[0]
  const perPage = Math.min(Math.max(limit, 1), 60)
  const list = await api.posts(channelId, { page: 0, perPage })

  const posts = list.order
    .map((id) => list.posts[id])
    .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p.type)
    .slice(0, perPage)

  const userIds = new Set(posts.map((p) => p.user_id))
  if (ch.type === 'D') ch.name.split('__').forEach((id) => userIds.add(id))
  const users = new Map<string, MmUser>((await api.usersByIds([...userIds])).map((u) => [u.id, u]))

  return {
    channelId: ch.id,
    name: ch.name,
    displayName: channelLabel(ch, me.id, users),
    type: ch.type,
    url: team ? `${baseUrl}/${team.name}/channels/${ch.name}` : baseUrl,
    messages: posts.map((p) => ({
      id: p.id,
      author: users.get(p.user_id)?.username ?? p.user_id,
      authorName: mmDisplay(users.get(p.user_id)),
      message: p.message,
      createdAt: new Date(p.create_at).toISOString(),
      threadRootId: p.root_id || null,
      url: team ? api.permalink(team.name, p.id) : null
    }))
  }
}

/* ── Календарь (EAS) ─────────────────────────────────────────────── */

function parseIso(s: string, label: string): number {
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`${label}: нужен ISO-8601, напр. 2026-10-05T15:00:00+03:00`)
  return t
}

/**
 * Создать встречу в Exchange-календаре (EAS Sync Add).
 * startsAt/endsAt — ISO-8601. attendees — email через запятую.
 */
export async function calendarCreateMeeting(input: {
  subject: string
  startsAt: string
  endsAt: string
  location?: string
  body?: string
  attendees?: string
  allDay?: boolean
  envId?: string
}): Promise<unknown> {
  const cfg = getConfig()
  const service = cfg.services.find(
    (s) =>
      (s.kind === 'mail' || s.kind === 'calendar') &&
      s.enabled &&
      (!input.envId || s.envId === input.envId)
  )
  if (!service) {
    throw new Error(
      `Нет подключённого календаря (почта/EAS)${input.envId ? ` в контуре ${input.envId}` : ''}`
    )
  }

  const startsAt = parseIso(input.startsAt, 'startsAt')
  const endsAt = parseIso(input.endsAt, 'endsAt')
  const item = await createMeeting({
    serviceId: service.id,
    subject: input.subject,
    startsAt,
    endsAt,
    location: input.location,
    body: input.body,
    attendees: input.attendees,
    allDay: input.allDay
  })
  emitItemsChanged()
  return {
    id: item.id,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    state: item.state,
    location: input.location ?? null,
    attendees: input.attendees ?? null,
    env: service.envId,
    serviceId: service.id
  }
}

/* ── Заметки (vault) ─────────────────────────────────────────────── */

/** Поиск по хранилищу заметок. */
export async function notesSearch(query: string, limit = 20): Promise<unknown> {
  await notes.ensureVault()
  return notes.searchNotes(query, Math.min(Math.max(limit, 1), 50))
}

/**
 * Путь в vault: `Заметка.md`, `folder/x.md` или заголовок `Заметка`.
 * Если заголовок не найден и createPath — вернём `Title.md` для создания.
 */
async function resolveNoteRel(
  pathOrTitle: string,
  opts: { createPath?: boolean } = {}
): Promise<string> {
  const raw = pathOrTitle.trim()
  if (!raw) throw new Error('Укажите путь или название заметки')

  if (raw.endsWith('.md') || raw.includes('/')) {
    return raw.endsWith('.md') ? raw : `${raw}.md`
  }

  const resolved = await notes.resolveLink(raw)
  if (resolved) return resolved
  if (opts.createPath) return `${raw}.md`
  throw new Error(`Заметка не найдена: ${raw}`)
}

/**
 * Прочитать заметку. path — относительный путь (`Заметка.md`) или заголовок (`Заметка`).
 */
export async function notesRead(pathOrTitle: string): Promise<unknown> {
  await notes.ensureVault()
  const rel = await resolveNoteRel(pathOrTitle)
  const doc = await notes.readNote(rel)
  return {
    path: doc.path,
    title: doc.title,
    content: doc.content,
    links: doc.links,
    updatedAt: new Date(doc.updatedAt).toISOString()
  }
}

/**
 * Записать markdown в заметку целиком (replace) или дописать в конец (append).
 * Несуществующую по заголовку/пути — создаёт.
 */
export async function notesWrite(
  pathOrTitle: string,
  content: string,
  mode: 'replace' | 'append' = 'replace'
): Promise<unknown> {
  await notes.ensureVault()
  if (typeof content !== 'string') throw new Error('content обязателен')

  const rel =
    mode === 'append'
      ? await resolveNoteRel(pathOrTitle)
      : await resolveNoteRel(pathOrTitle, { createPath: true })

  let next = content
  if (mode === 'append') {
    const doc = await notes.readNote(rel)
    const sep = !doc.content || doc.content.endsWith('\n') ? '' : '\n'
    next = doc.content + sep + content
  }

  const ref = await notes.writeNote(rel, next)
  return {
    path: ref.path,
    title: ref.title,
    mode,
    bytes: ref.size,
    updatedAt: new Date(ref.updatedAt).toISOString()
  }
}

/** Создать новую заметку. Если content не передан — шаблон с заголовком. */
export async function notesCreate(pathOrTitle: string, content?: string): Promise<unknown> {
  await notes.ensureVault()
  const raw = pathOrTitle.trim()
  if (!raw) throw new Error('Укажите путь или название заметки')
  const rel = raw.endsWith('.md') ? raw : `${raw}.md`
  const ref = await notes.createNote(rel)
  const written =
    content !== undefined && content !== null ? await notes.writeNote(rel, content) : ref
  return {
    path: written.path,
    title: written.title,
    bytes: written.size,
    updatedAt: new Date(written.updatedAt).toISOString()
  }
}

/** Удалить заметку по пути или названию. */
export async function notesDelete(pathOrTitle: string): Promise<unknown> {
  await notes.ensureVault()
  const rel = await resolveNoteRel(pathOrTitle)
  await notes.deleteNote(rel)
  return { ok: true, path: rel }
}

/* ── Дела (локальный планировщик) ────────────────────────────────── */

/** Строка ISO или null — дела живут в миллисекундах, наружу отдаём читаемое. */
function isoOrNull(ms: number | null | undefined): string | null {
  return ms != null && ms > 0 ? new Date(ms).toISOString() : null
}

function todoView(it: Item): Record<string, unknown> {
  const body = it.body.split('\n').filter((l) => l.startsWith('note:')).map((l) => l.slice(5))
  return {
    id: it.id,
    title: it.title,
    done: isTodoDone(it),
    dueAt: isoOrNull(it.startsAt),
    remindAt: isoOrNull(todoRemindAt(it)),
    note: body.join('\n') || null
  }
}

/** Список дел. По умолчанию только незакрытые — их и просят почти всегда. */
export function todosList(opts: { includeDone?: boolean; limit?: number } = {}): unknown {
  const all = listTodos().filter((t) => (opts.includeDone ? true : !isTodoDone(t)))
  return all.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 500)).map(todoView)
}

/** Создать дело. Сроки — ISO-8601, как у встреч. */
export function todosCreate(input: {
  title: string
  dueAt?: string
  remindAt?: string
  note?: string
  showInCalendar?: boolean
}): unknown {
  const title = input.title.trim()
  if (!title) throw new Error('Название обязательно')
  const item = createTodo({
    title,
    dueAt: input.dueAt ? parseIso(input.dueAt, 'dueAt') : null,
    remindAt: input.remindAt ? parseIso(input.remindAt, 'remindAt') : null,
    note: input.note,
    showInCalendar: input.showInCalendar
  })
  return todoView(item)
}

/**
 * Найти дело по id или по названию. Ассистент редко держит id под рукой, а
 * «удали дело „оплатить счёт“» — обычная формулировка, поэтому ищем и так.
 * Неоднозначность не угадываем: вернём ошибку со списком кандидатов.
 */
function resolveTodo(ref: string): Item {
  const raw = ref.trim()
  if (!raw) throw new Error('Укажите id или название дела')
  const all = listTodos()
  const byId = all.find((t) => t.id === raw)
  if (byId) return byId
  const lower = raw.toLowerCase()
  const exact = all.filter((t) => t.title.toLowerCase() === lower)
  const hits = exact.length ? exact : all.filter((t) => t.title.toLowerCase().includes(lower))
  if (!hits.length) throw new Error(`Дело «${raw}» не найдено`)
  if (hits.length > 1) {
    const list = hits.slice(0, 10).map((t) => `${t.id} — ${t.title}`).join('; ')
    throw new Error(`Под «${raw}» подходит несколько дел, уточните id: ${list}`)
  }
  return hits[0]!
}

/** Удалить дело по id или названию. */
export function todosDelete(ref: string): unknown {
  const it = resolveTodo(ref)
  if (!removeTodo(it.id)) throw new Error(`Не удалось удалить «${it.title}»`)
  return { ok: true, id: it.id, title: it.title }
}

/** Изменить дело: закрыть/переоткрыть, переименовать, передвинуть срок. */
export function todosUpdate(input: {
  todo: string
  title?: string
  done?: boolean
  dueAt?: string | null
  remindAt?: string | null
  note?: string
}): unknown {
  const it = resolveTodo(input.todo)
  return todoView(
    updateTodo({
      id: it.id,
      title: input.title,
      done: input.done,
      // null — снять срок, undefined — не трогать.
      dueAt: input.dueAt === undefined ? undefined : input.dueAt ? parseIso(input.dueAt, 'dueAt') : null,
      remindAt:
        input.remindAt === undefined ? undefined : input.remindAt ? parseIso(input.remindAt, 'remindAt') : null,
      note: input.note
    })
  )
}

export type { ServiceConfig }
