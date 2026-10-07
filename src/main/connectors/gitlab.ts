import type { Item } from '@shared/types'
import { base, getJson } from './http'
import { itemId, type Connector, type SyncContext, type SyncResult } from './types'

interface GitLabMr {
  iid: number
  project_id: number
  title: string
  web_url: string
  updated_at: string
  state: string
  references?: { full?: string }
  author?: { name?: string; username?: string }
}

/**
 * GitLab: merge request'ы, ждущие именно моего ревью, и назначенные на меня.
 * Это очередь ревью — вторая половина «Моего дня» после задач.
 */
export const gitlabConnector: Connector = {
  kind: 'gitlab',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const root = base(ctx.service.baseUrl)
    const common = 'state=opened&per_page=50&order_by=updated_at'

    // Отдельно — где я ревьюер (главное), отдельно — где я автор/ответственный.
    const [toReview, assigned] = await Promise.all([
      getJson<GitLabMr[]>(ctx, `${root}/api/v4/merge_requests?scope=all&reviewer_username=me&${common}`).catch(
        () => [] as GitLabMr[]
      ),
      getJson<GitLabMr[]>(ctx, `${root}/api/v4/merge_requests?scope=assigned_to_me&${common}`).catch(
        () => [] as GitLabMr[]
      )
    ])

    const seen = new Set<string>()
    const items: Item[] = []
    for (const [list, mine] of [
      [toReview, false],
      [assigned, true]
    ] as const) {
      for (const mr of list) {
        const key = `mr:${mr.project_id}:${mr.iid}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          id: itemId(ctx.service, key),
          envId: ctx.service.envId,
          serviceId: ctx.service.id,
          kind: 'review',
          title: `${mr.references?.full ?? `!${mr.iid}`}: ${mr.title}`,
          body: '',
          author: mr.author?.name ?? mr.author?.username ?? null,
          state: mine ? 'мой MR' : 'на моём ревью',
          url: mr.web_url,
          updatedAt: Date.parse(mr.updated_at) || Date.now(),
          unread: false,
          mentioned: !mine,
          startsAt: null,
          endsAt: null
        })
      }
    }

    return { items, cursor: String(Date.now()) }
  }
}
