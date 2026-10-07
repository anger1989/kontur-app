import { useState, type JSX } from 'react'
import { Ban, Check, CircleHelp, ExternalLink, Loader2, MapPin, Pencil, User, X } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { Item, MeetingResponseKind } from '@shared/types'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { LinkifiedText } from '@/components/LinkifiedText'
import { openLink } from '@/lib/openLink'
import { CreateEventDialog } from '@/components/CreateEventDialog'

function timeLabel(ts: number): string {
  const d = new Date(ts)
  if (d.getHours() === 0 && d.getMinutes() === 0) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatRange(start: number | null, end: number | null): string {
  if (start == null) return '—'
  const day = new Date(start).toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  })
  const t0 = timeLabel(start)
  const t1 = end != null ? timeLabel(end) : ''
  if (t0 && t1) return `${day}, ${t0}–${t1}`
  if (t0) return `${day}, ${t0}`
  return day
}

function canRespond(state: string | null): boolean {
  if (!state) return true
  return state !== 'организатор' && state !== 'отменена' && state !== 'отклонена'
}

/** Состояние, в котором окажется встреча после каждого ответа. */
const STATE_AFTER: Record<MeetingResponseKind, string> = {
  accept: 'принята',
  tentative: 'под вопросом',
  decline: 'отклонена'
}
const STATE_AFTER_SET = new Set(Object.values(STATE_AFTER))

const RSVP: { kind: MeetingResponseKind; label: string; icon: typeof Check }[] = [
  { kind: 'accept', label: 'Принять', icon: Check },
  { kind: 'tentative', label: 'Под вопросом', icon: CircleHelp },
  { kind: 'decline', label: 'Отклонить', icon: X }
]

const RESPONSE_TOAST: Record<MeetingResponseKind, string> = {
  accept: 'Встреча принята',
  tentative: 'Ответ «под вопросом» отправлен',
  decline: 'Встреча отклонена'
}

const STATE_LABEL: Record<string, string> = {
  принята: 'Принята',
  'под вопросом': 'Под вопросом',
  отклонена: 'Отклонена',
  организатор: 'Вы организатор',
  отменена: 'Отменена',
  'не отвечено': 'Не отвечено'
}

export function EventDialog({
  event,
  envName,
  envAccent,
  onClose,
  onUpdated
}: {
  event: Item | null
  envName?: string
  envAccent?: string
  onClose: () => void
  onUpdated?: (item: Item) => void
}): JSX.Element {
  const { config } = useStore()
  const [busy, setBusy] = useState<MeetingResponseKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = event != null
  const lines = (event?.body ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  const meetingUrl = lines.find((l) => /^https?:\/\//i.test(l))
  const showRsvp = event != null && canRespond(event.state)
  // Менять/отменять — только свои: я организатор или событие без участников.
  const canManage = event != null && (event.state === 'организатор' || event.state === 'встреча')
  // Вхождение повторяющейся встречи: id оканчивается датой вхождения.
  const isOccurrence = event != null && /:\d{8}T\d{6}Z$/.test(event.id)
  const [editing, setEditing] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const doCancel = async (scope: 'occurrence' | 'series'): Promise<void> => {
    if (!event) return
    setCancelBusy(true)
    setCancelError(null)
    try {
      await window.kontur.calendar.cancel({ itemId: event.id, scope })
      toast.success(scope === 'series' && isOccurrence ? 'Серия встреч отменена' : 'Встреча отменена')
      setCancelOpen(false)
      onClose()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setCancelError(raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, ''))
    } finally {
      setCancelBusy(false)
    }
  }

  const openInAppCalendar = (): void => {
    if (!event?.url) return
    const svc = config?.services.find((s) => s.id === event.serviceId)
    if (svc && (svc.mode === 'embed' || svc.mode === 'both') && svc.baseUrl) {
      onClose()
      useStore.getState().openWindow({ kind: 'service', serviceId: svc.id, url: event.url })
      return
    }
    void window.kontur.app.openExternal(event.url)
  }

  const respond = async (kind: MeetingResponseKind): Promise<void> => {
    if (!event) return
    setBusy(kind)
    setError(null)
    try {
      const next = await window.kontur.calendar.respond(event.id, kind)
      onUpdated?.(next)
      // Без этого единственным признаком успеха была строчка «Принята» мелким
      // серым в шапке — её не замечали и жали «Принять» второй раз.
      toast.success(RESPONSE_TOAST[kind], { description: next.title })
      if (kind === 'decline') onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
    <Dialog
      open={open && !editing}
      onOpenChange={(v) => {
        if (!v) {
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        {event && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 text-left text-[17px] leading-snug">
                {event.title}
              </DialogTitle>
              <DialogDescription className="text-left">
                {formatRange(event.startsAt, event.endsAt)}
                {event.state && STATE_LABEL[event.state] ? (
                  <span className="mt-1 block text-muted-foreground">
                    {STATE_LABEL[event.state]}
                  </span>
                ) : null}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-[13px]">
              {(envName || event.author) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  {envName && (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: envAccent ?? 'var(--muted-foreground)' }}
                      />
                      {envName}
                    </span>
                  )}
                  {event.author && (
                    <span className="inline-flex items-center gap-1.5">
                      <User className="size-3.5" />
                      {event.author}
                    </span>
                  )}
                </div>
              )}

              {lines.length > 0 && (
                <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2.5">
                  {lines.map((line, i) => {
                    if (/^https?:\/\//i.test(line)) {
                      return (
                        <div key={i} className="flex items-start gap-1.5">
                          <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <LinkifiedText text={line} className="min-w-0 text-[13px]" />
                        </div>
                      )
                    }
                    return (
                      <div key={i} className="flex items-start gap-1.5">
                        {i === 0 && !/^https?:\/\//i.test(lines[0] ?? '') ? (
                          <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <span className="size-3.5 shrink-0" />
                        )}
                        <LinkifiedText text={line} className="min-w-0 whitespace-pre-wrap" />
                      </div>
                    )
                  })}
                </div>
              )}

              {error && <p className="text-[12px] text-destructive">{error}</p>}
            </div>

            {showRsvp && (
              /* Ответ можно поменять, поэтому кнопки остаются. Но текущий
                 выбор должен быть виден: иначе после «Принять» экран выглядит
                 ровно как до нажатия. */
              <div className="flex flex-wrap items-center gap-2">
                {RSVP.map(({ kind, label, icon: Icon }) => {
                  const chosen = STATE_AFTER[kind] === event.state
                  return (
                    <Button
                      key={kind}
                      size="sm"
                      variant={chosen ? 'default' : 'outline'}
                      aria-pressed={chosen}
                      disabled={busy != null}
                      onClick={() => void respond(kind)}
                    >
                      {busy === kind ? <Loader2 className="animate-spin" /> : <Icon />}
                      {label}
                    </Button>
                  )
                })}
                {event.state && STATE_AFTER_SET.has(event.state) && busy == null && (
                  <span className="text-[12px] text-muted-foreground">ответ отправлен</span>
                )}
              </div>
            )}

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil />
                  Изменить / перенести
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  onClick={() => {
                    setCancelError(null)
                    setCancelOpen(true)
                  }}
                >
                  <Ban />
                  Отменить встречу
                </Button>
              </div>
            )}

            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="outline" size="sm" onClick={openInAppCalendar}>
                <ExternalLink />
                Веб-календарь
              </Button>
              {meetingUrl && (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose()
                    openLink(meetingUrl)
                  }}
                >
                  Подключиться
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>

    <CreateEventDialog
      open={editing}
      editItem={editing ? event : null}
      onClose={() => setEditing(false)}
      onSaved={(item) => {
        onUpdated?.(item)
        toast.success('Встреча обновлена')
        setEditing(false)
        onClose()
      }}
    />

    <Dialog open={cancelOpen} onOpenChange={(v) => !cancelBusy && setCancelOpen(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Отменить встречу?</DialogTitle>
          <DialogDescription>
            «{event?.title}» будет удалена из календаря.
            {event?.state === 'организатор' ? ' Участникам уйдёт уведомление об отмене.' : ''}
            {isOccurrence ? ' Это повторяющаяся встреча — отменить только этот день или всю серию?' : ''}
          </DialogDescription>
        </DialogHeader>
        {cancelError && <p className="text-[12px] text-destructive">{cancelError}</p>}
        {/* flex-wrap: у повторяющейся встречи три кнопки — в узком окне не помещались в строку. */}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" disabled={cancelBusy} onClick={() => setCancelOpen(false)}>
            Не отменять
          </Button>
          {isOccurrence ? (
            <>
              <Button variant="outline" disabled={cancelBusy} onClick={() => void doCancel('series')}>
                Всю серию
              </Button>
              <Button variant="destructive" disabled={cancelBusy} onClick={() => void doCancel('occurrence')}>
                {cancelBusy ? 'Отменяем…' : 'Только этот день'}
              </Button>
            </>
          ) : (
            <Button variant="destructive" disabled={cancelBusy} onClick={() => void doCancel('series')}>
              {cancelBusy ? 'Отменяем…' : 'Отменить встречу'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}

export { timeLabel, formatRange }
