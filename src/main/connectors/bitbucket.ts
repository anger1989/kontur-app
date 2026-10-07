import type { Item } from '@shared/types'
import { base, getJson } from './http'
import { itemId, type Connector, type SyncContext, type SyncResult } from './types'

interface BbPr {
  id: number
  title: string
  updatedDate: number
  author?: { user?: { displayName?: string } }
  toRef?: { repository?: { slug?: string; project?: { key?: string } } }
  links?: { self?: { href: string }[] }
}
interface BbPage {
  values: BbPr[]
}

/**
 * Bitbucket (Server/Data Center): pull request'ы, где я ревьюер.
 * REST 1.0, dashboard показывает PR'ы по всем репозиториям сразу.
 */
export const bitbucketConnector: Connector = {
  kind: 'bitbucket',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const root = base(ctx.service.baseUrl)
    const data = await getJson<BbPage>(
      ctx,
      `${root}/rest/api/1.0/dashboard/pull-requests?state=OPEN&role=REVIEWER&limit=50`
    )

    const items: Item[] = data.values.map((pr) => {
      const repo = pr.toRef?.repository
      const ref = repo ? `${repo.project?.key}/${repo.slug}#${pr.id}` : `PR #${pr.id}`
      return {
        id: itemId(ctx.service, `pr:${pr.id}`),
        envId: ctx.service.envId,
        serviceId: ctx.service.id,
        kind: 'review' as const,
        title: `${ref}: ${pr.title}`,
        body: '',
        author: pr.author?.user?.displayName ?? null,
        state: 'на моём ревью',
        url: pr.links?.self?.[0]?.href ?? base(ctx.service.baseUrl),
        updatedAt: pr.updatedDate || Date.now(),
        unread: false,
        mentioned: true,
        startsAt: null,
        endsAt: null
      }
    })

    return { items, cursor: String(Date.now()) }
  }
}
