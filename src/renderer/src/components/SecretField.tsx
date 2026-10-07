import { useState, type JSX } from 'react'
import { Check, Eye, EyeOff, Trash2, X } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { SecretMeta } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Поле секрета. Значение по умолчанию не покидает main-процесс:
 * renderer знает лишь, что секрет задан. «Показать» — отдельный
 * осознанный запрос, который расшифровывает значение через keychain.
 */
export function SecretField({
  secretRef,
  label,
  meta,
  onSaved
}: {
  secretRef: string
  label: string
  meta: SecretMeta | undefined
  onSaved: (metas: SecretMeta[]) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      onSaved(await window.kontur.secrets.set(secretRef, value, label))
      setValue('')
      setEditing(false)
      setRevealed(null)
      toast.success('Секрет сохранён в keychain')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    onSaved(await window.kontur.secrets.remove(secretRef))
    setRevealed(null)
    toast.success('Секрет удалён')
  }

  const reveal = async (): Promise<void> => {
    if (revealed !== null) return setRevealed(null)
    setRevealed((await window.kontur.secrets.reveal(secretRef)) ?? '—')
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoFocus
          className="font-mono text-xs"
          placeholder="Вставьте значение"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <Button size="icon" disabled={busy || !value} onClick={() => void save()} title="Сохранить">
          <Check />
        </Button>
        <Button size="icon" variant="outline" onClick={() => setEditing(false)} title="Отмена">
          <X />
        </Button>
      </div>
    )
  }

  // Вид обычного поля: рядом с «Логином» секрет должен читаться как такой же
  // ввод, а не как строчка текста с кнопками, висящими в пустоте.
  return (
    <div className="flex h-9 w-full min-w-0 items-center gap-1 rounded-md border border-input bg-transparent pr-1 pl-3 shadow-xs dark:bg-input/30">
      <span
        className={cn(
          'selectable min-w-0 flex-1 truncate font-mono text-xs',
          meta?.hasValue ? 'text-foreground/80' : 'text-muted-foreground'
        )}
      >
        {meta?.hasValue ? (revealed ?? '••••••••••••') : 'не задан'}
      </span>
      {meta?.hasValue && (
        <Button
          size="icon-xs"
          variant="ghost"
          title={revealed ? 'Скрыть' : 'Показать'}
          onClick={() => void reveal()}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button size="xs" variant="ghost" className="text-primary" onClick={() => setEditing(true)}>
        {meta?.hasValue ? 'Заменить' : 'Задать'}
      </Button>
      {meta?.hasValue && (
        <Button size="icon-xs" variant="ghost" title="Удалить" onClick={() => void remove()}>
          <Trash2 />
        </Button>
      )}
    </div>
  )
}
