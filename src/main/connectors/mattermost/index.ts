import { WebSocket } from 'undici'
import type { Item } from '@shared/types'
import { dispatcherFor } from '../../net/transport'
import { itemId, type Connector, type SyncContext, type SyncResult } from '../types'
import {
  MattermostClient,
  type MmChannel,
  type MmChannelMember,
  type MmPost,
  type MmTeam,
  type MmUser
} from './client'

/** Сколько постов за раз тянем из канала с упоминаниями. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

function clientFor(ctx: SyncContext): MattermostClient {
  if (!ctx.service.baseUrl) throw new Error('Не задан адрес Mattermost')
  if (!ctx.secret) throw new Error('Не задан токен Mattermost')
  return new MattermostClient(ctx.service.baseUrl, ctx.secret, dispatcherFor(ctx.env))
}

const displayName = (u: MmUser | undefined): string =>
  u ? (u.nickname || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username) : 'кто-то'

/** У личных переписок display_name пустой, зато в name лежат оба id. */
function channelLabel(ch: MmChannel, meId: string, users: Map<string, MmUser>): string {
  if (ch.type !== 'D') return ch.display_name || ch.name
  const other = ch.name.split('__').find((id) => id !== meId)
  return other ? `@${users.get(other)?.username ?? 'личные'}` : 'личные сообщения'
}

function mentionsMe(post: MmPost, me: MmUser, channelType: string): boolean {
  if (channelType === 'D') return true
  const m = post.message
  return (
    m.includes(`@${me.username}`) || m.includes('@channel') || m.includes('@all') || m.includes('@here')
  )
}

function channelUrl(baseUrl: string, team: MmTeam | undefined, ch: MmChannel): string {
  const base = baseUrl.replace(/\/+$/, '')
  return team ? `${base}/${team.name}/channels/${ch.name}` : base
}

export const mattermostConnector: Connector = {
  kind: 'mattermost',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const api = clientFor(ctx)
    const me = await api.me()
    const teams = await api.myTeams()

    const items: Item[] = []
    const since = ctx.cursor ? Number(ctx.cursor) : Date.now() - LOOKBACK_MS
    let newest = since

    for (const team of teams) {
      const [channels, members] = await Promise.all([
        api.myChannels(team.id),
        api.myChannelMembers(team.id)
      ])
      const memberBy = new Map<string, MmChannelMember>(members.map((m) => [m.channel_id, m]))

      // Собираем всех, кого придётся показать по имени, и разрешаем одним запросом.
      const interesting = channels.filter((ch) => {
        const m = memberBy.get(ch.id)
        if (!m) return false
        return ch.total_msg_count - m.msg_count > 0 || m.mention_count > 0
      })
      if (!interesting.length) continue

      const postsByChannel = new Map<string, MmPost[]>()
      const userIds = new Set<string>()
      for (const ch of interesting) {
        if (ch.type === 'D') ch.name.split('__').forEach((id) => userIds.add(id))
      }

      for (const ch of interesting) {
        const m = memberBy.get(ch.id)!
        if (m.mention_count === 0 && ch.type !== 'D') continue
        const list = await api.postsSince(ch.id, Math.max(m.last_viewed_at, since))
        const posts = list.order.map((id) => list.posts[id]).filter(Boolean)
        postsByChannel.set(ch.id, posts)
        posts.forEach((p) => userIds.add(p.user_id))
      }

      const users = new Map<string, MmUser>(
        (await api.usersByIds([...userIds])).map((u) => [u.id, u])
      )

      for (const ch of interesting) {
        const m = memberBy.get(ch.id)!
        const unread = Math.max(0, ch.total_msg_count - m.msg_count)
        const label = channelLabel(ch, me.id, users)
        const posts = postsByChannel.get(ch.id) ?? []

        const mentions = posts.filter(
          (p) => p.user_id !== me.id && !p.type && mentionsMe(p, me, ch.type)
        )

        for (const p of mentions) {
          newest = Math.max(newest, p.update_at || p.create_at)
          items.push({
            id: itemId(ctx.service, `post:${p.id}`),
            envId: ctx.service.envId,
            serviceId: ctx.service.id,
            kind: 'message',
            title: `${displayName(users.get(p.user_id))} в ${label}`,
            body: p.message,
            author: users.get(p.user_id)?.username ?? null,
            state: ch.type === 'D' ? 'личное' : 'упоминание',
            url: api.permalink(team.name, p.id),
            updatedAt: p.update_at || p.create_at,
            unread: true,
            mentioned: true,
            startsAt: null,
            endsAt: null
          })
        }

        // Канал с непрочитанным, но без упоминаний — одной строкой, а не потоком постов.
        if (unread > 0 && mentions.length === 0) {
          newest = Math.max(newest, ch.last_post_at)
          items.push({
            id: itemId(ctx.service, `channel:${ch.id}`),
            envId: ctx.service.envId,
            serviceId: ctx.service.id,
            kind: 'message',
            title: label,
            body: `${unread} непрочитанных`,
            author: null,
            state: 'непрочитано',
            url: channelUrl(ctx.service.baseUrl, team, ch),
            updatedAt: ch.last_post_at,
            unread: true,
            mentioned: false,
            startsAt: null,
            endsAt: null
          })
        }
      }
    }

    return { items, cursor: String(newest) }
  },

  /**
   * Живой поток событий. Mattermost шлёт их по WebSocket, так что упоминания
   * приходят сразу, а не через минуту опроса.
   */
  async startRealtime(ctx: SyncContext, onItems: (items: Item[]) => void): Promise<() => void> {
    const api = clientFor(ctx)
    const me = await api.me()
    const teams = await api.myTeams()
    const teamById = new Map(teams.map((t) => [t.id, t]))

    const wsUrl = ctx.service.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/v4/websocket'

    let closed = false
    let socket: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = (): void => {
      if (closed) return
      const ws = new WebSocket(wsUrl, { dispatcher: dispatcherFor(ctx.env) })
      socket = ws

      ws.addEventListener('open', () => {
        retry = 0
        // Токен уходит отдельным сообщением: заголовки в WebSocket не положить.
        ws.send(
          JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: ctx.secret } })
        )
      })

      ws.addEventListener('message', (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as {
            event?: string
            data?: Record<string, unknown>
            broadcast?: { team_id?: string }
          }
          if (frame.event !== 'posted' || !frame.data?.post) return

          const post = JSON.parse(String(frame.data.post)) as MmPost
          if (post.user_id === me.id || post.type) return

          const channelType = String(frame.data.channel_type ?? '')
          if (!mentionsMe(post, me, channelType)) return

          const team = teamById.get(String(frame.data.team_id ?? frame.broadcast?.team_id ?? ''))
          const label =
            channelType === 'D'
              ? `@${String(frame.data.sender_name ?? '').replace(/^@/, '')}`
              : String(frame.data.channel_display_name ?? 'канал')

          onItems([
            {
              id: itemId(ctx.service, `post:${post.id}`),
              envId: ctx.service.envId,
              serviceId: ctx.service.id,
              kind: 'message',
              title: `${String(frame.data.sender_name ?? 'кто-то').replace(/^@/, '')} в ${label}`,
              body: post.message,
              author: String(frame.data.sender_name ?? '').replace(/^@/, '') || null,
              state: channelType === 'D' ? 'личное' : 'упоминание',
              url: team ? api.permalink(team.name, post.id) : ctx.service.baseUrl,
              updatedAt: post.update_at || post.create_at,
              unread: true,
              mentioned: true,
              startsAt: null,
              endsAt: null
            }
          ])
        } catch {
          // Битый или незнакомый кадр — не повод ронять подписку.
        }
      })

      const reconnect = (): void => {
        if (closed) return
        // Обрыв туннеля не должен превращаться в шторм переподключений.
        retry = Math.min(retry + 1, 6)
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 60_000))
      }

      ws.addEventListener('close', reconnect)
      ws.addEventListener('error', () => ws.close())
    }

    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  },

  async perform(ctx: SyncContext, action: string, payload: unknown): Promise<void> {
    if (action !== 'post') throw new Error(`Неизвестное действие Mattermost: ${action}`)
    const { channelId, message, rootId } = payload as {
      channelId: string
      message: string
      rootId?: string
    }
    await clientFor(ctx).createPost(channelId, message, rootId)
  }
}
