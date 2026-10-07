import { useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Нативные window.prompt и confirm в Electron выглядят чужеродно
 * и блокируют процесс, поэтому ввод и подтверждение — обычные диалоги.
 */
export function TextPromptDialog({
  open,
  title,
  description,
  label,
  defaultValue = '',
  confirmLabel = 'Создать',
  onConfirm,
  onOpenChange
}: {
  open: boolean
  title: string
  description?: string
  label: string
  defaultValue?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [value, setValue] = useState(defaultValue)
  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    onConfirm(v)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="prompt-value">{label}</Label>
          <Input
            id="prompt-value"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Удалить',
  destructive = true,
  onConfirm,
  onOpenChange
}: {
  open: boolean
  title: string
  children?: ReactNode
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {children && <DialogDescription asChild><div>{children}</div></DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Диалог добавления произвольного веб-приложения в контур. */
export function AddAppDialog({
  open,
  envName,
  onConfirm,
  onOpenChange
}: {
  open: boolean
  envName: string
  onConfirm: (name: string, url: string) => void
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('https://')
  useEffect(() => {
    if (open) {
      setName('')
      setUrl('https://')
    }
  }, [open])

  const canSubmit =
    name.trim().length > 0 && url.trim().length > 0 && url.trim() !== 'https://'

  const submit = (): void => {
    if (!canSubmit) return
    onConfirm(name.trim(), url.trim())
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Добавить приложение</DialogTitle>
          <DialogDescription>
            Веб-сервис в контуре «{envName}» — откроется встроенной вкладкой.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="add-app-name">Название</Label>
            <Input
              id="add-app-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Wiki, Портал…"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="add-app-url">URL</Label>
            <Input
              id="add-app-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

