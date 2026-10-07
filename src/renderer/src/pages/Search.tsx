import { useEffect, useState, type JSX } from 'react'
import { NotebookPen, Search as SearchIcon } from 'lucide-react'
import type { Item, NoteSearchHit } from '@shared/types'
import { useStore } from '@/store'
import { Input } from '@/components/ui/input'

/**
 * Сквозной поиск: задачи, переписка и заметки обоих контуров в одном списке.
 * Это та функция, которой нет ни в одном из исходных сервисов.
 */
export function Search(): JSX.Element {
  const { config, openWindow, openItem } = useStore()
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [notes, setNotes] = useState<NoteSearchHit[]>([])

  useEffect(() => {
    if (!q.trim()) {
      setItems([])
      setNotes([])
      return
    }
    const t = setTimeout(() => {
      void window.kontur.items.search(q).then(setItems)
      void window.kontur.notes.search(q).then(setNotes)
    }, 140)
    return () => clearTimeout(t)
  }, [q])

  const openNote = (path: string): void => {
    sessionStorage.setItem('kontur:openNote', path)
    openWindow({ kind: 'page', page: 'notes' })
  }

  return (
    <div className="w-full px-4 pt-5 pb-16 sm:px-6 lg:px-8">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Поиск по всему</h1>
      <p className="mt-1 mb-6 text-muted-foreground">Оба контура и хранилище заметок сразу.</p>

      <div className="relative mb-8">
        <SearchIcon className="pointer-events-none absolute z-20 top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          className="pl-9"
          placeholder="Задача, обсуждение, страница, заметка…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {q.trim() && !items.length && !notes.length && (
        <p className="py-10 text-center text-[13px] text-muted-foreground">
          Ничего не найдено. Индекс рабочих элементов наполняется по мере синхронизации сервисов —
          заметки ищутся сразу.
        </p>
      )}

      {notes.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            <NotebookPen className="size-3.5" /> Заметки · {notes.length}
          </h2>
          <div className="space-y-px">
            {notes.map((n) => (
              <button
                key={n.path}
                type="button"
                onClick={() => openNote(n.path)}
                className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent"
              >
                <span className="text-[13px] font-medium">{n.title}</span>
                <span className="truncate text-xs text-muted-foreground">{n.excerpt}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {items.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Рабочие элементы · {items.length}
          </h2>
          <div className="space-y-px">
            {items.map((it) => {
              const env = config?.envs.find((e) => e.id === it.envId)
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => openItem(it)}
                  className="flex w-full flex-col gap-0.5 rounded-md border-l-[3px] px-3 py-2.5 text-left transition-colors hover:bg-accent"
                  style={{ borderLeftColor: env?.accent }}
                >
                  <span className="text-[13px] font-medium">{it.title}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span style={{ color: env?.accent }}>{env?.short}</span>
                    <span>{it.kind}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
