import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  NotebookPen,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { NoteDoc, NoteRef, VaultNode } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { NoteEditor } from '@/components/NoteEditor'
import { NotePreview } from '@/components/NotePreview'
import { ConfirmDialog, TextPromptDialog } from '@/components/prompts'
import { cn } from '@/lib/utils'

const AUTOSAVE_MS = 600

function TreeView({
  nodes,
  depth,
  current,
  onOpen
}: {
  nodes: VaultNode[]
  depth: number
  current: string | null
  onOpen: (path: string) => void
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <>
      {nodes.map((n) =>
        n.kind === 'folder' ? (
          <div key={n.path}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [n.path]: !c[n.path] }))}
              style={{ paddingLeft: 8 + depth * 12 }}
              className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {collapsed[n.path] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
              <span className="truncate">{n.name}</span>
            </button>
            {!collapsed[n.path] && n.children?.length ? (
              <TreeView nodes={n.children} depth={depth + 1} current={current} onOpen={onOpen} />
            ) : null}
          </div>
        ) : (
          <button
            key={n.path}
            type="button"
            onClick={() => onOpen(n.path)}
            style={{ paddingLeft: 8 + depth * 12 + 18 }}
            className={cn(
              'flex w-full items-center rounded-md py-1 pr-2 text-left text-[13px] transition-colors',
              current === n.path
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <span className="truncate">{n.name}</span>
          </button>
        )
      )}
    </>
  )
}

export function Notes(): JSX.Element {
  const [tree, setTree] = useState<VaultNode[]>([])
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [backlinks, setBacklinks] = useState<NoteRef[]>([])
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  /** false = отрисованный markdown, true = исходник в CodeMirror. */
  const [editing, setEditing] = useState(false)
  const [previewContent, setPreviewContent] = useState('')
  const [dialog, setDialog] = useState<null | 'note' | 'folder' | 'rename' | 'delete' | { link: string }>(null)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const docRef = useRef<NoteDoc | null>(null)
  docRef.current = doc

  const reloadTree = useCallback(async (): Promise<VaultNode[]> => {
    const t = await window.kontur.notes.tree()
    setTree(t)
    return t
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d || pending.current === null) return
    const content = pending.current
    await window.kontur.notes.write(d.path, content)
    pending.current = null
    setPreviewContent(content)
    setDoc((prev) => (prev ? { ...prev, content } : prev))
    setDirty(false)
    setSaved(true)
  }, [])

  const open = useCallback(
    async (path: string): Promise<void> => {
      await flush()
      const d = await window.kontur.notes.read(path)
      setDoc(d)
      setPreviewContent(d.content)
      setEditing(false)
      setDirty(false)
      setSaved(false)
      setBacklinks(await window.kontur.notes.backlinks(path))
    },
    [flush]
  )

  useEffect(() => {
    void (async () => {
      const t = await reloadTree()
      const requested = sessionStorage.getItem('kontur:openNote')
      sessionStorage.removeItem('kontur:openNote')
      if (requested) return open(requested)
      const first = (function findFirst(nodes: VaultNode[]): VaultNode | null {
        for (const n of nodes) {
          if (n.kind === 'note') return n
          const inner = n.children ? findFirst(n.children) : null
          if (inner) return inner
        }
        return null
      })(t)
      if (first) await open(first.path)
    })()
  }, [open, reloadTree])

  const onChange = (value: string): void => {
    pending.current = value
    setDirty(true)
    setSaved(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }

  useEffect(() => () => void flush(), [flush])

  // Esc в режиме правки → сохранить и показать превью.
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      void (async () => {
        if (timer.current) clearTimeout(timer.current)
        await flush()
        setEditing(false)
      })()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, flush])

  const finishEdit = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    await flush()
    setEditing(false)
  }

  const createNote = async (name: string, thenOpen = true): Promise<void> => {
    try {
      const ref = await window.kontur.notes.create(name)
      await reloadTree()
      if (thenOpen) {
        await open(ref.path)
        setEditing(true)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const rename = async (next: string): Promise<void> => {
    if (!doc) return
    await flush()
    const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/') + 1) : ''
    const ref = await window.kontur.notes.rename(doc.path, `${dir}${next}`)
    await reloadTree()
    await open(ref.path)
  }

  const remove = async (): Promise<void> => {
    if (!doc) return
    // Сначала гасим автосейв — иначе flush после rm снова создаст файл.
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
    const path = doc.path
    setDoc(null)
    setPreviewContent('')
    setEditing(false)
    setDirty(false)
    setSaved(false)
    await window.kontur.notes.remove(path)
    await reloadTree()
    toast.success('Заметка удалена')
  }

  const followLink = async (title: string): Promise<void> => {
    const path = await window.kontur.notes.resolveLink(title)
    if (path) return open(path)
    setDialog({ link: title })
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex shrink-0 items-center gap-1 border-b p-2">
          <Button size="sm" variant="ghost" onClick={() => setDialog('note')}>
            <Plus /> Заметка
          </Button>
          <Button size="icon-sm" variant="ghost" title="Новая папка" onClick={() => setDialog('folder')}>
            <FolderPlus />
          </Button>
          <span className="flex-1" />
          <Button
            size="icon-sm"
            variant="ghost"
            title="Открыть папку хранилища"
            onClick={() => void window.kontur.notes.revealVault()}
          >
            <ExternalLink />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {tree.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Хранилище пустое</p>
            ) : (
              <TreeView nodes={tree} depth={0} current={doc?.path ?? null} onOpen={(p) => void open(p)} />
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {doc ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              <div className="flex min-w-0 flex-1 items-center gap-0.5">
                <h2 className="min-w-0 truncate text-base font-semibold tracking-tight">{doc.title}</h2>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="Переименовать"
                  onClick={() => setDialog('rename')}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {dirty ? 'сохраняем…' : saved ? 'сохранено' : ''}
              </span>
              {editing ? (
                <Button size="sm" variant="outline" onClick={() => void finishEdit()}>
                  <Check className="size-3.5" />
                  Готово
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Редактировать
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" title="Удалить" onClick={() => setDialog('delete')}>
                <Trash2 />
              </Button>
            </div>
            {editing ? (
              <NoteEditor
                path={doc.path}
                initial={pending.current ?? previewContent}
                onChange={onChange}
                onFollowLink={(t) => void followLink(t)}
              />
            ) : (
              <NotePreview
                content={previewContent}
                onFollowLink={(t) => void followLink(t)}
                onEdit={() => setEditing(true)}
              />
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <NotebookPen className="size-6 text-muted-foreground" />
            <p className="font-medium text-muted-foreground">Заметка не выбрана</p>
            <p className="max-w-sm text-[13px] text-muted-foreground/80">
              Хранилище — обычная папка с markdown-файлами. Ссылки между заметками пишутся как
              [[название]].
            </p>
          </div>
        )}
      </div>

      {doc && (
        <ScrollArea className="w-60 shrink-0 border-l bg-sidebar">
          <div className="p-3">
            <h3 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Ссылаются сюда
            </h3>
            {backlinks.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">Пока никто</p>
            ) : (
              backlinks.map((b) => (
                <button
                  key={b.path}
                  type="button"
                  onClick={() => void open(b.path)}
                  className="flex w-full rounded-md px-2 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <span className="truncate">{b.title}</span>
                </button>
              ))
            )}

            {doc.links.length > 0 && (
              <>
                <h3 className="mt-5 mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Ссылки отсюда
                </h3>
                {doc.links.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => void followLink(l)}
                    className="flex w-full rounded-md px-2 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <span className="truncate">{l}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      )}

      <TextPromptDialog
        open={dialog === 'note'}
        title="Новая заметка"
        label="Название"
        onConfirm={(v) => void createNote(v)}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      <TextPromptDialog
        open={dialog === 'folder'}
        title="Новая папка"
        label="Название"
        onConfirm={(v) => void window.kontur.notes.createFolder(v).then(reloadTree)}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      <TextPromptDialog
        open={dialog === 'rename'}
        title="Переименовать заметку"
        label="Название"
        defaultValue={doc?.title ?? ''}
        confirmLabel="Переименовать"
        onConfirm={(v) => void rename(v)}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Удалить «${doc?.title ?? ''}»?`}
        onConfirm={() => void remove()}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        Файл будет удалён с диска. Это действие нельзя отменить.
      </ConfirmDialog>
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog !== null}
        title={`Заметки «${typeof dialog === 'object' && dialog ? dialog.link : ''}» ещё нет`}
        confirmLabel="Создать"
        destructive={false}
        onConfirm={() => {
          if (typeof dialog === 'object' && dialog) void createNote(dialog.link)
        }}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        Создать её сейчас и перейти?
      </ConfirmDialog>
    </div>
  )
}
