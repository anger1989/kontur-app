import { useState, type ClipboardEvent, type JSX } from 'react'
import {
  Download,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Paperclip,
  X,
  type LucideIcon
} from 'lucide-react'
import type { MailAttachment, MailOutgoingAttachment } from '@shared/types'
import { toast } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Вложения письма — как в Outlook: строка плиток под шапкой письма, а в
 * окне ответа такая же строка с крестиками и кнопкой «Прикрепить».
 *
 * Содержимое вложений живёт в main: рендерер получает только имя, размер и
 * тип, а «открыть» и «сохранить» выполняет главный процесс.
 */

export function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function iconFor(mime: string, name: string): LucideIcon {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) return FileImage
  if (mime === 'application/pdf' || ext === 'pdf') return FileText
  if (/sheet|excel|csv/.test(mime) || ['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet
  if (/zip|rar|7z|tar|gzip/.test(mime) || ['zip', 'rar', '7z', 'gz'].includes(ext)) return FileArchive
  return FileText
}

/** Плитка вложения: иконка, имя, размер и действие справа. */
function Chip({
  name,
  size,
  mime,
  busy,
  onClick,
  action
}: {
  name: string
  size: number | null
  mime: string
  busy?: boolean
  onClick?: () => void
  action?: JSX.Element
}): JSX.Element {
  const Icon = iconFor(mime, name)
  return (
    <div
      className={cn(
        'group/att flex max-w-[260px] items-center gap-2 rounded-md border bg-card py-1 pr-1 pl-2 text-[12px]',
        onClick && 'cursor-pointer hover:border-ring hover:bg-accent',
        busy && 'pointer-events-none opacity-60'
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      title={size ? `${name} · ${formatBytes(size)}` : name}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {size ? <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(size)}</span> : null}
      {action}
    </div>
  )
}

/** Вложения полученного письма. Клик открывает, стрелка сохраняет. */
export function MailAttachmentList({
  itemId,
  attachments
}: {
  itemId: string
  attachments: MailAttachment[]
}): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null)
  // Логотипы из подписи (мелкие cid-картинки) в списке не нужны, а вот
  // настоящее фото, вставленное в тело, спрятать нельзя — его ещё сохраняют.
  const files = attachments.filter((a) => !a.inline || (a.size ?? 0) > 20 * 1024)
  if (!files.length) return null

  const run = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-5 py-2.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
        <Paperclip className="size-3.5" />
        Вложения {files.length}
      </span>
      {files.map((att) => (
        <Chip
          key={att.id}
          name={att.name}
          size={att.size}
          mime={att.mime}
          busy={busy === att.id}
          onClick={() =>
            void run(att.id, () => window.kontur.mail.openAttachment(itemId, { id: att.id, name: att.name }))
          }
          action={
            <Button
              size="icon-xs"
              variant="ghost"
              title="Сохранить как…"
              aria-label={`Сохранить ${att.name}`}
              className="opacity-0 group-hover/att:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                void run(att.id, async () => {
                  const path = await window.kontur.mail.saveAttachment(itemId, {
                    id: att.id,
                    name: att.name
                  })
                  if (path) toast.success(`Сохранено: ${path}`)
                })
              }}
            >
              <Download />
            </Button>
          }
        />
      ))}
    </div>
  )
}

/** Размер вложения по его base64 — его же считает main перед отправкой. */
export function outgoingSize(att: MailOutgoingAttachment): number {
  return Math.ceil(att.data.length * 0.75)
}

/**
 * Вложения письма, которое пишем: плитки с крестиком и кнопка «Прикрепить».
 * Вставленные через Ctrl+V картинки помечены — они уйдут внутрь письма.
 */
export function ComposeAttachments({
  items,
  onChange,
  disabled
}: {
  items: MailOutgoingAttachment[]
  onChange: (next: MailOutgoingAttachment[]) => void
  disabled?: boolean
}): JSX.Element {
  const pick = async (): Promise<void> => {
    try {
      const picked = await window.kontur.mail.pickAttachments()
      if (picked.length) onChange([...items, ...picked])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[12px]"
        disabled={disabled}
        onClick={() => void pick()}
      >
        <Paperclip />
        Прикрепить
      </Button>
      {items.map((att, i) => (
        <Chip
          key={`${att.name}:${i}`}
          name={att.inline ? `${att.name} · в тексте` : att.name}
          size={outgoingSize(att)}
          mime={att.mime}
          action={
            <Button
              size="icon-xs"
              variant="ghost"
              title="Убрать"
              aria-label={`Убрать ${att.name}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          }
        />
      ))}
    </div>
  )
}

/**
 * Ctrl+V в тексте письма: картинка из буфера (скриншот) или файл из Finder
 * становятся вложением, как в Outlook. Обычный текст вставляется как обычно.
 */
export function attachmentPasteHandler(
  add: (next: MailOutgoingAttachment[]) => void
): (e: ClipboardEvent<HTMLElement>) => void {
  return (e) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    void Promise.all(files.map(readAsAttachment))
      .then((list) => {
        add(list.filter((a): a is MailOutgoingAttachment => a != null))
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : String(err))
      })
  }
}

/** Файл из буфера → вложение в base64. Картинки помечаем как встроенные. */
async function readAsAttachment(file: File): Promise<MailOutgoingAttachment | null> {
  const buf = await file.arrayBuffer()
  if (!buf.byteLength) return null
  const bytes = new Uint8Array(buf)
  let binary = ''
  // Чанками: apply на мегабайтном массиве упирается в лимит аргументов.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const isImage = file.type.startsWith('image/')
  const stamp = new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')
  const name =
    file.name && file.name !== 'image.png'
      ? file.name
      : `Снимок ${stamp}.${file.type.split('/')[1] || 'png'}`
  return {
    name,
    mime: file.type || 'application/octet-stream',
    data: btoa(binary),
    inline: isImage
  }
}
