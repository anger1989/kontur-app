import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Pencil,
  RefreshCw,
  Trash2,
  ExternalLink,
  Eye
} from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { FsEntry, FsFavorite } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ConfirmDialog, TextPromptDialog } from '@/components/prompts'
import { cn } from '@/lib/utils'

function formatSize(n: number): string {
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} МБ`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} ГБ`
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function breadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const p of parts) {
    acc += `/${p}`
    crumbs.push({ label: p, path: acc })
  }
  return crumbs
}

export function Files(): JSX.Element {
  const [favorites, setFavorites] = useState<FsFavorite[]>([])
  const [cwd, setCwd] = useState<string>('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const histRef = useRef({ stack: [] as string[], idx: -1 })
  histRef.current = { stack: history, idx: histIdx }
  const [dialog, setDialog] = useState<null | 'mkdir' | 'rename' | 'trash'>(null)

  const navigate = useCallback(async (dir: string): Promise<void> => {
    setBusy(true)
    try {
      const list = await window.kontur.fs.list(dir)
      setEntries(list)
      setCwd(dir)
      setSelected(new Set())
      const { stack, idx } = histRef.current
      const cut = stack.slice(0, Math.max(0, idx + 1))
      if (cut[cut.length - 1] === dir) {
        setHistory(cut)
        setHistIdx(cut.length - 1)
      } else {
        const next = [...cut, dir]
        setHistory(next)
        setHistIdx(next.length - 1)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const goHistory = useCallback(async (delta: -1 | 1): Promise<void> => {
    const { stack, idx } = histRef.current
    const next = idx + delta
    if (next < 0 || next >= stack.length) return
    const dir = stack[next]!
    setBusy(true)
    try {
      const list = await window.kontur.fs.list(dir)
      setEntries(list)
      setCwd(dir)
      setSelected(new Set())
      setHistIdx(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!cwd) return
    setBusy(true)
    try {
      setEntries(await window.kontur.fs.list(cwd))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [cwd])

  useEffect(() => {
    void (async () => {
      setFavorites(await window.kontur.fs.favorites())
      const home = await window.kontur.fs.home()
      setHistory([home])
      setHistIdx(0)
      setBusy(true)
      try {
        setEntries(await window.kontur.fs.list(home))
        setCwd(home)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }, [])

  const crumbs = useMemo(() => (cwd ? breadcrumbs(cwd) : []), [cwd])
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected]
  )
  const primary = selectedEntries[0] ?? null

  const toggleSelect = (path: string, multi: boolean): void => {
    setSelected((prev) => {
      if (!multi) return new Set([path])
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openEntry = async (e: FsEntry): Promise<void> => {
    if (e.kind === 'dir') {
      await navigate(e.path)
      return
    }
    try {
      await window.kontur.fs.open(e.path)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const onDragStart = (e: DragEvent, entry: FsEntry): void => {
    e.preventDefault()
    const paths =
      selected.has(entry.path) && selected.size > 1 ? [...selected] : [entry.path]
    window.kontur.fs.startDrag(paths)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && primary) void openEntry(primary)
    if (e.key === 'Backspace' && (e.metaKey || e.altKey)) {
      const parent = cwd.split('/').slice(0, -1).join('/') || '/'
      void navigate(parent)
    }
    if ((e.key === 'Delete' || (e.key === 'Backspace' && !e.metaKey && !e.altKey)) && primary) {
      setDialog('trash')
    }
  }

  return (
    <div className="flex h-full min-h-0 outline-none" tabIndex={0} onKeyDown={onKeyDown}>
      <aside className="flex w-48 shrink-0 flex-col border-r bg-muted/20">
        <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Избранное
        </p>
        <ScrollArea className="flex-1 px-1.5 pb-3">
          {favorites.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => void navigate(f.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                cwd === f.path
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {f.id === 'home' ? (
                <Home className="size-3.5 shrink-0" />
              ) : (
                <Folder className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{f.label}</span>
            </button>
          ))}
        </ScrollArea>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={histIdx <= 0}
            title="Назад"
            onClick={() => void goHistory(-1)}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={histIdx >= history.length - 1}
            title="Вперёд"
            onClick={() => void goHistory(1)}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Обновить"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
          </Button>

          <div className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md bg-muted/40 px-1.5 py-1 text-[12px]">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                {i > 0 && <span className="text-muted-foreground/50">/</span>}
                <button
                  type="button"
                  className={cn(
                    'rounded px-1 hover:bg-accent',
                    i === crumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'
                  )}
                  onClick={() => void navigate(c.path)}
                >
                  {c.label === '/' ? 'Macintosh HD' : c.label}
                </button>
              </span>
            ))}
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[12px]"
            onClick={() => {
              void window.kontur.fs.pickFolder().then((p) => {
                if (p) void navigate(p)
              })
            }}
          >
            <FolderOpen className="size-3.5" />
            Открыть…
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" title="Новая папка" onClick={() => setDialog('mkdir')}>
            <FolderPlus className="size-3.5" />
          </Button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_88px_148px] gap-2 border-b px-3 py-1 text-[11px] font-medium text-muted-foreground">
          <span>Имя</span>
          <span className="text-right">Размер</span>
          <span className="text-right">Изменён</span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-1 py-1">
            {entries.map((e) => {
              const isSel = selected.has(e.path)
              return (
                <div
                  key={e.path}
                  draggable
                  onDragStart={(ev) => onDragStart(ev, e)}
                  onClick={(ev) => toggleSelect(e.path, ev.metaKey || ev.shiftKey)}
                  onDoubleClick={() => void openEntry(e)}
                  className={cn(
                    'grid cursor-default grid-cols-[minmax(0,1fr)_88px_148px] items-center gap-2 rounded-md px-2 py-1 text-[13px] select-none',
                    isSel ? 'bg-primary/15 text-foreground' : 'hover:bg-accent/60'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {e.kind === 'dir' ? (
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </span>
                  <span className="text-right text-[12px] text-muted-foreground tabular-nums">
                    {e.kind === 'dir' ? '—' : formatSize(e.size)}
                  </span>
                  <span className="text-right text-[12px] text-muted-foreground tabular-nums">
                    {formatDate(e.mtime)}
                  </span>
                </div>
              )
            })}
            {!entries.length && !busy && (
              <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">Папка пуста</p>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center gap-1 border-t px-2 py-1.5">
          <span className="flex-1 truncate px-1 text-[11px] text-muted-foreground">
            {selected.size
              ? `Выбрано: ${selected.size}`
              : `${entries.filter((e) => e.kind === 'dir').length} папок · ${entries.filter((e) => e.kind === 'file').length} файлов`}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!primary}
            title="Открыть"
            onClick={() => primary && void openEntry(primary)}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!primary}
            title="Показать в Finder"
            onClick={() => primary && void window.kontur.fs.reveal(primary.path)}
          >
            <Eye className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!primary}
            title="Переименовать"
            onClick={() => setDialog('rename')}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!selected.size}
            title="В корзину"
            onClick={() => setDialog('trash')}
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[12px]"
            disabled={!primary}
            onClick={() => {
              if (!primary) return
              void navigator.clipboard.writeText(primary.path).then(
                () => toast.success('Путь скопирован'),
                () => toast.error('Не удалось скопировать')
              )
            }}
          >
            Копировать путь
          </Button>
        </div>
      </div>

      <TextPromptDialog
        open={dialog === 'mkdir'}
        title="Новая папка"
        label="Имя"
        confirmLabel="Создать"
        onOpenChange={(o) => !o && setDialog(null)}
        onConfirm={(name) => {
          void (async () => {
            try {
              await window.kontur.fs.mkdir(cwd, name)
              await refresh()
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          })()
        }}
      />
      <TextPromptDialog
        open={dialog === 'rename'}
        title="Переименовать"
        label="Новое имя"
        defaultValue={primary?.name ?? ''}
        confirmLabel="Сохранить"
        onOpenChange={(o) => !o && setDialog(null)}
        onConfirm={(name) => {
          if (!primary) return
          void (async () => {
            try {
              await window.kontur.fs.rename(primary.path, name)
              await refresh()
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          })()
        }}
      />
      <ConfirmDialog
        open={dialog === 'trash'}
        title="Удалить в корзину?"
        confirmLabel="В корзину"
        onOpenChange={(o) => !o && setDialog(null)}
        onConfirm={() => {
          void (async () => {
            try {
              for (const p of selected) await window.kontur.fs.trash(p)
              await refresh()
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          })()
        }}
      >
        {selected.size === 1
          ? `«${primary?.name}» будет перемещён в корзину.`
          : `${selected.size} объектов будут перемещены в корзину.`}
      </ConfirmDialog>
    </div>
  )
}
