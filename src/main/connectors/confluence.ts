import type { Item } from '@shared/types'
import { base, getJson, stripHtml } from './http'
import { itemId, type Connector, type SyncContext, type SyncResult } from './types'

interface CqlResult {
  results: {
    content?: { id: string; type: string; title: string }
    title?: string
    url?: string
    lastModified?: string
    excerpt?: string
  }[]
}

/**
 * Confluence (Server/Data Center): страницы, где меня упомянули, и мои недавние
 * правки — чтобы не терять контекст обсуждений по задачам.
 */
export const confluenceConnector: Connector = {
  kind: 'confluence',

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const root = base(ctx.service.baseUrl)
    const cql = encodeURIComponent(
      '(mention = currentUser() OR contributor = currentUser()) AND type = page ORDER BY lastmodified DESC'
    )
    const data = await getJson<CqlResult>(
      ctx,
      `${root}/rest/api/search?cql=${cql}&limit=50`
    )

    const items: Item[] = data.results
      .filter((r) => r.content?.id)
      .map((r) => ({
        id: itemId(ctx.service, `page:${r.content!.id}`),
        envId: ctx.service.envId,
        serviceId: ctx.service.id,
        kind: 'page' as const,
        title: r.content!.title || r.title || 'Страница',
        body: r.excerpt ? stripHtml(r.excerpt) : '',
        author: null,
        state: 'Confluence',
        url: `${root}/pages/viewpage.action?pageId=${r.content!.id}`,
        updatedAt: r.lastModified ? Date.parse(r.lastModified) : Date.now(),
        unread: false,
        mentioned: true,
        startsAt: null,
        endsAt: null
      }))

    return { items, cursor: String(Date.now()) }
  }
}
