import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import { Bookmark as BookmarkIcon, Globe, Plus, Search as SearchIcon, Trash2 } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { Bookmark } from '@shared/types'
import { useStore } from '@/store'
import { openLink } from '@/lib/openLink'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type SortKey = 'recent' | 'title' | 'host'

const SORT_LABEL: Record<SortKey, string> = {
  recent: 'Недавние',
  title: 'По алфавиту',
  host: 'По сайту'
}

/** Псевдо-группа «Все закладки» в сайдбаре — ни один реальный host так не называется. */
const ALL = '__all__'

/** Открыть закладку: если адрес совпадает с настроенным встраиваемым сервисом — своим окном, иначе наружу (Ктолк — через его логику). */
function openBookmark(b: Bookmark): void {
  const { config, openWindow } = useStore.getState()
  try {
    const origin = new URL(b.url).origin
    const svc = config?.services.find((s) => {
      if (!s.enabled || !s.baseUrl || (s.mode !== 'embed' && s.mode !== 'both')) return false
      try {
        return new URL(s.baseUrl).origin === origin
      } catch {
        return false
      }
    })
    if (svc) {
      openWindow({ kind: 'service', serviceId: svc.id, url: b.url })
      return
    }
  } catch {
    // Некорректный адрес — пусть решает openLink.
  }
  openLink(b.url)
}

function sortBookmarks(list: Bookmark[], sort: SortKey): Bookmark[] {
  const copy = [...list]
  if (sort === 'title') copy.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
  else if (sort === 'host') copy.sort((a, b) => a.host.localeCompare(b.host) || a.title.localeCompare(b.title, 'ru'))
  else copy.sort((a, b) => b.updatedAt - a.updatedAt)
  return copy
}

/**
 * Каталог закладок: вставил ссылку — она сама легла в группу по сайту.
 * Группы в сайдбаре — хосты, формируются сами, без ручных папок. Из
 * открытого окна сервиса закладка добавляется кнопкой в его шапке (Window.tsx).
 */
export function Bookmarks(): JSX.Element {
  const [list, setList] = useState<Bookmark[]>([])
  const [group, setGroup] = useState<string>(ALL)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')
  const [newUrl, setNewUrl] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)

  const load = (): void => {
    void window.kontur.bookmarks.list().then(setList)
  }

  useEffect(() => {
    load()
    return window.kontur.bookmarks.onChange(load)
  }, [])

  const hostCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of list) map.set(b.host, (map.get(b.host) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [list])

  // Группа опустела (удалили последнюю закладку хоста) — вернуться ко «Всем».
  useEffect(() => {
    if (group !== ALL && !hostCounts.some(([h]) => h === group)) setGroup(ALL)
  }, [group, hostCounts])

  const scoped = useMemo(
    () => (group === ALL ? list : list.filter((b) => b.host === group)),
    [list, group]
  )

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    const base = query
      ? scoped.filter((b) => b.title.toLowerCase().includes(query) || b.url.toLowerCase().includes(query))
      : scoped
    return sortBookmarks(base, sort)
  }, [scoped, q, sort])

  // Внутри выбранного host'а группировать уже незачем — она и так одна.
  const sections = useMemo((): [string, Bookmark[]][] => {
    if (group !== ALL) return [[group, filtered]]
    const map = new Map<string, Bookmark[]>()
    for (const b of filtered) {
      const arr = map.get(b.host) ?? []
      arr.push(b)
      map.set(b.host, arr)
    }
    return [...map.entries()].sort((a, b) => (sort === 'host' ? 0 : a[0].localeCompare(b[0])))
  }, [filtered, group, sort])

  const submitAdd = (e: FormEvent): void => {
    e.preventDefault()
    const url = newUrl.trim()
    if (!url) return
    setAdding(true)
    void window.kontur.bookmarks
      .add(url.includes('://') ? url : `https://${url}`, newTitle.trim() || undefined)
      .then(() => {
        setNewUrl('')
        setNewTitle('')
        load()
      })
      .catch((err: unknown) => {
        toast.error(`Не удалось добавить закладку: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setAdding(false))
  }

  const remove = (b: Bookmark): void => {
    void window.kontur.bookmarks.remove(b.id).then(load)
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-48 shrink-0 flex-col border-r bg-muted/20">
        <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Группы
        </p>
        <ScrollArea className="flex-1 px-1.5 pb-3">
          <button
            type="button"
            onClick={() => setGroup(ALL)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
              group === ALL
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <BookmarkIcon className="size-3.5 shrink-0" />
              <span className="truncate">Все закладки</span>
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{list.length}</span>
          </button>
          {hostCounts.map(([host, count]) => (
            <button
              key={host}
              type="button"
              onClick={() => setGroup(host)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                group === host
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Globe className="size-3.5 shrink-0" />
                <span className="truncate">{host || 'Без адреса'}</span>
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
          {!hostCounts.length && <p className="px-2 py-4 text-[12px] text-muted-foreground">Групп пока нет</p>}
        </ScrollArea>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b px-4 pt-4 pb-3 sm:px-6">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">
            {group === ALL ? 'Закладки' : group || 'Без адреса'}
          </h1>
          <p className="mt-0.5 mb-3 text-[13px] text-muted-foreground">
            Свои ссылки или прямо из открытых сервисов — каталог собирается и группируется сам.
          </p>

          <form onSubmit={submitAdd} className="mb-2 flex flex-col gap-2 sm:flex-row">
            <Input
              className="sm:flex-[2]"
              placeholder="Вставьте ссылку…"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
            />
            <Input
              className="sm:flex-1"
              placeholder="Название (необязательно)"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <Button type="submit" disabled={!newUrl.trim() || adding} className="shrink-0">
              <Plus className="size-4" /> Добавить
            </Button>
          </form>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute z-20 top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Поиск по названию или адресу…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger size="sm" className="h-9 w-[150px] shrink-0 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SORT_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 py-3 sm:px-6">
            {!filtered.length && (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                <BookmarkIcon className="size-8 opacity-40" />
                <p className="text-[13px]">
                  {list.length ? 'Ничего не найдено' : 'Пока пусто — вставьте ссылку выше'}
                </p>
              </div>
            )}

            <div className="space-y-6">
              {sections.map(([host, items]) => (
                <section key={host}>
                  {group === ALL && (
                    <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                      {host || 'Без адреса'} · {items.length}
                    </h2>
                  )}
                  <div className="space-y-px">
                    {items.map((b) => (
                      <div
                        key={b.id}
                        className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent"
                      >
                        <button
                          type="button"
                          onClick={() => openBookmark(b)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          {b.favicon ? (
                            <img src={b.favicon} alt="" className="size-5 shrink-0 rounded-sm" />
                          ) : (
                            <Globe className="size-5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] font-medium">{b.title}</span>
                            <span className="truncate text-xs text-muted-foreground">{b.url}</span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          title="Удалить закладку"
                          className="opacity-0 group-hover:opacity-100"
                          onClick={() => remove(b)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
