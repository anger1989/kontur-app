import type { AutomationEventFilter } from '@shared/automations'
import type { Item } from '@shared/types'

function contains(hay: string | null | undefined, needle: string | undefined): boolean {
  if (!needle?.trim()) return true
  return (hay ?? '').toLowerCase().includes(needle.trim().toLowerCase())
}

export function matchesFilter(item: Item, filter?: AutomationEventFilter): boolean {
  if (!filter) return true
  if (filter.envId && item.envId !== filter.envId) return false
  if (filter.mentioned === true && !item.mentioned) return false
  if (filter.mentioned === false && item.mentioned) return false
  if (filter.folder && (item.folder ?? 'inbox') !== filter.folder) return false
  if (!contains(item.author, filter.authorContains)) return false
  if (!contains(item.title, filter.titleContains)) return false
  if (!contains(item.body, filter.bodyContains)) return false
  return true
}

export function itemContext(item: Item): Record<string, unknown> {
  return {
    title: item.title,
    author: item.author ?? '',
    body: item.body,
    url: item.url,
    kind: item.kind,
    envId: item.envId,
    serviceId: item.serviceId,
    state: item.state ?? '',
    folder: item.folder ?? '',
    mentioned: item.mentioned,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    item: {
      id: item.id,
      title: item.title,
      author: item.author,
      body: item.body,
      url: item.url,
      kind: item.kind,
      envId: item.envId,
      serviceId: item.serviceId,
      state: item.state,
      folder: item.folder,
      mentioned: item.mentioned,
      startsAt: item.startsAt,
      endsAt: item.endsAt
    }
  }
}
