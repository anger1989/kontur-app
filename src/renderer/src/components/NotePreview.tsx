import { useMemo, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** `[[Title]]` / `[[Title|alias]]` → markdown-ссылка с протоколом wikilink: */
function preprocessWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?(?:#[^\]]*)?\]\]/g, (_m, title: string, alias?: string) => {
    const t = title.trim()
    const label = (alias ?? t).trim()
    return `[${label}](wikilink:${encodeURIComponent(t)})`
  })
}

/** Ячейки строки таблицы (без крайних пустых от ведущего/замыкающего `|`). */
function tableCells(line: string): string[] {
  const parts = line.split('|')
  if (parts[0]?.trim() === '') parts.shift()
  if (parts.length && parts[parts.length - 1]?.trim() === '') parts.pop()
  return parts.map((c) => c.trim())
}

function isPipeRow(line: string): boolean {
  return /^\s*\|/.test(line) && line.includes('|', line.indexOf('|') + 1)
}

/** Строка-разделитель GFM: `| --- | :---: | ---: |` (пробелы вокруг дефисов ок). */
function isSepRow(line: string): boolean {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s+/g, '')))
}

function formatRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function normalizeSepCell(c: string): string {
  const t = c.replace(/\s+/g, '')
  return /^:?-{1,}:?$/.test(t) ? t : '---'
}

/**
 * GFM требует одинаковое число колонок у шапки и разделителя — иначе вся
 * «таблица» падает в обычный параграф (как на скрине). Подравниваем блок.
 */
function normalizeGfmTables(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]!
    const sep = lines[i + 1]
    if (sep && isPipeRow(header) && isSepRow(sep)) {
      const block = [header, sep]
      let j = i + 2
      while (j < lines.length && isPipeRow(lines[j]!) && !isSepRow(lines[j]!)) {
        block.push(lines[j]!)
        j++
      }
      const parsed = block.map(tableCells)
      const cols = Math.max(1, ...parsed.map((c) => c.length))
      const pad = (cells: string[], fill = ''): string[] => {
        const next = cells.slice(0, cols)
        while (next.length < cols) next.push(fill)
        return next
      }
      out.push(formatRow(pad(parsed[0]!)))
      out.push(formatRow(pad(parsed[1]!, '---').map(normalizeSepCell)))
      for (let k = 2; k < parsed.length; k++) out.push(formatRow(pad(parsed[k]!)))
      i = j
      continue
    }
    out.push(header)
    i++
  }
  return out.join('\n')
}

/**
 * Просмотр заметки: отрисованный markdown + кликабельные [[вики-ссылки]].
 */
export function NotePreview({
  content,
  onFollowLink,
  onEdit,
  className
}: {
  content: string
  onFollowLink: (title: string) => void
  /** Клик по пустому месту / двойной клик — начать правку. */
  onEdit?: () => void
  className?: string
}): JSX.Element {
  const source = useMemo(() => preprocessWikilinks(normalizeGfmTables(content)), [content])

  return (
    <div
      className={cn('notes-preview selectable min-h-0 flex-1 overflow-y-auto', className)}
      onDoubleClick={onEdit}
    >
      <article className="notes-prose w-full px-7 py-5">
        {content.trim() ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                if (href?.startsWith('wikilink:')) {
                  const title = decodeURIComponent(href.slice('wikilink:'.length))
                  return (
                    <button
                      type="button"
                      className="notes-wikilink"
                      onClick={(e) => {
                        e.stopPropagation()
                        onFollowLink(title)
                      }}
                    >
                      {children}
                    </button>
                  )
                }
                return (
                  <a href={href} target="_blank" rel="noreferrer noopener">
                    {children}
                  </a>
                )
              },
              // Пустые абзацы / одиночные переносы не глотать совсем.
              p: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
              table: ({ children }) => (
                <div className="notes-table-wrap">
                  <table>{children}</table>
                </div>
              )
            }}
          >
            {source}
          </ReactMarkdown>
        ) : (
          <p className="text-muted-foreground">Пустая заметка. Нажмите «Редактировать» или дважды кликните.</p>
        )}
      </article>
    </div>
  )
}
