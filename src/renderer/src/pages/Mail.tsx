import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  ListFilter,
  Mail as MailIcon,
  PenSquare,
  RefreshCw,
  Reply,
  Search,
  Send,
  Trash2,
  X
} from 'lucide-react'
import type { Item, MailDetail, MailFolder, MailMailbox, MailRule } from '@shared/types'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FilterChip, HtmlWithExternalLinks, LinkifiedText } from '@/components/LinkifiedText'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { RecipientInput } from '@/components/RecipientInput'
import { Sidebar, SidebarBody, SidebarLink } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/toast'

const PAGE_SIZE = 25
const DAY = 86_400_000

type ReadFilter = 'all' | 'unread' | 'read'
type DateFilter = 'all' | 'today' | '7d' | '30d'

const DATE_FILTER_LABEL: Record<DateFilter, string> = {
  all: 'Любая дата',
  today: 'Сегодня',
  '7d': '7 дней',
  '30d': '30 дней'
}

const FOLDER_LABEL: Record<MailFolder, string> = {
  inbox: 'Входящие',
  sent: 'Отправленные',
  drafts: 'Черновики'
}

const FOLDER_ORDER: MailFolder[] = ['inbox', 'sent', 'drafts']

const FOLDER_ICON: Record<MailFolder, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FilePenLine
}

function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (startMsg === startToday) return time
  if (startMsg === startToday - DAY) return `вчера ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
  return `${date} ${time}`
}

function extractEmail(from: string): string {
  const m = /<([^>]+)>/.exec(from)
  return (m?.[1] ?? from).trim()
}

function dateCutoff(filter: DateFilter): number | null {
  const now = Date.now()
  if (filter === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (filter === '7d') return now - 7 * DAY
  if (filter === '30d') return now - 30 * DAY
  return null
}

/**
 * Полноценный почтовый клиент: список слева (поиск + фильтры + пагинация),
 * письмо справа, ответ. Контур — цветной полоской.
 */
export function Mail({
  focusItemId,
  onFocused
}: {
  /** Открыть сразу конкретное письмо — пришли из уведомления/ленты. */
  focusItemId?: string
  /** Deep-link отработан — сбросить его на уровне окна. */
  onFocused?: () => void
}): JSX.Element {
  const { config } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<ReadFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [folderFilter, setFolderFilter] = useState<string>('inbox')
  const [mailboxes, setMailboxes] = useState<MailMailbox[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [moveOpen, setMoveOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rules, setRules] = useState<MailRule[]>([])
  const [rulesSupported, setRulesSupported] = useState(false)
  const [rulesLoading, setRulesLoading] = useState(false)

  const unify = config?.unifyMail ?? true
  const mailServices = (config?.services ?? []).filter((s) => s.kind === 'mail' && s.enabled)
  const primaryMail = mailServices[0]

  const reload = (): void => {
    // 2500 — с запасом под расширенный синк (до ~1200 входящих × 2 контура + Sent/Drafts).
    void window.kontur.items.query({ kinds: ['mail'], limit: 2500 }).then((list) => {
      setItems(list)
    })
  }

  const reloadFolders = (): void => {
    if (!primaryMail) {
      setMailboxes([])
      return
    }
    void window.kontur.mail
      .listFolders({ serviceId: primaryMail.id })
      .then(setMailboxes)
      .catch(() => setMailboxes([]))
  }

  useEffect(() => {
    reload()
    reloadFolders()
    return window.kontur.items.onChange(reload)
  }, [primaryMail?.id])

  useEffect(() => {
    if (!primaryMail) {
      setRulesSupported(false)
      return
    }
    void window.kontur.mail.rulesSupported(primaryMail.id).then(setRulesSupported)
  }, [primaryMail?.id])

  const unreadCount = useMemo(() => items.filter((it) => it.unread).length, [items])

  const folderStats = useMemo(() => {
    const stats: Record<string, { total: number; unread: number }> = {
      inbox: { total: 0, unread: 0 },
      sent: { total: 0, unread: 0 },
      drafts: { total: 0, unread: 0 }
    }
    for (const it of items) {
      const folder = it.folder ?? 'inbox'
      if (!stats[folder]) stats[folder] = { total: 0, unread: 0 }
      stats[folder].total += 1
      if (it.unread) stats[folder].unread += 1
    }
    return stats
  }, [items])

  /** Системные + пользовательские (без дублей role). */
  const sidebarFolders = useMemo(() => {
    const system: { id: string; name: string; role: MailFolder | null }[] = FOLDER_ORDER.map(
      (role) => {
        const mb = mailboxes.find((m) => m.role === role)
        return { id: mb?.id ?? role, name: FOLDER_LABEL[role], role }
      }
    )
    const custom = mailboxes.filter(
      (m) => !m.role && !FOLDER_ORDER.includes((m.id as MailFolder) || 'inbox')
    )
    return { system, custom }
  }, [mailboxes])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const since = dateCutoff(dateFilter)
    const roleOfFilter =
      folderFilter === 'inbox' || folderFilter === 'sent' || folderFilter === 'drafts'
        ? folderFilter
        : mailboxes.find((m) => m.id === folderFilter)?.role ?? null
    return items.filter((it) => {
      const itemFolder = it.folder ?? 'inbox'
      const match =
        itemFolder === folderFilter ||
        (roleOfFilter != null && itemFolder === roleOfFilter) ||
        (mailboxes.some((m) => m.id === folderFilter && m.role === itemFolder))
      if (!match) return false
      if (readFilter === 'unread' && !it.unread) return false
      if (readFilter === 'read' && it.unread) return false
      if (since != null && it.updatedAt < since) return false
      if (!q) return true
      return (
        it.title.toLowerCase().includes(q) ||
        (it.author ?? '').toLowerCase().includes(q) ||
        it.body.toLowerCase().includes(q)
      )
    })
  }, [items, query, readFilter, dateFilter, folderFilter, mailboxes])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)

  useEffect(() => {
    setPage(0)
  }, [query, readFilter, dateFilter, folderFilter])

  const openMail = async (id: string): Promise<void> => {
    setSelectedId(id)
    setReplyOpen(false)
    setComposeOpen(false)
    setLoadingDetail(true)
    setDetail(null)
    try {
      const d = await window.kontur.mail.get(id)
      setDetail(d)
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, unread: false, state: 'прочитано' } : it))
      )
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const msg = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
      toast.error(msg)
      const fallback = items.find((i) => i.id === id)
      if (fallback) {
        setDetail({
          id: fallback.id,
          serviceId: fallback.serviceId,
          subject: fallback.title,
          from: fallback.author ?? '',
          to: '',
          cc: '',
          date: fallback.updatedAt,
          bodyText: fallback.body || 'Не удалось загрузить тело письма.',
          bodyHtml: null,
          unread: fallback.unread
        })
      }
    } finally {
      setLoadingDetail(false)
    }
  }

  // Клик по уведомлению / ленте: открыть конкретное письмо.
  useEffect(() => {
    if (!focusItemId) return
    // Письмо может лежать не во «Входящих» — переключаем папку, иначе в списке
    // слева его нет и кажется, что письма не существует.
    const target = items.find((it) => it.id === focusItemId)
    const folder = target?.folder ?? 'inbox'
    if (target && folder !== folderFilter) setFolderFilter(folder)
    void openMail(focusItemId).finally(() => onFocused?.())
    // openMail замыкается на items — достаточно реагировать на id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItemId])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    try {
      await window.kontur.items.syncNow()
      reload()
      reloadFolders()
      toast.success('Почта обновлена')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const selectFolder = (id: string): void => {
    setFolderFilter(id)
    setSelectedId(null)
    setDetail(null)
    setReplyOpen(false)
    setComposeOpen(false)
  }

  const createFolder = async (): Promise<void> => {
    if (!primaryMail || !newFolderName.trim()) return
    try {
      await window.kontur.mail.createFolder({
        serviceId: primaryMail.id,
        name: newFolderName.trim()
      })
      setCreateFolderOpen(false)
      setNewFolderName('')
      reloadFolders()
      toast.success('Папка создана')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const moveSelected = async (folderId: string): Promise<void> => {
    if (!selectedId) return
    try {
      await window.kontur.mail.move({ itemIds: [selectedId], folderId })
      setMoveOpen(false)
      setSelectedId(null)
      setDetail(null)
      reload()
      toast.success('Письмо перемещено')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const openRules = async (): Promise<void> => {
    setRulesOpen(true)
    if (!primaryMail || !rulesSupported) return
    setRulesLoading(true)
    try {
      setRules(await window.kontur.mail.listRules({ serviceId: primaryMail.id }))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      toast.error(raw.replace(/^Error invoking remote method '[^']+':\s*/i, ''))
    } finally {
      setRulesLoading(false)
    }
  }

  const folderLabel = (id: string): string => {
    if (id === 'inbox' || id === 'sent' || id === 'drafts') return FOLDER_LABEL[id]
    return mailboxes.find((m) => m.id === id)?.name ?? id
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold tracking-tight">Почта</h1>
          <p className="text-[11px] text-muted-foreground">
            {unify ? 'Оба контура в одном ящике' : 'По контурам'} · {filtered.length} писем
            {unreadCount > 0 ? ` · ${unreadCount} непрочит.` : ''}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void openRules()} disabled={!primaryMail}>
          <ListFilter />
          Правила
        </Button>
        <Button size="sm" variant="outline" onClick={() => void sync()} disabled={syncing}>
          <RefreshCw className={cn(syncing && 'animate-spin')} />
          Обновить
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setComposeOpen(true)
            setReplyOpen(false)
            setSelectedId(null)
            setDetail(null)
          }}
          disabled={mailServices.length === 0}
        >
          <PenSquare />
          Написать
        </Button>
      </div>

      {mailServices.length === 0 ? (
        <Empty text="Почта не настроена ни в одном контуре. Задайте протокол и адрес в настройках сервиса." />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar open={sidebarOpen} setOpen={setSidebarOpen}>
            <SidebarBody className="justify-between gap-6 border-r border-neutral-200 dark:border-neutral-700">
              <div className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto">
                <div className="mb-4 flex items-center gap-2 px-1">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <MailIcon className="size-3.5" />
                  </div>
                  {sidebarOpen ? (
                    <span className="text-[13px] font-semibold tracking-tight text-neutral-800 dark:text-neutral-100">
                      Папки
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1">
                  {sidebarFolders.system.map((folder) => {
                    const Icon = folder.role ? FOLDER_ICON[folder.role] : Folder
                    const key = folder.role ?? folder.id
                    const stats = folderStats[folder.role ?? folder.id] ?? { total: 0, unread: 0 }
                    const active =
                      folderFilter === folder.id ||
                      folderFilter === folder.role ||
                      (folder.role != null && folderFilter === folder.role)
                    const badge =
                      folder.role === 'inbox' ? stats.unread || undefined : stats.total || undefined
                    return (
                      <SidebarLink
                        key={key}
                        item={{
                          label: folder.name,
                          icon: (
                            <Icon className="size-5 shrink-0 text-neutral-700 dark:text-neutral-200" />
                          ),
                          active,
                          badge,
                          onClick: () => selectFolder(folder.role ?? folder.id)
                        }}
                      />
                    )
                  })}
                  {sidebarFolders.custom.length > 0 ? (
                    <div className="mt-3 mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                      Мои папки
                    </div>
                  ) : null}
                  {sidebarFolders.custom.map((folder) => {
                    const stats = folderStats[folder.id] ?? { total: 0, unread: 0 }
                    return (
                      <SidebarLink
                        key={folder.id}
                        item={{
                          label: folder.name,
                          icon: (
                            <Folder className="size-5 shrink-0 text-neutral-700 dark:text-neutral-200" />
                          ),
                          active: folderFilter === folder.id,
                          badge: stats.total || undefined,
                          onClick: () => selectFolder(folder.id)
                        }}
                      />
                    )
                  })}
                </div>
              </div>
              {sidebarOpen ? (
                <div className="space-y-2 px-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-full justify-start gap-1.5 px-2 text-[11px]"
                    disabled={!primaryMail}
                    onClick={() => setCreateFolderOpen(true)}
                  >
                    <FolderPlus className="size-3.5" />
                    Новая папка…
                  </Button>
                  <p className="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                    {folderLabel(folderFilter)} ·{' '}
                    {(folderStats[folderFilter] ?? folderStats['inbox'])?.total ?? 0}
                  </p>
                </div>
              ) : null}
            </SidebarBody>
          </Sidebar>

          <div className="flex w-[min(100%,clamp(280px,36vw,440px))] shrink-0 flex-col border-r">
            <div className="space-y-2 border-b p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute z-20 top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск по теме, отправителю…"
                  className="h-8 pl-8 text-[13px]"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <FilterChip active={readFilter === 'all'} onClick={() => setReadFilter('all')}>
                  Все
                </FilterChip>
                <FilterChip
                  active={readFilter === 'unread'}
                  onClick={() => setReadFilter(readFilter === 'unread' ? 'all' : 'unread')}
                >
                  Непрочитанные{unreadCount > 0 ? ` · ${unreadCount}` : ''}
                </FilterChip>
                <FilterChip
                  active={readFilter === 'read'}
                  onClick={() => setReadFilter(readFilter === 'read' ? 'all' : 'read')}
                >
                  Прочитанные
                </FilterChip>
                <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as DateFilter)}>
                  {/* h-7! — у базового триггера своя data-[size=sm]:h-8 той же
                      специфичности, обычный h-7 её не перебивает. Остальное —
                      ровно стиль неактивного FilterChip, чтобы выглядело той же
                      деталью управления, а не отдельным виджетом. */}
                  <SelectTrigger
                    size="sm"
                    className="h-7! ml-auto shrink-0 gap-1 rounded-md border-border bg-background px-2.5 py-0 text-[12px] font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-background dark:hover:bg-accent [&_svg]:size-3"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(DATE_FILTER_LABEL) as DateFilter[]).map((f) => (
                      <SelectItem key={f} value={f}>
                        {DATE_FILTER_LABEL[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              {pageItems.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  {items.length === 0 ? 'Писем пока нет — нажмите «Обновить».' : 'Ничего не найдено.'}
                </p>
              ) : (
                <div className="divide-y">
                  {pageItems.map((it) => {
                    const env = config?.envs.find((e) => e.id === it.envId)
                    const active = selectedId === it.id
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => void openMail(it.id)}
                        className={cn(
                          'grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-2 border-l-[3px] px-3 py-2.5 text-left transition-colors',
                          active ? 'bg-accent' : 'hover:bg-accent/50'
                        )}
                        style={{ borderLeftColor: env?.accent ?? 'transparent' }}
                      >
                        <div
                          className="mt-1.5 size-2 shrink-0 rounded-full"
                          style={{ background: it.unread ? env?.accent : 'transparent' }}
                        />
                        <div className="min-w-0 overflow-hidden">
                          <div
                            className={cn(
                              'truncate text-[13px]',
                              it.unread ? 'font-semibold text-foreground' : 'text-foreground/90'
                            )}
                          >
                            {it.author ?? 'без отправителя'}
                          </div>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={cn(
                                'truncate text-[13px]',
                                it.unread ? 'font-medium' : 'text-muted-foreground'
                              )}
                            >
                              {it.title}
                            </span>
                            {unify && env && (
                              <span
                                className="shrink-0 text-[10px] font-semibold"
                                style={{ color: env.accent }}
                              >
                                {env.short}
                              </span>
                            )}
                          </div>
                          {it.body ? (
                            <div className="mt-0.5 truncate text-[12px] text-muted-foreground/80">
                              {it.body}
                            </div>
                          ) : null}
                        </div>
                        <time
                          dateTime={
                            Number.isFinite(it.updatedAt) && it.updatedAt > 0
                              ? new Date(it.updatedAt).toISOString()
                              : undefined
                          }
                          className="mt-0.5 shrink-0 whitespace-nowrap text-right text-[11px] font-medium tabular-nums text-muted-foreground"
                          title={
                            Number.isFinite(it.updatedAt) && it.updatedAt > 0
                              ? new Date(it.updatedAt).toLocaleString('ru-RU')
                              : undefined
                          }
                        >
                          {formatWhen(it.updatedAt)}
                        </time>
                      </button>
                    )
                  })}
                </div>
              )}
            </ScrollArea>

            <div className="flex shrink-0 items-center justify-between border-t px-2 py-1.5">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={current <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {filtered.length === 0
                  ? '0'
                  : `${current * PAGE_SIZE + 1}–${Math.min((current + 1) * PAGE_SIZE, filtered.length)}`}{' '}
                из {filtered.length}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={current >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {composeOpen ? (
              <ComposePane
                services={mailServices.map((s) => ({
                  id: s.id,
                  label: `${config?.envs.find((e) => e.id === s.envId)?.short ?? ''} · ${s.name}`.replace(
                    /^ · /,
                    ''
                  )
                }))}
                onClose={() => setComposeOpen(false)}
                sending={sending}
                setSending={setSending}
              />
            ) : !selectedId ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                <MailIcon className="size-8 opacity-40" />
                <p className="text-[13px]">Выберите письмо</p>
              </div>
            ) : loadingDetail ? (
              <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                Загрузка…
              </div>
            ) : detail ? (
              <>
                <div className="shrink-0 border-b px-5 py-3">
                  <div className="flex items-start gap-3">
                    <h2 className="min-w-0 flex-1 text-[17px] leading-snug font-semibold">
                      {detail.subject}
                    </h2>
                    <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
                      <FolderInput />
                      Переместить
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setReplyOpen((v) => !v)}>
                      <Reply />
                      Ответить
                    </Button>
                  </div>
                  <div className="mt-2 space-y-0.5 text-[13px]">
                    <div>
                      <span className="text-muted-foreground">От: </span>
                      {detail.from || '—'}
                    </div>
                    {detail.to ? (
                      <div>
                        <span className="text-muted-foreground">Кому: </span>
                        {detail.to}
                      </div>
                    ) : null}
                    {detail.cc ? (
                      <div>
                        <span className="text-muted-foreground">Копия: </span>
                        {detail.cc}
                      </div>
                    ) : null}
                    <div className="text-[12px] text-muted-foreground">
                      {new Date(detail.date).toLocaleString('ru-RU')}
                    </div>
                  </div>
                </div>

                {replyOpen && (
                  <ReplyPane
                    detail={detail}
                    sending={sending}
                    setSending={setSending}
                    onSent={() => {
                      setReplyOpen(false)
                      toast.success('Ответ отправлен')
                    }}
                    onClose={() => setReplyOpen(false)}
                  />
                )}

                <ScrollArea className="min-h-0 flex-1">
                  <div className="px-5 py-4">
                    {detail.bodyHtml ? (
                      <HtmlWithExternalLinks
                        html={sanitizeHtml(detail.bodyHtml)}
                        className="mail-html prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed [&_a]:text-primary [&_a]:underline"
                      />
                    ) : (
                      <pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
                        <LinkifiedText text={detail.bodyText} />
                      </pre>
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : null}
          </div>
        </div>
      )}

      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Новая папка</DialogTitle>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Название"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createFolder()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
              Отмена
            </Button>
            <Button onClick={() => void createFolder()} disabled={!newFolderName.trim()}>
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Переместить в…</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {sidebarFolders.system.map((f) => (
              <Button
                key={f.role ?? f.id}
                variant="ghost"
                className="justify-start"
                onClick={() => void moveSelected(f.role ?? f.id)}
              >
                {f.name}
              </Button>
            ))}
            {sidebarFolders.custom.map((f) => (
              <Button
                key={f.id}
                variant="ghost"
                className="justify-start"
                onClick={() => void moveSelected(f.id)}
              >
                {f.name}
              </Button>
            ))}
            {sidebarFolders.custom.length === 0 && mailboxes.length === 0 ? (
              <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
                Папки ещё не загружены. Обновите почту.
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <RulesDialog
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        supported={rulesSupported}
        loading={rulesLoading}
        rules={rules}
        serviceId={primaryMail?.id}
        onReload={async () => {
          if (!primaryMail) return
          setRules(await window.kontur.mail.listRules({ serviceId: primaryMail.id }))
        }}
      />
    </div>
  )
}

function RulesDialog({
  open,
  onOpenChange,
  supported,
  loading,
  rules,
  serviceId,
  onReload
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  supported: boolean
  loading: boolean
  rules: MailRule[]
  serviceId?: string
  onReload: () => Promise<void>
}): JSX.Element {
  const [name, setName] = useState('')
  const [fromContains, setFromContains] = useState('')
  const [subjectContains, setSubjectContains] = useState('')
  const [moveTo, setMoveTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [ruleFolders, setRuleFolders] = useState<MailMailbox[]>([])

  // Папки — после списка правил, не параллельно: два EWS сразу через VPN
  // часто дают SocketError «other side closed».
  useEffect(() => {
    if (!open || !supported || !serviceId) {
      setRuleFolders([])
      return
    }
    if (loading) return
    let cancelled = false
    void window.kontur.mail
      .listFoldersForRules({ serviceId })
      .then((folders) => {
        if (!cancelled) setRuleFolders(folders)
      })
      .catch(() => {
        if (!cancelled) setRuleFolders([])
      })
    return () => {
      cancelled = true
    }
  }, [open, supported, serviceId, loading])

  const ipcErr = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e)
    return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  }

  const create = async (): Promise<void> => {
    if (!serviceId || !name.trim()) return
    if (!fromContains.trim() && !subjectContains.trim()) {
      toast.error('Укажите условие (от кого или тема)')
      return
    }
    if (!moveTo) {
      toast.error('Укажите папку назначения')
      return
    }
    setSaving(true)
    try {
      await window.kontur.mail.upsertRule({
        serviceId,
        rule: {
          name: name.trim(),
          enabled: true,
          conditions: {
            fromContains: fromContains.trim() || undefined,
            subjectContains: subjectContains.trim() || undefined
          },
          actions: { moveToFolder: moveTo }
        }
      })
      setName('')
      setFromContains('')
      setSubjectContains('')
      setMoveTo('')
      try {
        await onReload()
      } catch (e) {
        toast.message('Правило создано, но список не обновился', { description: ipcErr(e) })
        return
      }
      toast.success('Правило создано')
    } catch (e) {
      toast.error(ipcErr(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Правила входящих</DialogTitle>
        </DialogHeader>
        {!supported ? (
          <p className="text-[13px] text-muted-foreground">
            Правила доступны только через EWS. Укажите ewsUrl (или webUrl) в настройках почты.
          </p>
        ) : loading ? (
          <p className="text-[13px] text-muted-foreground">Загрузка…</p>
        ) : (
          <div className="space-y-4">
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {rules.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Правил пока нет.</p>
              ) : (
                rules.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{r.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[
                          r.conditions.fromContains && `от: ${r.conditions.fromContains}`,
                          r.conditions.subjectContains && `тема: ${r.conditions.subjectContains}`,
                          r.actions.moveToFolder && '→ папка'
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!serviceId) return
                        void window.kontur.mail
                          .setRuleEnabled({
                            serviceId,
                            ruleId: r.id,
                            enabled: !r.enabled
                          })
                          .then(onReload)
                          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      {r.enabled ? 'Выкл' : 'Вкл'}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => {
                        if (!serviceId) return
                        void window.kontur.mail
                          .deleteRule({ serviceId, ruleId: r.id })
                          .then(onReload)
                          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-2 border-t pt-3">
              <div className="text-[12px] font-medium">Новое правило</div>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Название"
                className="h-8 text-[13px]"
              />
              <Input
                value={fromContains}
                onChange={(e) => setFromContains(e.target.value)}
                placeholder="От кого содержит…"
                className="h-8 text-[13px]"
              />
              <Input
                value={subjectContains}
                onChange={(e) => setSubjectContains(e.target.value)}
                placeholder="Тема содержит…"
                className="h-8 text-[13px]"
              />
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger size="sm" className="h-8 text-[13px]">
                  <SelectValue placeholder="Переместить в…" />
                </SelectTrigger>
                <SelectContent>
                  {ruleFolders.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                      {m.role ? ` (${FOLDER_LABEL[m.role]})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={() => void create()} disabled={saving || !serviceId}>
                Создать правило
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ReplyPane({
  detail,
  sending,
  setSending,
  onSent,
  onClose
}: {
  detail: MailDetail
  sending: boolean
  setSending: (v: boolean) => void
  onSent: () => void
  onClose: () => void
}): JSX.Element {
  const [body, setBody] = useState('')
  const to = extractEmail(detail.from)
  const subject = detail.subject.replace(/^(Re:\s*)+/i, '')
  const reSubject = `Re: ${subject}`

  const send = async (): Promise<void> => {
    if (!body.trim()) {
      toast.error('Напишите текст ответа')
      return
    }
    setSending(true)
    try {
      await window.kontur.mail.send({
        serviceId: detail.serviceId,
        to,
        subject: reSubject,
        body: body.trim(),
        replyToId: detail.id
      })
      onSent()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 border-b bg-muted/30 px-5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium">Ответ → {to || detail.from}</span>
        <Button size="icon-xs" variant="ghost" onClick={onClose}>
          <X />
        </Button>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Текст ответа…"
        className="min-h-24 text-[13px]"
        autoFocus
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={() => void send()} disabled={sending}>
          <Send />
          {sending ? 'Отправка…' : 'Отправить'}
        </Button>
      </div>
    </div>
  )
}

function ComposePane({
  services,
  onClose,
  sending,
  setSending
}: {
  services: { id: string; label: string }[]
  onClose: () => void
  sending: boolean
  setSending: (v: boolean) => void
}): JSX.Element {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const send = async (): Promise<void> => {
    if (!to.trim()) {
      toast.error('Укажите получателя')
      return
    }
    setSending(true)
    try {
      await window.kontur.mail.send({
        serviceId,
        to: to.trim(),
        cc: cc.trim() || undefined,
        subject: subject.trim() || '(без темы)',
        body: body
      })
      toast.success('Письмо отправлено')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-[15px] font-semibold">Новое письмо</h2>
        <Button size="icon-sm" variant="ghost" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="space-y-2 border-b px-5 py-3">
        {services.length > 1 && (
          <label className="flex items-center gap-2 text-[12px]">
            <span className="w-14 shrink-0 text-muted-foreground">Из</span>
            <Select value={serviceId} onValueChange={setServiceId}>
              <SelectTrigger size="sm" className="h-8 flex-1 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        <label className="flex items-center gap-2 text-[12px]">
          <span className="w-14 shrink-0 text-muted-foreground">Кому</span>
          <RecipientInput
            value={to}
            onChange={setTo}
            className="h-8 text-[13px]"
            placeholder="Имя или адрес — подскажем из почты и адресной книги"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span className="w-14 shrink-0 text-muted-foreground">Копия</span>
          <RecipientInput value={cc} onChange={setCc} className="h-8 text-[13px]" />
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span className="w-14 shrink-0 text-muted-foreground">Тема</span>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="h-8 text-[13px]"
          />
        </label>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Текст письма…"
        className="min-h-0 flex-1 resize-none rounded-none border-0 text-[13px] focus-visible:ring-0"
      />
      <div className="flex justify-end border-t px-5 py-2.5">
        <Button size="sm" onClick={() => void send()} disabled={sending}>
          <Send />
          {sending ? 'Отправка…' : 'Отправить'}
        </Button>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
      <MailIcon className="size-6 text-muted-foreground" />
      <p className="max-w-md text-[13px] text-muted-foreground/80">{text}</p>
    </div>
  )
}

/** Минимальная санитизация HTML письма: убираем скрипты и обработчики. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '')
}
