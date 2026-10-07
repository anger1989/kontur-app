import { request } from 'undici'
import type { Dispatcher } from 'undici'

/* Срезы ответов Mattermost API v4 — только поля, которые мы действительно читаем. */

export interface MmUser {
  id: string
  username: string
  first_name?: string
  last_name?: string
  nickname?: string
}

export interface MmTeam {
  id: string
  display_name: string
  name: string
}

/** Плашка вверху канала (Channel Banner, MM 10.9+, платная). */
export interface MmChannelBanner {
  enabled?: boolean
  text?: string
  /** Только hex: `#rgb` или `#rrggbb`, иначе сервер отклонит патч. */
  background_color?: string
}

export interface MmChannel {
  id: string
  team_id: string
  type: 'O' | 'P' | 'D' | 'G'
  display_name: string
  name: string
  header?: string
  purpose?: string
  banner_info?: MmChannelBanner | null
  total_msg_count: number
  last_post_at: number
}

/** `/license/client?format=old` — доступен любому пользователю, не только админу. */
export interface MmClientLicense {
  IsLicensed?: string
  SkuShortName?: string
  SkuName?: string
  Cloud?: string
}

export interface MmChannelMember {
  channel_id: string
  user_id: string
  msg_count: number
  mention_count: number
  last_viewed_at: number
}

export interface MmPost {
  id: string
  create_at: number
  update_at: number
  user_id: string
  channel_id: string
  root_id: string
  message: string
  type: string
}

export interface MmPostList {
  order: string[]
  posts: Record<string, MmPost>
}

export class MattermostError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'MattermostError'
  }
}

/**
 * Тонкий клиент Mattermost API v4.
 *
 * Весь трафик идёт через dispatcher контура: про прокси и корпоративный CA
 * клиент не знает ничего.
 */
export class MattermostClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly dispatcher: Dispatcher
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v4${path}`
    const res = await request(url, {
      method: (init.method ?? 'GET') as 'GET',
      dispatcher: this.dispatcher,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      headersTimeout: 15_000,
      bodyTimeout: 15_000
    })

    if (res.statusCode >= 400) {
      const text = await res.body.text().catch(() => '')
      throw new MattermostError(
        res.statusCode === 401
          ? 'Токен отклонён (401). Проверьте персональный токен доступа.'
          : `Mattermost ответил ${res.statusCode}: ${text.slice(0, 200)}`,
        res.statusCode
      )
    }
    return (await res.body.json()) as T
  }

  me(): Promise<MmUser> {
    return this.call<MmUser>('/users/me')
  }

  myTeams(): Promise<MmTeam[]> {
    return this.call<MmTeam[]>('/users/me/teams')
  }

  myChannels(teamId: string): Promise<MmChannel[]> {
    return this.call<MmChannel[]>(`/users/me/teams/${teamId}/channels`)
  }

  myChannelMembers(teamId: string): Promise<MmChannelMember[]> {
    return this.call<MmChannelMember[]>(`/users/me/teams/${teamId}/channels/members`)
  }

  /** Посты канала начиная с момента времени (мс). */
  postsSince(channelId: string, since: number): Promise<MmPostList> {
    return this.call<MmPostList>(`/channels/${channelId}/posts?since=${since}`)
  }

  /** Последние посты канала (page=0 — самые свежие). */
  posts(
    channelId: string,
    opts: { page?: number; perPage?: number; before?: string; after?: string } = {}
  ): Promise<MmPostList> {
    const q = new URLSearchParams()
    if (opts.page != null) q.set('page', String(opts.page))
    if (opts.perPage != null) q.set('per_page', String(opts.perPage))
    if (opts.before) q.set('before', opts.before)
    if (opts.after) q.set('after', opts.after)
    const qs = q.toString()
    return this.call<MmPostList>(`/channels/${channelId}/posts${qs ? `?${qs}` : ''}`)
  }

  channel(channelId: string): Promise<MmChannel> {
    return this.call<MmChannel>(`/channels/${channelId}`)
  }

  channelByName(teamId: string, name: string): Promise<MmChannel> {
    return this.call<MmChannel>(`/teams/${teamId}/channels/name/${encodeURIComponent(name)}`)
  }

  /** Что сервер говорит о своей лицензии. Без неё баннеры каналов недоступны. */
  clientLicense(): Promise<MmClientLicense> {
    return this.call<MmClientLicense>('/license/client?format=old')
  }

  /** Частичное обновление канала (header / purpose / display_name / banner_info). */
  patchChannel(
    channelId: string,
    patch: {
      header?: string
      purpose?: string
      display_name?: string
      banner_info?: MmChannelBanner
    }
  ): Promise<MmChannel> {
    return this.call<MmChannel>(`/channels/${channelId}/patch`, {
      method: 'PUT',
      body: patch
    })
  }

  post(postId: string): Promise<MmPost> {
    return this.call<MmPost>(`/posts/${postId}`)
  }

  usersByIds(ids: string[]): Promise<MmUser[]> {
    if (!ids.length) return Promise.resolve([])
    return this.call<MmUser[]>('/users/ids', { method: 'POST', body: ids })
  }

  createPost(channelId: string, message: string, rootId?: string): Promise<MmPost> {
    return this.call<MmPost>('/posts', {
      method: 'POST',
      body: { channel_id: channelId, message, root_id: rootId ?? '' }
    })
  }

  /** Ссылка на пост в вебе: по ней открывается нужный тред. */
  permalink(teamName: string, postId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${teamName}/pl/${postId}`
  }
}
