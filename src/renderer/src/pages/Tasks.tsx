import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Eye, EyeOff, Kanban, Loader2, RefreshCw } from 'lucide-react'
import type { Item } from '@shared/types'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  KanbanBoard,
  type CardData,
  type CardTag,
  type ColumnData,
  type ColumnKind,
  type TagVariant
} from '@/components/ui/kanban-board'
import { cn } from '@/lib/utils'

type BoardColumn = {
  id: string
  title: string
  category: 'new' | 'indeterminate' | 'done'
  statusIds: string[]
  statusName: string
}

function parseCat(body: string): 'new' | 'indeterminate' | 'done' {
  const line = body.split('\n').find((l) => l.startsWith('cat:'))
  const k = line?.slice(4)
  if (k === 'indeterminate' || k === 'done' || k === 'new') return k
  return 'new'
}

function parseSid(body: string): string | null {
  const line = body.split('\n').find((l) => l.startsWith('sid:'))
  return line ? line.slice(4) : null
}

function parseMeta(body: string): { priority: string; type: string } {
  let priority = ''
  let type = ''
  for (const line of body.split('\n')) {
    if (line.startsWith('pri:')) priority = line.slice(4)
    else if (line.startsWith('type:')) type = line.slice(4)
  }
  return { priority, type }
}

function issueKeyOf(item: Item): string {
  const m = /^([A-Z][A-Z0-9]+-\d+)/i.exec(item.title)
  return m?.[1] ?? item.title.split(':')[0] ?? ''
}

function summaryOf(item: Item): string {
  const i = item.title.indexOf(': ')
  return i >= 0 ? item.title.slice(i + 2) : item.title
}

function typeVariant(type: string): TagVariant {
  const t = type.toLowerCase()
  if (t.includes('bug') || t.includes('дефект')) return 'bug'
  if (t.includes('story') || t.includes('истор')) return 'feature'
  if (t.includes('task') || t.includes('задач')) return 'improvement'
  if (t.includes('epic')) return 'design'
  if (t.includes('doc')) return 'docs'
  return 'feature'
}

function kindOf(cat: BoardColumn['category']): ColumnKind {
  if (cat === 'done') return 'done'
  if (cat === 'indeterminate') return 'in-progress'
  return 'todo'
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/** Закрытые / отменённые — по категории done или имени статуса. */
function isClosedColumn(col: BoardColumn): boolean {
  if (col.category === 'done') return true
  const n = `${col.title} ${col.statusName}`.toLowerCase()
  return (
    n.includes('cancel') ||
    n.includes('отмен') ||
    n.includes('closed') ||
    n.includes('закрыт') ||
    n.includes('rejected') ||
    n.includes('declined')
  )
}

function itemToCard(item: Item): CardData {
  const meta = parseMeta(item.body)
  const tags: CardTag[] = []
  if (meta.type) tags.push({ label: meta.type, variant: typeVariant(meta.type) })
  if (meta.priority) tags.push({ label: meta.priority, variant: 'improvement' })
  return {
    id: item.id,
    title: summaryOf(item),
    subtitle: issueKeyOf(item),
    tags,
    assignee: item.author ? { name: item.author } : undefined,
    date: shortDate(item.updatedAt)
  }
}

/**
 * К какой колонке относится задача. При наличии sid — только по нему
 * (иначе старый sid + новое state давали дубль в двух колонках).
 */
function columnMatchesItem(col: BoardColumn, item: Item): boolean {
  const sid = parseSid(item.body)
  if (col.statusIds.length) {
    if (sid) return col.statusIds.includes(sid)
    if (!item.state) return false
    const state = item.state.toLowerCase()
    return state === col.statusName.toLowerCase() || state === col.title.toLowerCase()
  }
  if (col.id.startsWith('cat:')) return parseCat(item.body) === col.category
  return item.state?.toLowerCase() === col.title.toLowerCase()
}

function replaceSid(body: string, sid: string | undefined): string {
  const without = body
    .split('\n')
    .filter((l) => !l.startsWith('sid:'))
    .join('\n')
    .replace(/\n+$/, '')
  if (!sid) return without
  return without ? `${without}\nsid:${sid}` : `sid:${sid}`
}

/**
 * Канбан своих задач из Jira.
 * Колонки — оригинальные статусы workflow (порядок с Agile-доски), не имена колонок доски.
 */
export function Tasks(): JSX.Element {
  const { config, openItem } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [boardCols, setBoardCols] = useState<BoardColumn[]>([])
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Пока нет ответа board() — не рисуем fallback cat:* (иначе колонки скачут). */
  const [boardBooting, setBoardBooting] = useState(true)
  /** Скрыть колонки без карточек. */
  const [hideEmpty, setHideEmpty] = useState(true)
  /** Скрыть Done / Canceled и прочие закрытые. */
  const [hideClosed, setHideClosed] = useState(true)

  const jiraServices = (config?.services ?? []).filter((s) => s.kind === 'jira' && s.enabled)

  const reloadItems = (): void => {
    void window.kontur.items.query({ kinds: ['task'], limit: 500 }).then(setItems)
  }

  const reloadBoard = useCallback((opts?: { boot?: boolean }): Promise<void> => {
    // boot: первый заход / смена конфига — лоадер вместо старых/fallback колонок.
    // silent (sync): оставляем текущую доску на экране.
    if (opts?.boot) setBoardBooting(true)
    return window.kontur.tasks
      .board()
      .then((b) => {
        setBoardCols(b.columns)
        setProjectKey(b.projectKey)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (opts?.boot) setBoardBooting(false)
      })
  }, [])

  useEffect(() => {
    reloadItems()
    return window.kontur.items.onChange(() => {
      reloadItems()
    })
  }, [])

  // Первый заход и смена projectKey — лоадер, пока board() не ответит.
  const jiraProjectSig = jiraServices.map((s) => `${s.id}:${s.options.projectKey ?? ''}`).join('|')
  useEffect(() => {
    void reloadBoard({ boot: true })
  }, [jiraProjectSig, reloadBoard])

  const columns: ColumnData[] = useMemo(() => {
    const cols = boardCols.length
      ? boardCols
      : ([
          { id: 'cat:new', title: 'К выполнению', category: 'new', statusIds: [], statusName: '' },
          {
            id: 'cat:indeterminate',
            title: 'В работе',
            category: 'indeterminate',
            statusIds: [],
            statusName: ''
          },
          { id: 'cat:done', title: 'Готово', category: 'done', statusIds: [], statusName: '' }
        ] satisfies BoardColumn[])

    // Одна задача — одна колонка (первый матч по порядку доски).
    const assigned = new Map<string, string>()
    for (const col of cols) {
      for (const it of items) {
        if (assigned.has(it.id)) continue
        if (columnMatchesItem(col, it)) assigned.set(it.id, col.id)
      }
    }

    const result: ColumnData[] = cols.map((col) => {
      const cards = items
        .filter((it) => assigned.get(it.id) === col.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(itemToCard)
      const clipped =
        col.category === 'done' && col.id.startsWith('cat:') ? cards.slice(0, 12) : cards
      return {
        id: col.id,
        title: col.title,
        kind: kindOf(col.category),
        cards: clipped
      }
    })

    // Задачи, не попавшие ни в одну колонку доски — в первую колонку своей категории.
    const orphans = items.filter((it) => !assigned.has(it.id))
    for (const it of orphans) {
      const cat = parseCat(it.body)
      const target = result.find((c) => c.kind === kindOf(cat)) ?? result[0]
      if (target) target.cards.push(itemToCard(it))
    }

    return result.filter((col) => {
      const meta = cols.find((c) => c.id === col.id)
      if (hideClosed && meta && isClosedColumn(meta)) return false
      if (hideEmpty && col.cards.length === 0) return false
      return true
    })
  }, [boardCols, items, hideEmpty, hideClosed])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    try {
      await window.kontur.items.syncNow()
      reloadItems()
      await reloadBoard()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const onDrop = async (cardId: string, fromId: string, toId: string): Promise<void> => {
    if (fromId === toId) return
    const item = items.find((i) => i.id === cardId)
    if (!item) return
    const col = boardCols.find((c) => c.id === toId)
    if (!col) return

    setError(null)
    const sid = col.statusIds[0]
    // Оптимистично: и state, и sid — иначе дубль в старой/новой колонке.
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== cardId) return it
        const body = it.body.replace(/cat:\w+/, `cat:${col.category}`)
        return {
          ...it,
          state: col.statusName || col.title,
          body: replaceSid(body, sid),
          updatedAt: Date.now()
        }
      })
    )

    try {
      const target = col.id.startsWith('cat:')
        ? { category: col.category }
        : {
            statusName: col.statusName || col.title,
            statusIds: col.statusIds
          }
      const next = await window.kontur.tasks.transition(cardId, target)
      setItems((prev) => prev.map((it) => (it.id === next.id ? next : it)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      reloadItems()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pt-5 pb-4 sm:px-6 lg:px-8">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Задачи</h1>
          <p className="mt-1 text-muted-foreground">
            {projectKey
              ? `Мои задачи · проект ${projectKey} · статусы Jira`
              : 'Мои задачи из Jira · укажи проект в настройках сервиса — подтянем статусы'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={hideEmpty ? 'secondary' : 'outline'}
            title={hideEmpty ? 'Показать пустые колонки' : 'Скрыть пустые колонки'}
            onClick={() => setHideEmpty((v) => !v)}
          >
            {hideEmpty ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {hideEmpty ? 'Только с задачами' : 'Все колонки'}
          </Button>
          <Button
            size="sm"
            variant={hideClosed ? 'secondary' : 'outline'}
            title={hideClosed ? 'Показать Done / Canceled' : 'Скрыть Done / Canceled'}
            onClick={() => setHideClosed((v) => !v)}
          >
            {hideClosed ? 'Скрыты закрытые' : 'Скрыть закрытые'}
          </Button>
          <Button size="sm" variant="outline" disabled={syncing} onClick={() => void sync()}>
            <RefreshCw className={cn(syncing && 'animate-spin')} />
            Обновить
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-3 shrink-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      )}

      {jiraServices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Kanban className="size-6 text-muted-foreground" />
          <p className="max-w-md text-[13px] text-muted-foreground/80">
            Подключи Jira в настройках контура — сюда попадут задачи, назначенные на тебя.
          </p>
        </div>
      ) : boardBooting ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground/80">Загружаем колонки доски…</p>
        </div>
      ) : items.length === 0 && columns.every((c) => c.cards.length === 0) ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Kanban className="size-6 text-muted-foreground" />
          <p className="max-w-md text-[13px] text-muted-foreground/80">
            Пока пусто. Нажми «Обновить», когда контур поднят и Jira доступна.
          </p>
        </div>
      ) : columns.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Kanban className="size-6 text-muted-foreground" />
          <p className="max-w-md text-[13px] text-muted-foreground/80">
            Все колонки скрыты фильтрами — включи «Все колонки» или покажи закрытые.
          </p>
        </div>
      ) : (
        <KanbanBoard
          columns={columns}
          onCardClick={(card) => {
            const it = items.find((i) => i.id === card.id)
            if (it) openItem(it)
          }}
          onDrop={(cardId, from, to) => void onDrop(cardId, from, to)}
        />
      )}
    </div>
  )
}
