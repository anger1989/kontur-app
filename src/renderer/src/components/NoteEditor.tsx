import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
  Brackets
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Подсветка отдаёт классы, а не цвета: раскрашивает их app.css,
 * поэтому редактор переключает тему вместе со всем приложением
 * и не требует пересоздания.
 */
const highlight = HighlightStyle.define([
  { tag: t.heading, class: 'tok-heading' },
  { tag: t.heading1, class: 'tok-heading' },
  { tag: t.heading2, class: 'tok-heading' },
  { tag: t.heading3, class: 'tok-heading' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-link' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.processingInstruction, class: 'tok-meta' },
  { tag: t.quote, class: 'tok-meta' }
])

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

/** Вики-ссылка под курсором мыши, если клик пришёлся внутрь [[…]]. */
function wikilinkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos)
  const offset = pos - line.from
  for (const m of line.text.matchAll(WIKILINK)) {
    const start = m.index ?? 0
    if (offset >= start && offset <= start + m[0].length) return m[1].trim()
  }
  return null
}

function run(view: EditorView | null, spec: TransactionSpec): boolean {
  if (!view) return false
  view.dispatch(spec)
  view.focus()
  return true
}

/** Обернуть выделение (или вставить плейсхолдер) маркерами markdown. */
function wrapMarks(view: EditorView | null, before: string, after: string, placeholder: string): boolean {
  if (!view) return false
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const inner = selected || placeholder
  const insert = before + inner + after
  return run(view, {
    changes: { from, to, insert },
    selection: selected
      ? { anchor: from, head: from + insert.length }
      : { anchor: from + before.length, head: from + before.length + inner.length }
  })
}

/** Переключить префикс у каждой строки выделения (списки, цитата). */
function toggleLinePrefix(view: EditorView | null, prefix: string): boolean {
  if (!view) return false
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const endLine = view.state.doc.lineAt(to)
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  let allHave = true
  for (let n = startLine.number; n <= endLine.number; n++) {
    if (!re.test(view.state.doc.line(n).text)) {
      allHave = false
      break
    }
  }
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n)
    if (allHave) {
      const m = line.text.match(re)
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' })
    } else if (!re.test(line.text)) {
      changes.push({ from: line.from, to: line.from, insert: prefix })
    }
  }
  return run(view, { changes })
}

/** Заголовок H1–H3: заменить/снять `#` в начале строки. */
function setHeading(view: EditorView | null, level: 1 | 2 | 3): boolean {
  if (!view) return false
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const marks = '#'.repeat(level) + ' '
  const stripped = line.text.replace(/^#{1,6}\s+/, '')
  const already = line.text.startsWith(marks) && !line.text.startsWith(marks + '#')
  const insert = already ? stripped : marks + stripped
  return run(view, {
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length }
  })
}

function insertBlock(view: EditorView | null, block: string): boolean {
  if (!view) return false
  const { from, to } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const atLineStart = from === line.from
  const prefix = atLineStart ? '' : '\n\n'
  const insert = prefix + block
  const hasX = block.includes('x')
  const xAt = block.indexOf('x')
  return run(view, {
    changes: { from, to, insert },
    selection: hasX
      ? { anchor: from + prefix.length + xAt, head: from + prefix.length + xAt + 1 }
      : { anchor: from + insert.length }
  })
}

function ToolBtn({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      title={title}
      className="text-muted-foreground hover:text-foreground"
      // Не забирать фокус у CodeMirror — иначе выделение сбрасывается.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function Sep(): JSX.Element {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
}

function NoteToolbar({ viewRef }: { viewRef: RefObject<EditorView | null> }): JSX.Element {
  const v = (): EditorView | null => viewRef.current

  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-0.5 border-b bg-muted/30 px-2 py-1'
      )}
    >
      <ToolBtn title="Отменить ⌘Z" onClick={() => v() && undo(v()!)}>
        <Undo2 />
      </ToolBtn>
      <ToolBtn title="Повторить ⌘⇧Z" onClick={() => v() && redo(v()!)}>
        <Redo2 />
      </ToolBtn>
      <Sep />
      <ToolBtn title="Жирный ⌘B" onClick={() => wrapMarks(v(), '**', '**', 'текст')}>
        <Bold />
      </ToolBtn>
      <ToolBtn title="Курсив ⌘I" onClick={() => wrapMarks(v(), '*', '*', 'текст')}>
        <Italic />
      </ToolBtn>
      <ToolBtn title="Зачёркнутый" onClick={() => wrapMarks(v(), '~~', '~~', 'текст')}>
        <Strikethrough />
      </ToolBtn>
      <ToolBtn title="Код" onClick={() => wrapMarks(v(), '`', '`', 'код')}>
        <Code />
      </ToolBtn>
      <Sep />
      <ToolBtn title="Заголовок 1" onClick={() => setHeading(v(), 1)}>
        <Heading1 />
      </ToolBtn>
      <ToolBtn title="Заголовок 2" onClick={() => setHeading(v(), 2)}>
        <Heading2 />
      </ToolBtn>
      <ToolBtn title="Заголовок 3" onClick={() => setHeading(v(), 3)}>
        <Heading3 />
      </ToolBtn>
      <Sep />
      <ToolBtn title="Маркированный список" onClick={() => toggleLinePrefix(v(), '- ')}>
        <List />
      </ToolBtn>
      <ToolBtn title="Нумерованный список" onClick={() => toggleLinePrefix(v(), '1. ')}>
        <ListOrdered />
      </ToolBtn>
      <ToolBtn title="Чеклист" onClick={() => toggleLinePrefix(v(), '- [ ] ')}>
        <ListTodo />
      </ToolBtn>
      <ToolBtn title="Цитата" onClick={() => toggleLinePrefix(v(), '> ')}>
        <Quote />
      </ToolBtn>
      <Sep />
      <ToolBtn
        title="Ссылка"
        onClick={() => {
          const view = v()
          if (!view) return
          const { from, to } = view.state.selection.main
          const selected = view.state.sliceDoc(from, to) || 'текст'
          const insert = `[${selected}](url)`
          run(view, {
            changes: { from, to, insert },
            selection: {
              anchor: from + selected.length + 3,
              head: from + insert.length - 1
            }
          })
        }}
      >
        <Link2 />
      </ToolBtn>
      <ToolBtn
        title="Вики-ссылка [[…]]"
        onClick={() => wrapMarks(v(), '[[', ']]', 'заметка')}
      >
        <Brackets />
      </ToolBtn>
      <ToolBtn
        title="Таблица"
        onClick={() =>
          insertBlock(v(), '| x |  |  |\n| --- | --- | --- |\n|  |  |  |\n')
        }
      >
        <Table />
      </ToolBtn>
    </div>
  )
}

export function NoteEditor({
  path,
  initial,
  onChange,
  onFollowLink
}: {
  path: string
  initial: string
  onChange: (value: string) => void
  onFollowLink: (title: string) => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Колбэки держим в ref: пересоздавать редактор на каждый рендер нельзя,
  // иначе теряются курсор, выделение и история отмен.
  const onChangeRef = useRef(onChange)
  const onFollowRef = useRef(onFollowLink)
  onChangeRef.current = onChange
  onFollowRef.current = onFollowLink

  useEffect(() => {
    if (!host.current) return

    const state = EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(highlight),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: 'Mod-b',
            run: (v) => wrapMarks(v, '**', '**', 'текст')
          },
          {
            key: 'Mod-i',
            run: (v) => wrapMarks(v, '*', '*', 'текст')
          },
          {
            key: 'Mod-k',
            run: (v) => {
              const { from, to } = v.state.selection.main
              const selected = v.state.sliceDoc(from, to) || 'текст'
              const insert = `[${selected}](url)`
              v.dispatch({
                changes: { from, to, insert },
                selection: {
                  anchor: from + selected.length + 3,
                  head: from + insert.length - 1
                }
              })
              return true
            }
          },
          {
            key: 'Mod-Shift-k',
            run: (v) => wrapMarks(v, '[[', ']]', 'заметка')
          }
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          click(event, v) {
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos == null) return false
            const title = wikilinkAt(v, pos)
            if (!title) return false
            event.preventDefault()
            onFollowRef.current(title)
            return true
          }
        })
      ]
    })

    const v = new EditorView({ state, parent: host.current })
    view.current = v
    v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // Пересоздаём только при смене заметки.
     
  }, [path])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteToolbar viewRef={view} />
      <div className="notes__cm min-h-0 flex-1 overflow-hidden" ref={host} />
    </div>
  )
}
