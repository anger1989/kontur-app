import { useEffect, useState, type JSX } from 'react'
import { ChevronRight, ExternalLink, Image as ImageIcon, Plus, Sparkles } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type {
  BrowserConfig,
  EnvConfig,
  LinkOpenMode,
  SecretMeta,
  ServiceConfig,
  ThemePref,
  UserProfile,
  VpnKind,
  Wallpaper,
  WidgetId,
  WidgetLayout
} from '@shared/types'
import { WIDGET_IDS, WIDGET_TITLES } from '@shared/types'
import { PROFILE_PASSWORD_REF } from '@shared/types'
import {
  AUTH_LABELS,
  DEFAULT_LOGIN_SELECTORS,
  defaultBrowser,
  defaultProfile,
  VPN_LABELS
} from '@shared/defaults'
import { domainsFromServices, parseDnsList } from '@shared/dnsDomains'
import { useStore } from '@/store'
import { applyProfileCredentials, saveProfilePassword } from '@/lib/profileCreds'
import { cn } from '@/lib/utils'
import {
  WALLPAPER_ANIMATED,
  WALLPAPER_PRESETS,
  WALLPAPER_IMAGES,
  WALLPAPER_COLORS
} from '@/lib/wallpapers'
import { Callout } from '@/components/Callout'
import { ConfirmDialog, AddAppDialog } from '@/components/prompts'
import { EnvConnect } from '@/components/EnvConnect'
import { EnvDot } from '@/components/EnvDot'
import { SecretField } from '@/components/SecretField'
import { Diagnostics } from '@/components/Diagnostics'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AgentIcon } from '@/lib/brandIcons'
import { ServicesDnD } from '@/components/ServicesDnD'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Segmented } from '@/components/ui/segmented'

/**
 * У каких сервисов уже есть коннектор синхронизации по API. Остальным логин и
 * токен пока ни на что не влияют — работает только встроенная вкладка.
 */
const SYNC_KINDS = new Set(['mattermost', 'jira', 'confluence', 'gitlab', 'bitbucket'])

/** Сервисы, где можно взять сессионный токен из куки открытой вкладки. */
const SESSION_KINDS = new Set(['mattermost', 'gitlab', 'jira', 'confluence', 'bitbucket'])

function SnxAvailabilityHint(): JSX.Element {
  const [info, setInfo] = useState<{
    ok: boolean
    source: 'bundled' | 'system' | 'missing'
    path: string | null
    service: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.kontur.vpn.snxAvailable().then(setInfo)
  }, [])
  if (!info) return <p className="text-xs text-muted-foreground">Проверяем snx-rs…</p>
  if (info.ok && info.service) {
    return (
      <p className="text-xs text-muted-foreground">
        snx-rs: служба запущена ({info.source}
        {info.path ? `, ${info.path}` : ''})
      </p>
    )
  }
  return (
    <Callout tone="warning">
      <p className="text-xs">
        На macOS нужен официальный <span className="font-mono">SNX-RS.pkg</span> (root-LaunchDaemon).
        Встроенные бинари Kontur без службы туннель не поднимают.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.kontur.vpn
            .snxOpenInstaller()
            .then(() => toast.message('Открыл DMG — установите SNX-RS.pkg'))
            .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Скачать и открыть установщик
      </Button>
    </Callout>
  )
}

/** Подписи дополнительных полей — чтобы не гадать, что куда вводить. */
const OPTION_LABELS: Record<string, string> = {
  imapHost: 'IMAP-сервер',
  imapPort: 'Порт IMAP',
  smtpHost: 'SMTP-сервер',
  smtpPort: 'Порт SMTP',
  webUrl: 'Адрес веб-клиента',
  appPath: 'Приложение',
  ctsUrl: 'Адрес сервера (CTS)',
  email: 'Адрес почты',
  displayName: 'Имя отправителя',
  easUrl: 'Адрес ActiveSync',
  ewsUrl: 'Адрес EWS',
  jmapUrl: 'Адрес JMAP',
  protocol: 'Протокол',
  caldavUrl: 'Адрес CalDAV',
  icsUrl: 'Адрес ICS-ленты',
  storyPointsField: 'Поле Story Points',
  projectKey: 'Проект Jira',
  boardId: 'ID доски (опционально)'
}

/** Подсказки к полям, где это неочевидно. */
const OPTION_HINTS: Record<string, string> = {
  email:
    'Адрес ящика (name@example.com). Если для ActiveSync логин другой (DOMAIN\\user) — укажите его в поле «Логин».',
  ewsUrl: 'Для Exchange обычно это webUrl + EWS/Exchange.asmx. Отсюда берутся письма и события. Пусто — выведем из webUrl.',
  imapHost: 'Только если это не Exchange, а обычная почта: сервер IMAP.',
  smtpHost: 'Сервер исходящей почты, если не Exchange.',
  jmapUrl: 'Для JMAP-почты (https://mail.example.com). Обычно вход по паролю приложения.',
  caldavUrl: 'Календарь по CalDAV (https://cal.example.com), если он на отдельном хосте.',
  easUrl: 'Адрес ActiveSync. Пусто — выведем из адреса: …/Microsoft-Server-ActiveSync',
  easDeviceId: 'Идентификатор устройства (создаётся автоматически).',
  protocol:
    'eas — ActiveSync (логин email или DOMAIN\\user + пароль / app-password, не SSO). jmap / imap — для обычной почты.',
  storyPointsField:
    'ID кастомного поля Jira (например customfield_10016). Пусто — ищем сами по имени Story Points.',
  projectKey:
    'Ключ проекта (например ABC). Колонки канбана и фильтр задач берутся с доски этого проекта.',
  boardId:
    'Числовой id Agile-доски. Пусто — берём первую kanban/scrum доску проекта.'
}

/** Почта и календарь — один сервис; протокол и его адрес идут первыми. */
const OPTION_ORDER = ['email', 'displayName', 'protocol', 'easUrl', 'ewsUrl', 'jmapUrl', 'imapHost', 'imapPort', 'caldavUrl', 'smtpHost', 'smtpPort']

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

function ServiceEditor({
  service,
  secrets,
  onSecrets
}: {
  service: ServiceConfig
  secrets: SecretMeta[]
  onSecrets: (m: SecretMeta[]) => void
}): JSX.Element {
  const { saveService, config } = useStore()
  const [draft, setDraft] = useState(service)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const env = config?.envs.find((e) => e.id === service.envId)
  const secretRef = `${service.id}.secret`

  useEffect(() => setDraft(service), [service])

  const patch = (p: Partial<ServiceConfig>): void => setDraft((d) => ({ ...d, ...p }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(service)

  return (
    <div className="space-y-4 border-t bg-muted/30 px-4 py-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Название">
          <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label="Режим работы">
          <Select value={draft.mode} onValueChange={(v) => patch({ mode: v as ServiceConfig['mode'] })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">API и встроенная вкладка</SelectItem>
              <SelectItem value="api">Только API</SelectItem>
              <SelectItem value="embed">Только встроенная вкладка</SelectItem>
              <SelectItem value="launcher">Отдельное приложение</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {draft.mode === 'launcher' ? (
        <Field
          label="Приложение"
          hint="У сервиса нет веб-версии: встроить его нельзя, но открывать одним кликом вместе с остальными — можно."
        >
          <div className="flex items-center gap-2">
            <Input
              className="font-mono text-xs"
              placeholder="/Applications/А-Чат.app"
              value={draft.options.appPath ?? ''}
              onChange={(e) => patch({ options: { ...draft.options, appPath: e.target.value } })}
            />
            <Button
              variant="outline"
              onClick={async () => {
                const f = await window.kontur.app.pickFile([
                  { name: 'Приложения', extensions: ['app'] }
                ])
                if (f) patch({ options: { ...draft.options, appPath: f } })
              }}
            >
              Выбрать…
            </Button>
            <Button
              variant="outline"
              disabled={!draft.options.appPath?.trim()}
              onClick={async () => {
                const appPath = draft.options.appPath?.trim()
                if (!appPath) return
                try {
                  await window.kontur.app.openApp(appPath)
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Открыть
            </Button>
          </div>
        </Field>
      ) : (
        <Field
          label={draft.kind === 'mail' ? 'Адрес веб-клиента' : 'Базовый URL'}
          hint={
            draft.kind === 'mail'
              ? 'Веб-почта/календарь, открывается встроенной вкладкой: например https://mail.example.com/'
              : draft.kind === 'achat'
                ? 'Веб-клиент А-Чата (eXpress). Обычно https://achat.best/ — CTS это API, не страница.'
                : draft.kind === 'ktalk'
                  ? 'Веб-клиент Контур.Толк. Обычно https://app.ktalk.ru или https://ваше-пространство.ktalk.ru'
                  : 'Адрес внутри контура — открывается, только когда поднят туннель.'
          }
        >
          <Input
            className="font-mono text-xs"
            placeholder={
              draft.kind === 'mail'
                ? 'https://mail.example.com/'
                : draft.kind === 'ktalk'
                  ? 'https://app.ktalk.ru'
                  : 'https://jira.example.internal'
            }
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value.trim() })}
          />
        </Field>
      )}

      {draft.mode !== 'launcher' && (
        <Callout tone={SYNC_KINDS.has(draft.kind) ? 'info' : 'warning'}>
          {SYNC_KINDS.has(draft.kind) ? (
            <>
              Логин и токен ниже — для <strong>синхронизации по API</strong> (раздел «Мой день» и
              поиск). Встроенная вкладка входит отдельно, своим входом: один раз залогинитесь в ней, и
              сессия сохранится — а при корпоративном SSO один вход открывает и Jira, и Confluence, и
              Bitbucket этого контура.
            </>
          ) : (
            <>
              Автоматического входа во встроенную вкладку нет: вы логинитесь в ней один раз, и сессия
              сохраняется (при SSO — сразу во все сервисы контура). Логин и токен ниже — задел под
              будущую синхронизацию по API; для этого сервиса коннектора пока нет, так что сейчас они
              ни на что не влияют.
            </>
          )}
        </Callout>
      )}

      <div className={draft.mode === 'launcher' ? 'hidden' : 'grid grid-cols-2 gap-3'}>
        <Field label="Способ авторизации">
          <Select
            value={draft.auth.kind}
            onValueChange={(v) => patch({ auth: { ...draft.auth, kind: v as never } })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(AUTH_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Логин"
          hint={
            draft.kind === 'mail'
              ? 'Email ящика или DOMAIN\\user для ActiveSync / AD.'
              : undefined
          }
        >
          <Input
            className="font-mono text-xs"
            placeholder={draft.kind === 'mail' ? 'user@example.com' : 'i.ivanov'}
            disabled={draft.auth.kind === 'none' || draft.auth.kind === 'cookie'}
            value={draft.auth.username ?? ''}
            onChange={(e) => patch({ auth: { ...draft.auth, username: e.target.value || null } })}
          />
        </Field>
      </div>

      {draft.auth.kind !== 'none' && draft.auth.kind !== 'cookie' && (
        <Field
          label={draft.auth.kind === 'basic' ? 'Пароль' : 'Токен'}
          hint={
            draft.kind === 'mail'
              ? 'Доменный пароль или пароль приложения из веб-клиента (не SSO). В keychain; «показать» — по клику.'
              : 'Хранится зашифрованным в системном keychain. В интерфейс значение не передаётся, пока вы явно не нажмёте «показать».'
          }
        >
          <SecretField
            secretRef={secretRef}
            label={`${env?.name ?? draft.envId} · ${draft.name}`}
            meta={secrets.find((s) => s.ref === secretRef)}
            onSaved={onSecrets}
          />
          {SESSION_KINDS.has(draft.kind) && draft.baseUrl && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await window.kontur.items.grabSessionToken(service.id)
                    onSecrets(await window.kontur.secrets.list())
                    toast.success('Токен взят из открытой вкладки')
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                Взять из открытой вкладки
              </Button>
              <span className="text-xs text-muted-foreground">
                если персональные токены закрыты — войдите во вкладке сервиса и нажмите здесь
              </span>
            </div>
          )}
        </Field>
      )}

      {draft.auth.kind === 'cookie' && (
        <Callout>
          Авторизация во встроенной вкладке. Сессия в партиции контура переживает перезапуск.
          {SESSION_KINDS.has(draft.kind) && (
            <>
              {' '}
              Уведомления и «Мой день» подхватывают ту же куку автоматически — откройте вкладку и
              войдите, отдельный токен не нужен.
            </>
          )}
        </Callout>
      )}

      {draft.kind === 'jira' && !('projectKey' in draft.options) && (
        <Field label={OPTION_LABELS.projectKey!} hint={OPTION_HINTS.projectKey}>
          <Input
            className="font-mono text-xs uppercase"
            placeholder="ABC"
            value=""
            onChange={(e) =>
              patch({
                options: { ...draft.options, projectKey: e.target.value.trim().toUpperCase() }
              })
            }
          />
        </Field>
      )}

      {draft.kind === 'jira' && !('storyPointsField' in draft.options) && (
        <Field label={OPTION_LABELS.storyPointsField!} hint={OPTION_HINTS.storyPointsField}>
          <Input
            className="font-mono text-xs"
            placeholder="customfield_10016"
            value=""
            onChange={(e) =>
              patch({ options: { ...draft.options, storyPointsField: e.target.value.trim() } })
            }
          />
        </Field>
      )}

      {Object.keys(draft.options).length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {Object.keys(draft.options)
            .filter((k) => k !== 'easDeviceId' && !(draft.mode === 'launcher' && k === 'appPath'))
            .sort((a, b) => {
              const ia = OPTION_ORDER.indexOf(a)
              const ib = OPTION_ORDER.indexOf(b)
              return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
            })
            .map((k) =>
              k === 'protocol' ? (
                <Field key={k} label={OPTION_LABELS[k]} hint={OPTION_HINTS[k]}>
                  <Select
                    value={draft.options[k] || 'eas'}
                    onValueChange={(v) => patch({ options: { ...draft.options, protocol: v } })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eas">ActiveSync — почта и календарь</SelectItem>
                      <SelectItem value="exchange">Exchange (EWS) — почта и календарь</SelectItem>
                      <SelectItem value="jmap">JMAP — почта</SelectItem>
                      <SelectItem value="imap">IMAP — почта</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field key={k} label={OPTION_LABELS[k] ?? k} hint={OPTION_HINTS[k]}>
                  <Input
                    className="font-mono text-xs"
                    value={draft.options[k]}
                    onChange={(e) => patch({ options: { ...draft.options, [k]: e.target.value } })}
                  />
                </Field>
              )
            )}
        </div>
      )}

      {draft.mode !== 'launcher' && (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Switch
                checked={draft.autoLogin.enabled}
                onCheckedChange={(v) => patch({ autoLogin: { ...draft.autoLogin, enabled: v } })}
                id={`autologin-${service.id}`}
                className="mt-0.5"
              />
              <div className="grid gap-1">
                <Label htmlFor={`autologin-${service.id}`} className="text-xs font-medium">
                  Автовход во встроенную вкладку
                </Label>
                <p className="text-xs text-muted-foreground">
                  Подставляет логин и пароль в форму входа. Работает, когда форма стабильна. Второй
                  фактор и SSO не отменяет — только убирает ручной ввод логина и пароля.
                </p>
              </div>
            </div>

            {draft.autoLogin.enabled && (
              <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
                <Field label="Селектор поля логина" hint="CSS-селектор. Обычно менять не нужно.">
                  <Input
                    className="font-mono text-xs"
                    value={draft.autoLogin.userSelector}
                    onChange={(e) => patch({ autoLogin: { ...draft.autoLogin, userSelector: e.target.value } })}
                  />
                </Field>
                <Field label="Селектор поля пароля">
                  <Input
                    className="font-mono text-xs"
                    value={draft.autoLogin.passSelector}
                    onChange={(e) => patch({ autoLogin: { ...draft.autoLogin, passSelector: e.target.value } })}
                  />
                </Field>
                <Field
                  label="Селектор кнопки входа"
                  hint="Нажимается после подстановки. Очистите, чтобы не нажимать автоматически."
                >
                  <Input
                    className="font-mono text-xs"
                    value={draft.autoLogin.submitSelector}
                    onChange={(e) => patch({ autoLogin: { ...draft.autoLogin, submitSelector: e.target.value } })}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Логин берётся из поля «Логин» выше, пароль — из keychain. Убедитесь, что они заданы.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {service.baseUrl && (
        <>
          <Separator />
          <Diagnostics serviceId={service.id} />
        </>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => void saveService(draft).then(() => toast.success('Сохранено'))}
        >
          Сохранить
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(service)}>
            Отменить
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmRemove(true)}
        >
          Удалить
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Удалить «${service.name}»?`}
        confirmLabel="Удалить"
        onOpenChange={setConfirmRemove}
        onConfirm={() => {
          void (async () => {
            await window.kontur.config.removeService(service.id)
            await useStore.getState().load()
            toast.success('Сервис удалён')
          })()
        }}
      >
        Сервис будет убран из контура. Секреты в keychain останутся — удали вручную при необходимости.
      </ConfirmDialog>
    </div>
  )
}

function ServicesTab({
  secrets,
  onSecrets
}: {
  secrets: SecretMeta[]
  onSecrets: (m: SecretMeta[]) => void
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [addForEnv, setAddForEnv] = useState<EnvConfig | null>(null)

  return (
    <>
      <ServicesDnD
        open={open}
        setOpen={setOpen}
        renderEditor={(s) => (
          <ServiceEditor service={s} secrets={secrets} onSecrets={onSecrets} />
        )}
        addButton={(env) => (
          <Button size="sm" variant="ghost" className="-mt-4 mb-6" onClick={() => setAddForEnv(env)}>
            <Plus /> Добавить приложение
          </Button>
        )}
      />

      <AddAppDialog
        open={addForEnv != null}
        envName={addForEnv?.name ?? ''}
        onOpenChange={(v) => {
          if (!v) setAddForEnv(null)
        }}
        onConfirm={(name, url) => {
          if (!addForEnv) return
          const env = addForEnv
          void (async () => {
            const id = `${env.id}.custom.${Date.now().toString(36)}`
            await window.kontur.config.upsertService({
              id,
              envId: env.id,
              kind: 'custom',
              name,
              baseUrl: url,
              mode: 'embed',
              auth: { kind: 'cookie', username: null, secretRef: null },
              options: {},
              autoLogin: { enabled: false, ...DEFAULT_LOGIN_SELECTORS },
              enabled: true
            })
            await useStore.getState().load()
            toast.success('Приложение добавлено')
            setOpen(id)
          })()
        }}
      />
    </>
  )
}

function SplitDnsSettings({
  env,
  draft,
  patch,
  onSaved
}: {
  env: EnvConfig
  draft: EnvConfig
  patch: (p: Partial<EnvConfig>) => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const services = useStore((s) => s.config?.services ?? [])
  const derived = domainsFromServices(services, draft.id, draft.healthCheckUrl)
  const [busy, setBusy] = useState(false)
  const [domainsRaw, setDomainsRaw] = useState(() => (draft.dnsDomains ?? []).join(' '))
  const [serversRaw, setServersRaw] = useState(() => (draft.dnsServers ?? []).join(' '))
  const enabled = draft.splitDns !== false
  const previewDomains = parseDnsList(domainsRaw).length
    ? parseDnsList(domainsRaw)
    : derived

  useEffect(() => {
    setDomainsRaw((draft.dnsDomains ?? []).join(' '))
    setServersRaw((draft.dnsServers ?? []).join(' '))
  }, [draft.id, draft.dnsDomains, draft.dnsServers])

  const flushLists = (): EnvConfig => {
    const next = {
      ...draft,
      dnsDomains: parseDnsList(domainsRaw),
      dnsServers: parseDnsList(serversRaw)
    }
    patch({ dnsDomains: next.dnsDomains, dnsServers: next.dnsServers })
    return next
  }

  const persist = async (next: EnvConfig): Promise<void> => {
    await window.kontur.config.upsertEnv(next)
    await onSaved()
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = flushLists()
      await persist(next)
      await window.kontur.vpn.applyDns(env.id)
      await onSaved()
      toast.success('Split-DNS применён')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = flushLists()
      await persist(next)
      await window.kontur.vpn.clearDns(env.id)
      toast.success('Split-DNS снят')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const capture = async (): Promise<void> => {
    setBusy(true)
    try {
      const servers = await window.kontur.vpn.captureDns()
      if (!servers.length) {
        toast.error('Не удалось прочитать DNS из системы — поднимите VPN и повторите')
        return
      }
      setServersRaw(servers.join(' '))
      patch({ dnsServers: servers })
      toast.success(`DNS: ${servers.join(', ')}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-3">
      <Switch
        checked={enabled}
        onCheckedChange={(v) => patch({ splitDns: v })}
        id={`splitdns-${env.id}`}
        className="mt-0.5"
      />
      <div className="grid min-w-0 flex-1 gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`splitdns-${env.id}`} className="text-xs font-medium">
            Раздельный DNS
          </Label>
          <p className="text-xs text-muted-foreground">
            Чтобы при двух поднятых туннелях работали оба (и после ручного VPN). Домены — из
            URL сервисов, серверы — из системы в момент применения. Нужен пароль
            администратора для записи в /etc/resolver.
          </p>
          {previewDomains.length ? (
            <p className="font-mono text-[11px] text-muted-foreground/70">
              будет: {previewDomains.join(' ')}
              {parseDnsList(serversRaw).length
                ? ` → ${parseDnsList(serversRaw).join(' ')}`
                : ' → (снимок DNS при применении)'}
            </p>
          ) : (
            <p className="text-[11px] text-amber-600/90 dark:text-amber-400/90">
              Нет доменов — заполните URL сервисов или укажите домены ниже.
            </p>
          )}
        </div>

        {enabled && (
          <>
            <Field
              label="Домены"
              hint={
                derived.length
                  ? `Из сервисов: ${derived.join(' ')}. Пусто — использовать их.`
                  : 'Через пробел, например: corp.example.com intranet.local'
              }
            >
              <Input
                className="font-mono text-xs"
                placeholder={derived.join(' ') || 'corp.example.com'}
                value={domainsRaw}
                onChange={(e) => setDomainsRaw(e.target.value)}
                onBlur={() => patch({ dnsDomains: parseDnsList(domainsRaw) })}
              />
            </Field>
            <Field
              label="DNS-серверы"
              hint="IP через пробел. Пусто — снять с системы при «Применить» (VPN должен быть уже up)."
            >
              <div className="flex gap-2">
                <Input
                  className="font-mono text-xs"
                  placeholder="10.x.x.x"
                  value={serversRaw}
                  onChange={(e) => setServersRaw(e.target.value)}
                  onBlur={() => patch({ dnsServers: parseDnsList(serversRaw) })}
                />
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void capture()}>
                  Считать
                </Button>
              </div>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={busy} onClick={() => void apply()}>
                Применить сейчас
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>
                Сбросить
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function EnvsTab({
  secrets,
  onSecrets
}: {
  secrets: SecretMeta[]
  onSecrets: (m: SecretMeta[]) => void
}): JSX.Element {
  const { config, load } = useStore()
  const [drafts, setDrafts] = useState<Record<string, EnvConfig>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [clearing, setClearing] = useState<EnvConfig | null>(null)
  const [found, setFound] = useState<
    Record<
      string,
      {
        cli: string | null
        sites: { site: string; username: string | null; authMethod: string | null }[]
      }
    >
  >({})

  const draftOf = (env: EnvConfig): EnvConfig => drafts[env.id] ?? env
  const patch = (env: EnvConfig, p: Partial<EnvConfig>): void =>
    setDrafts((d) => ({ ...d, [env.id]: { ...draftOf(env), ...p } }))

  const save = async (env: EnvConfig): Promise<void> => {
    await window.kontur.config.upsertEnv(draftOf(env))
    await load()
    setDrafts((d) => {
      const next = { ...d }
      delete next[env.id]
      return next
    })
    toast.success('Контур сохранён')
  }

  return (
    <>
      {(config?.envs ?? []).filter((e) => e.vpn.kind === 'checkpoint').length > 1 && (
        <Callout tone="warning">
          Оба контура — официальный Check Point: клиент держит <strong>один сайт</strong>. Для
          параллели поставьте второй контур на <strong>snx-rs</strong> или Tunnelblick — банк
          остаётся на Endpoint Security / Indeed.
        </Callout>
      )}

      <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        Подключение
      </h2>
      <EnvConnect onConfigure={(env) => setEditing(env.id)} />

      {/* Доступы — в модалке: держать на странице две колонки длинных форм
          значило листать настройки вместо того, чтобы видеть состояние контуров. */}
      {(config?.envs ?? [])
        .filter((e) => e.id !== 'shared')
        .map((env) => {
        const d = draftOf(env)
        const dirty = JSON.stringify(d) !== JSON.stringify(env)
        return (
          <Dialog
            key={env.id}
            open={editing === env.id}
            onOpenChange={(open) => setEditing(open ? env.id : null)}
          >
            <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
              <DialogHeader className="flex-row items-center gap-2.5 border-b px-5 py-3.5">
                <EnvDot accent={d.accent} tunnel="up" />
                <DialogTitle className="text-sm">{d.name}</DialogTitle>
                <Badge variant="outline" style={{ color: d.accent, borderColor: `${d.accent}55` }}>
                  {d.short}
                </Badge>
                <DialogDescription className="sr-only">
                  Логин, пароль и технические параметры контура.
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {/* Простое и главное: логин, пароль и код Indeed. Всё остальное — ниже. */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Логин">
                  <Input
                    className="font-mono text-xs"
                    placeholder="i.ivanov"
                    value={d.vpn.username ?? ''}
                    onChange={(e) => patch(env, { vpn: { ...d.vpn, username: e.target.value || null } })}
                  />
                </Field>
                <Field label="Пароль">
                  <SecretField
                    secretRef={`env.${env.id}.vpn`}
                    label={`${d.name} · VPN`}
                    meta={secrets.find((x) => x.ref === `env.${env.id}.vpn`)}
                    onSaved={onSecrets}
                  />
                </Field>
              </div>

              <div className="flex items-start gap-3">
                <Switch
                  checked={d.vpn.requiresOtp}
                  onCheckedChange={(v) => patch(env, { vpn: { ...d.vpn, requiresOtp: v } })}
                  id={`otp-simple-${env.id}`}
                  className="mt-0.5"
                />
                <div className="grid gap-1">
                  <Label htmlFor={`otp-simple-${env.id}`} className="text-xs font-medium">
                    Запрашивать код Indeed при подключении
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Код вводится один раз при подключении и нигде не хранится.
                  </p>
                </div>
              </div>

              {/* Всё техническое — свёрнуто, по умолчанию не мешает. Строка-ссылка
                  со стрелкой, а не рамка: рамка читалась как пустое поле ввода. */}
              <details className="group">
                <summary className="-mx-1 flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  Дополнительно — сайт, DNS, сертификат, цвет
                </summary>
                <div className="mt-3 space-y-4 rounded-lg border bg-muted/20 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Название">
                  <Input value={d.name} onChange={(e) => patch(env, { name: e.target.value })} />
                </Field>
                <Field label="Короткая метка">
                  <Input
                    maxLength={5}
                    value={d.short}
                    onChange={(e) => patch(env, { short: e.target.value.toUpperCase() })}
                  />
                </Field>
              </div>

              <Field
                label="Цвет контура"
                hint="Этим цветом подсвечиваются вкладки и кнопки отправки. Берите максимально непохожие оттенки — это защита от отправки не в ту среду."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                    value={d.accent}
                    onChange={(e) => patch(env, { accent: e.target.value })}
                  />
                  <Input
                    className="font-mono text-xs"
                    value={d.accent}
                    onChange={(e) => patch(env, { accent: e.target.value })}
                  />
                </div>
              </Field>

              <Field
                label="Адрес для проверки туннеля"
                hint="Любой внутренний адрес контура. Ответ 401 или 403 тоже считается успехом — важно лишь, что сеть доступна."
              >
                <Input
                  className="font-mono text-xs"
                  placeholder="https://jira.bank.internal"
                  value={d.healthCheckUrl ?? ''}
                  onChange={(e) => patch(env, { healthCheckUrl: e.target.value.trim() || null })}
                />
              </Field>

              <Field
                label="Корпоративный CA (при TLS-инспекции)"
                hint="Нужен коннекторам: встроенные вкладки берут сертификат из системного хранилища сами, а Node — нет."
              >
                <div className="flex items-center gap-2">
                  <Input
                    className="font-mono text-xs"
                    placeholder="не задан"
                    value={d.caCertPath ?? ''}
                    onChange={(e) => patch(env, { caCertPath: e.target.value.trim() || null })}
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const p = await window.kontur.app.pickFile([
                        { name: 'Сертификаты', extensions: ['pem', 'crt', 'cer'] }
                      ])
                      if (p) patch(env, { caCertPath: p })
                    }}
                  >
                    Выбрать…
                  </Button>
                </div>
              </Field>

              <div className="flex items-start gap-3 rounded-md border border-l-[3px] border-l-[var(--warning)] bg-muted/40 p-3">
                <Switch
                  checked={d.allowInsecureTls}
                  onCheckedChange={(v) => patch(env, { allowInsecureTls: v })}
                  id={`insecure-${env.id}`}
                  className="mt-0.5"
                />
                <div className="grid gap-1">
                  <Label htmlFor={`insecure-${env.id}`} className="text-xs font-medium">
                    Доверять сертификатам контура без проверки
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Если сертификат внутренний и корпоративный CA взять негде. Проверка TLS
                    отключается только для этого контура (вкладки, коннекторы и snx-rs gateway).
                    Включайте, лишь если доверяете сети контура.
                  </p>
                </div>
              </div>

              <Field label="Прокси (если контур уедет за отдельный туннель)">
                <Input
                  className="font-mono text-xs"
                  placeholder="socks5://127.0.0.1:1080"
                  value={d.proxy ?? ''}
                  onChange={(e) => patch(env, { proxy: e.target.value.trim() || null })}
                />
              </Field>

              <Separator />

              <SplitDnsSettings
                env={env}
                draft={d}
                patch={(p) => patch(env, p)}
                onSaved={load}
              />

              <Separator />

              <div className="space-y-4">
                <div>
                  <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    Туннель
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                    Приложение запускает штатный клиент или системный профиль, но не заменяет их.
                    Многофакторный вход подтверждаете вы — обходить его приложение не пытается.
                  </p>
                </div>

                <Field label="Чем поднимается">
                  <Select
                    value={d.vpn.kind}
                    onValueChange={(v) => patch(env, { vpn: { ...d.vpn, kind: v as VpnKind } })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(VPN_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {d.vpn.kind === 'scutil' && (
                  <Field
                    label="Имя профиля"
                    hint="Как он называется в системных настройках сети. Список: scutil --nc list. Пароль хранит сама система, права root не нужны."
                  >
                    <Input
                      className="font-mono text-xs"
                      placeholder="Ecom VPN"
                      value={d.vpn.profile ?? ''}
                      onChange={(e) =>
                        patch(env, { vpn: { ...d.vpn, profile: e.target.value || null } })
                      }
                    />
                  </Field>
                )}

                {d.vpn.kind === 'command' && (
                  <>
                    <Field
                      label="Исполняемый файл"
                      hint="Запускается напрямую, без shell. Если команде нужен root, добавьте её в sudoers с NOPASSWD — пароль приложение не спрашивает и не хранит."
                    >
                      <Input
                        className="font-mono text-xs"
                        placeholder="/opt/homebrew/bin/wg-quick"
                        value={d.vpn.command ?? ''}
                        onChange={(e) =>
                          patch(env, { vpn: { ...d.vpn, command: e.target.value || null } })
                        }
                      />
                    </Field>
                    <Field label="Аргументы" hint="Через пробел.">
                      <Input
                        className="font-mono text-xs"
                        placeholder="up ecom"
                        value={d.vpn.args.join(' ')}
                        onChange={(e) =>
                          patch(env, {
                            vpn: { ...d.vpn, args: e.target.value.split(/\s+/).filter(Boolean) }
                          })
                        }
                      />
                    </Field>
                  </>
                )}

                {d.vpn.kind === 'app' && (
                  <>
                    <Field label="Клиент" hint="Приложение будет запущено через open -a.">
                      <div className="flex items-center gap-2">
                        <Input
                          className="font-mono text-xs"
                          placeholder="/Applications/Endpoint Security VPN.app"
                          value={d.vpn.appPath ?? ''}
                          onChange={(e) =>
                            patch(env, { vpn: { ...d.vpn, appPath: e.target.value || null } })
                          }
                        />
                        <Button
                          variant="outline"
                          onClick={async () => {
                            const f = await window.kontur.app.pickFile([
                              { name: 'Приложения', extensions: ['app'] }
                            ])
                            if (f) patch(env, { vpn: { ...d.vpn, appPath: f } })
                          }}
                        >
                          Выбрать…
                        </Button>
                      </div>
                    </Field>
                    <Field
                      label="AppleScript для нажатия «Connect» (необязательно)"
                      hint="Если клиент не подключается сам при запуске. Выполняется через osascript после открытия окна."
                    >
                      <Textarea
                        className="min-h-20 font-mono text-xs"
                        placeholder={'tell application "System Events" to tell process "Endpoint Security VPN"\n  click button "Connect" of window 1\nend tell'}
                        value={d.vpn.appleScript ?? ''}
                        onChange={(e) =>
                          patch(env, { vpn: { ...d.vpn, appleScript: e.target.value || null } })
                        }
                      />
                    </Field>
                  </>
                )}


                {d.vpn.kind === 'checkpoint' && (
                  <>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const res = await window.kontur.vpn.discoverCheckpoint()
                          setFound((f) => ({ ...f, [env.id]: res }))
                          if (res.cli) patch(env, { vpn: { ...d.vpn, cliPath: res.cli } })
                          if (!res.sites.length) {
                            toast.error(
                              res.cli
                                ? 'Клиент найден, но список сайтов пуст — запущена ли служба Endpoint Security?'
                                : 'CLI клиента Check Point не найден'
                            )
                          }
                        }}
                      >
                        Прочитать сайты из клиента
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Клиент сам знает свои сайты и логины
                      </span>
                    </div>

                    {found[env.id]?.sites.length ? (
                      <div className="rounded-md border bg-muted/40 p-3">
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          Найденные подключения — нажмите нужное:
                        </p>
                        <div className="space-y-1">
                          {found[env.id].sites.map((site) => (
                            <button
                              key={site.site}
                              type="button"
                              onClick={() =>
                                patch(env, {
                                  vpn: {
                                    ...d.vpn,
                                    site: site.site,
                                    username: site.username,
                                    cliPath: found[env.id].cli ?? d.vpn.cliPath
                                  }
                                })
                              }
                              className="block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
                            >
                              <span className="font-mono text-xs">{site.site}</span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {site.username ? `${site.username} · ` : ''}
                                {site.authMethod ?? 'метод неизвестен'}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Сайт">
                        <Input
                          className="font-mono text-xs"
                          placeholder="vpn.example.ru"
                          value={d.vpn.site ?? ''}
                          onChange={(e) => patch(env, { vpn: { ...d.vpn, site: e.target.value || null } })}
                        />
                      </Field>
                      <Field label="Логин">
                        <Input
                          className="font-mono text-xs"
                          value={d.vpn.username ?? ''}
                          onChange={(e) =>
                            patch(env, { vpn: { ...d.vpn, username: e.target.value || null } })
                          }
                        />
                      </Field>
                    </div>

                    <Field
                      label="Пароль"
                      hint="Лежит в системном keychain и подставляется в штатный клиент в момент подключения. Второй фактор это не заменяет: если контур требует подтверждения, подтверждать всё равно вам."
                    >
                      <SecretField
                        secretRef={`env.${env.id}.vpn`}
                        label={`${d.name} · VPN`}
                        meta={secrets.find((x) => x.ref === `env.${env.id}.vpn`)}
                        onSaved={onSecrets}
                      />
                    </Field>

                    <Field
                      label="CLI клиента"
                      hint="Без него подключение пойдёт через автоматизацию интерфейса, что заметно хуже."
                    >
                      <Input
                        className="font-mono text-xs"
                        placeholder="CLI не найден"
                        value={d.vpn.cliPath ?? ''}
                        onChange={(e) => patch(env, { vpn: { ...d.vpn, cliPath: e.target.value || null } })}
                      />
                    </Field>

                    <div className="flex items-center gap-3">
                      <Switch
                        checked={d.vpn.requiresOtp}
                        onCheckedChange={(v) => patch(env, { vpn: { ...d.vpn, requiresOtp: v } })}
                        id={`otp-${env.id}`}
                      />
                      <Label htmlFor={`otp-${env.id}`} className="text-xs text-muted-foreground">
                        Требует одноразовый код (Indeed). Код спрашивается при подключении и нигде
                        не хранится — при старте такой контур автоматически не поднимается.
                      </Label>
                    </div>

                    {d.vpn.cliPath && (
                      <Field
                        label="Аргументы"
                        hint="Подстановки {site}, {user}, {password}, {code}. Пара «флаг и значение» выбрасывается, если значения нет — тогда клиент спросит сам."
                      >
                        <Input
                          className="font-mono text-xs"
                          value={d.vpn.cliArgs.join(' ')}
                          onChange={(e) =>
                            patch(env, {
                              vpn: { ...d.vpn, cliArgs: e.target.value.split(/\s+/).filter(Boolean) }
                            })
                          }
                        />
                      </Field>
                    )}
                  </>
                )}

                {d.vpn.kind === 'openvpn' && (
                  <>
                    <Field
                      label="Имя конфигурации Tunnelblick"
                      hint="Рекомендуется: импортируйте .ovpn в Tunnelblick (перетащите на его иконку) и впишите имя конфигурации. Тогда пароль не спрашивается каждый раз."
                    >
                      <Input
                        className="font-mono text-xs"
                        placeholder="i.ivanov"
                        value={d.vpn.profile ?? ''}
                        onChange={(e) => patch(env, { vpn: { ...d.vpn, profile: e.target.value || null } })}
                      />
                    </Field>
                    <Field
                      label="или путь к .ovpn (напрямую)"
                      hint="Без Tunnelblick — запуск openvpn с разовым запросом прав администратора."
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          className="font-mono text-xs"
                          placeholder="~/Desktop/contour.ovpn"
                          value={d.vpn.ovpnPath ?? ''}
                          onChange={(e) => patch(env, { vpn: { ...d.vpn, ovpnPath: e.target.value || null } })}
                        />
                        <Button
                          variant="outline"
                          onClick={async () => {
                            const f = await window.kontur.app.pickFile([
                              { name: 'OpenVPN', extensions: ['ovpn', 'conf'] }
                            ])
                            if (f) patch(env, { vpn: { ...d.vpn, ovpnPath: f } })
                          }}
                        >
                          Выбрать…
                        </Button>
                      </div>
                    </Field>
                  </>
                )}

                {d.vpn.kind === 'snx-rs' && (
                  <>
                    <Callout tone="info">
                      Второй Check Point-gateway через snx-rs — параллельно с официальным Endpoint
                      Security. На macOS один раз поставьте официальный SNX-RS.pkg (root-служба), иначе
                      snxctl ответит «Нет соединения со службой».
                    </Callout>
                    <Field label="Сервер" hint="host или host:port с портала VPN.">
                      <Input
                        className="font-mono text-xs"
                        placeholder="vpn.example.com"
                        value={d.vpn.snxServer ?? ''}
                        onChange={(e) =>
                          patch(env, { vpn: { ...d.vpn, snxServer: e.target.value || null } })
                        }
                      />
                    </Field>
                    <Field
                      label="Login type"
                      hint="Строка вида vpn_xxx с gateway. Кнопка запрашивает список у сервера."
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          className="font-mono text-xs"
                          placeholder="vpn_Username_Password"
                          value={d.vpn.snxLoginType ?? ''}
                          onChange={(e) =>
                            patch(env, { vpn: { ...d.vpn, snxLoginType: e.target.value || null } })
                          }
                        />
                        <Button
                          variant="outline"
                          disabled={!d.vpn.snxServer?.trim()}
                          onClick={() => {
                            void (async () => {
                              try {
                                const types = await window.kontur.vpn.snxLoginTypes(d.vpn.snxServer!, {
                                  allowInsecureTls: d.allowInsecureTls,
                                  caCertPath: d.caCertPath
                                })
                                if (!types.length) {
                                  toast.message('Сервер не вернул login-type — введите вручную')
                                  return
                                }
                                if (types.length === 1) {
                                  patch(env, { vpn: { ...d.vpn, snxLoginType: types[0]! } })
                                  toast.success(`login-type: ${types[0]}`)
                                  return
                                }
                                const pick = types[0]!
                                patch(env, { vpn: { ...d.vpn, snxLoginType: pick } })
                                toast.message(`Выбрано ${pick}. Доступны: ${types.join(', ')}`)
                              } catch (e) {
                                toast.error(e instanceof Error ? e.message : String(e))
                              }
                            })()
                          }}
                        >
                          Спросить сервер
                        </Button>
                      </div>
                    </Field>
                    <SnxAvailabilityHint />
                  </>
                )}

                {d.vpn.kind !== 'none' && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Сколько ждать сеть, секунд"
                      hint="При подтверждении входа с телефона закладывайте запас."
                    >
                      <Input
                        type="number"
                        min={10}
                        max={600}
                        value={d.vpn.waitSeconds}
                        onChange={(e) =>
                          patch(env, {
                            vpn: { ...d.vpn, waitSeconds: Number(e.target.value) || 90 }
                          })
                        }
                      />
                    </Field>
                    <div className="flex items-center gap-3 self-end pb-2">
                      <Switch
                        checked={d.vpn.autoConnect}
                        onCheckedChange={(v) => patch(env, { vpn: { ...d.vpn, autoConnect: v } })}
                        id={`auto-${env.id}`}
                      />
                      <Label htmlFor={`auto-${env.id}`} className="text-xs text-muted-foreground">
                        Поднимать при запуске приложения
                      </Label>
                    </div>
                  </div>
                )}
              </div>
                </div>
              </details>
              </div>

              {/* Действия закреплены внизу модалки: форма длинная, кнопка
                  «Сохранить» не должна уезжать за край прокрутки. */}
              <div className="flex items-center gap-3 border-t px-5 py-3.5">
                {/* Пока менять нечего — нейтральная кнопка: выключенный оранжевый
                    на половине прозрачности выглядел как сломанный цвет. */}
                <Button
                  size="sm"
                  variant={dirty ? 'default' : 'outline'}
                  disabled={!dirty}
                  onClick={() => void save(env)}
                >
                  Сохранить
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground">есть несохранённые изменения</span>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setClearing(env)}>
                  Сбросить сессии контура
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )
      })}

      <ConfirmDialog
        open={clearing !== null}
        title={`Выйти из всех сервисов контура «${clearing?.name ?? ''}»?`}
        confirmLabel="Сбросить"
        onConfirm={() => {
          if (clearing) void window.kontur.env.clearSession(clearing.id)
          toast.success('Сессии контура сброшены')
        }}
        onOpenChange={(o) => !o && setClearing(null)}
      >
        Куки и localStorage этого контура будут удалены. Второй контур не затрагивается.
      </ConfirmDialog>
    </>
  )
}


function NotesTab(): JSX.Element {
  const { config, load } = useStore()
  return (
    <Card>
      <CardContent>
        <Field
          label="Папка с заметками"
          hint="Обычная папка с markdown-файлами: её можно открыть в Obsidian, положить в git или синхронизировать чем угодно. Приложение ничего не прячет в свой формат."
        >
          <div className="flex items-center gap-2">
            <Input readOnly className="font-mono text-xs" value={config?.vaultPath ?? ''} />
            <Button
              variant="outline"
              onClick={async () => {
                const p = await window.kontur.notes.pickVault()
                if (p) await load()
              }}
            >
              Выбрать…
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void window.kontur.notes.revealVault()}>
              <ExternalLink />
            </Button>
          </div>
        </Field>
      </CardContent>
    </Card>
  )
}

/** Выключатель системных уведомлений о новом в подключённых сервисах. */
function NotificationsToggle(): JSX.Element {
  const { config, patchConfig } = useStore()
  const on = config?.notifications ?? true
  return (
    <div className="flex items-start gap-3">
      <Switch
        checked={on}
        onCheckedChange={(v) => void patchConfig({ notifications: v })}
        id="notifications"
        className="mt-0.5"
      />
      <div className="grid gap-1">
        <Label htmlFor="notifications" className="text-xs font-medium">
          Уведомления
        </Label>
        <p className="text-xs text-muted-foreground">
          Баннеры Notification Center: письма, Mattermost, задачи, встречи и напоминания за 15/5 мин.
          Клик по баннеру открывает место внутри Kontur. На macOS: Системные настройки → Уведомления →
          Kontur.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-1 w-fit"
          onClick={async () => {
            try {
              const r = await window.kontur.app.notifyTest()
              if (r.ok) toast.success(r.message)
              else toast.error(r.message)
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Проверить уведомление
        </Button>
      </div>
    </div>
  )
}

/** Проверка обновлений через GitHub Releases (скачать DMG вручную). */
function UpdateChecker(): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.kontur.app.getVersion().then(setVersion)
  }, [])

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      const info = await window.kontur.app.checkUpdate()
      if (!info.available) {
        toast.success(`У вас актуальная версия ${info.currentVersion}`)
        return
      }
      toast.message(`Доступна ${info.latestVersion}`, {
        description: `Сейчас установлена ${info.currentVersion}. Скачайте DMG и замените приложение в Applications.`,
        action: {
          label: 'Скачать',
          onClick: () => void window.kontur.app.openUpdate(info.downloadUrl)
        },
        duration: 20_000
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-1">
      <Label className="text-xs font-medium">Обновления</Label>
      <p className="text-xs text-muted-foreground">
        Версия {version || '…'}. Проверяем публичные релизы на GitHub — без автозамены приложения
        (не нужен Apple Developer ID).
      </p>
      <Button size="sm" variant="outline" className="mt-1 w-fit" disabled={busy} onClick={() => void check()}>
        {busy ? 'Проверяем…' : 'Проверить обновления'}
      </Button>
    </div>
  )
}

function ProfileTab(): JSX.Element {
  const config = useStore((s) => s.config)
  const patchConfig = useStore((s) => s.patchConfig)
  const saveService = useStore((s) => s.saveService)
  const saved = config?.profile
  const [draft, setDraft] = useState<UserProfile>(() => saved ?? defaultProfile())
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [hasPass, setHasPass] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (saved) setDraft(saved)
  }, [saved])
  useEffect(() => {
    void window.kontur.secrets.has(PROFILE_PASSWORD_REF).then(setHasPass)
  }, [])

  const mismatch = Boolean(password2) && password !== password2

  const save = async (): Promise<void> => {
    if (mismatch) {
      toast.error('Пароли не совпадают')
      return
    }
    setBusy(true)
    try {
      if (password.trim()) {
        await saveProfilePassword(password)
        setHasPass(true)
        setPassword('')
        setPassword2('')
      }
      await patchConfig({ profile: draft })
      toast.success('Профиль сохранён')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pushCreds = async (): Promise<void> => {
    setBusy(true)
    try {
      await patchConfig({ profile: draft })
      if (password.trim()) {
        if (mismatch) {
          toast.error('Пароли не совпадают')
          return
        }
        await saveProfilePassword(password)
        setHasPass(true)
        setPassword('')
        setPassword2('')
      }
      const n = await applyProfileCredentials({
        username: draft.username,
        password: undefined,
        services: useStore.getState().config?.services ?? [],
        saveService
      })
      toast.success(n ? `Логин раздан в ${n} сервис(ов)` : 'Нет подходящих сервисов')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Профиль пользователя</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field label="Отображаемое имя" hint="На заставке и экране блокировки.">
          <Input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            placeholder="Имя"
          />
        </Field>
        <Field label="Логин / email" hint="Подставляется в формы входа сервисов (auto-login).">
          <Input
            value={draft.username}
            autoComplete="username"
            onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            placeholder="name@company.com"
          />
        </Field>
        <Field
          label={hasPass ? 'Новый пароль профиля' : 'Пароль профиля'}
          hint="Для экрана блокировки и как общий пароль сервисов. Хранится в keychain."
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasPass ? 'Оставьте пустым, чтобы не менять' : '••••••••'}
          />
        </Field>
        <Field label="Пароль ещё раз">
          <Input
            type="password"
            autoComplete="new-password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
        </Field>
        {mismatch && <p className="text-xs text-destructive">Пароли не совпадают</p>}
        {hasPass && !password && (
          <p className="text-xs text-muted-foreground">Пароль профиля уже задан.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Заставка, мин" hint="0 — выключить. Wavy-фон как при загрузке.">
            <Input
              type="number"
              min={0}
              max={120}
              value={draft.screensaverMinutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  screensaverMinutes: Math.max(0, Number(e.target.value) || 0)
                })
              }
            />
          </Field>
          <Field label="Блокировка, мин" hint="0 — выключить. После простоя — экран логина.">
            <Input
              type="number"
              min={0}
              max={240}
              value={draft.lockMinutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  lockMinutes: Math.max(0, Number(e.target.value) || 0)
                })
              }
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" disabled={busy || mismatch} onClick={() => void save()}>
            Сохранить
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !draft.username.trim()}
            onClick={() => void pushCreds()}
          >
            Раздать логин в сервисы
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.dispatchEvent(new Event('kontur:lock'))}
          >
            Заблокировать сейчас
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function AppearanceTab(): JSX.Element {
  const { config, setTheme } = useStore()
  const current = config?.theme ?? 'system'
  const options: { id: ThemePref; label: string }[] = [
    { id: 'system', label: 'Системная' },
    { id: 'light', label: 'Светлая' },
    { id: 'dark', label: 'Тёмная' }
  ]

  return (
    <Card>
      <CardContent className="space-y-5">
        <Field label="Тема" hint="Системная тема следует за настройками macOS и переключается на лету.">
          <Segmented
            ariaLabel="Тема"
            value={current}
            onChange={(v) => void setTheme(v as ThemePref)}
            items={options.map((o) => ({ value: o.id, label: o.label }))}
          />
        </Field>
        <Field
          label="Шрифты"
          hint="Интерфейс — Golos Text, моноширинный — IBM Plex Mono, текст заметок — IBM Plex Serif. Шрифты встроены в приложение и не тянутся из сети."
        >
          <p className="font-serif text-base">Съешь ещё этих мягких французских булок</p>
        </Field>
        <WallpaperField />
        <WidgetsField />
        <LinkOpenField />
        <BrowserField />
        <NotificationsToggle />
        <UpdateChecker />
      </CardContent>
    </Card>
  )
}

/** Какие виджеты показывать на рабочем столе и где они лежат. */
function WidgetsField(): JSX.Element {
  const widgets = useStore((s) => s.config?.widgets)
  const patchConfig = useStore((s) => s.patchConfig)
  const layout = (id: WidgetId): WidgetLayout => widgets?.[id] ?? { visible: true, x: null, y: null }
  const moved = WIDGET_IDS.filter((id) => layout(id).x != null).length

  const patch = (next: Partial<Record<WidgetId, WidgetLayout>>): void => {
    const base = Object.fromEntries(WIDGET_IDS.map((id) => [id, layout(id)])) as Record<
      WidgetId,
      WidgetLayout
    >
    void patchConfig({ widgets: { ...base, ...next } })
  }

  return (
    <Field
      label="Виджеты рабочего стола"
      hint="Виджеты можно таскать мышью за ручку в правом верхнем углу карточки — она появляется при наведении. Там же крестик, чтобы убрать виджет со стола."
    >
      <div className="flex flex-col gap-2">
        {WIDGET_IDS.map((id) => (
          <div key={id} className="flex items-center gap-3">
            <Switch
              id={`widget-${id}`}
              checked={layout(id).visible}
              onCheckedChange={(v) => patch({ [id]: { ...layout(id), visible: v } })}
            />
            <Label htmlFor={`widget-${id}`} className="text-xs font-medium">
              {WIDGET_TITLES[id]}
            </Label>
            {layout(id).x != null && (
              <span className="text-[11px] text-muted-foreground">перемещён</span>
            )}
          </div>
        ))}
        {moved > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1 self-start"
            onClick={() =>
              patch(
                Object.fromEntries(
                  WIDGET_IDS.map((id) => [id, { ...layout(id), x: null, y: null }])
                ) as Partial<Record<WidgetId, WidgetLayout>>
              )
            }
          >
            Вернуть на место ({moved})
          </Button>
        )}
      </div>
    </Field>
  )
}

/** Куда уводить ссылки из писем, заметок, встреч и закладок. */
function LinkOpenField(): JSX.Element {
  const current = useStore((s) => s.config?.linkOpen ?? 'app')
  const patchConfig = useStore((s) => s.patchConfig)
  const options: { id: LinkOpenMode; label: string }[] = [
    { id: 'app', label: 'В приложении' },
    { id: 'system', label: 'В браузере системы' }
  ]

  const pick = (mode: LinkOpenMode): void => {
    if (mode === current) return
    void patchConfig({ linkOpen: mode })
  }

  return (
    <Field
      label="Веб-ссылки"
      hint="«В приложении» — ссылка открывается вкладкой Kontur, если адрес принадлежит подключённому сервису: сессия контура уже есть, входить заново не нужно. Посторонний сайт забирает встроенный браузер. «В браузере системы» — всегда наружу, отдельным окном."
    >
      <Segmented
        ariaLabel="Веб-ссылки"
        value={current}
        onChange={(v) => pick(v as LinkOpenMode)}
        items={options.map((o) => ({ value: o.id, label: o.label }))}
      />
    </Field>
  )
}

/** Встроенный браузер: стартовая страница, поиск и контур по умолчанию. */
function BrowserField(): JSX.Element {
  const browser = useStore((s) => s.config?.browser)
  const envs = useStore((s) => s.config?.envs ?? [])
  const patchConfig = useStore((s) => s.patchConfig)
  const [draft, setDraft] = useState<BrowserConfig | null>(null)
  const current = draft ?? browser ?? defaultBrowser()

  const patch = (next: Partial<BrowserConfig>): void => {
    const merged = { ...current, ...next }
    setDraft(merged)
    void patchConfig({ browser: merged })
  }

  return (
    <Field
      label="Браузер"
      hint="Вкладка браузера принадлежит контуру: она ходит в сеть его сессией, видит его куки и его туннель. Контур по умолчанию — для новых вкладок и для посторонних ссылок, у которых своего контура нет. В шаблоне поиска %s — место запроса."
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          className="font-mono text-xs"
          placeholder="https://ya.ru"
          aria-label="Стартовая страница"
          value={current.homeUrl}
          onChange={(e) => patch({ homeUrl: e.target.value })}
        />
        <Input
          className="font-mono text-xs"
          placeholder="https://ya.ru/search/?text=%s"
          aria-label="Шаблон поиска"
          value={current.searchUrl}
          onChange={(e) => patch({ searchUrl: e.target.value })}
        />
        <Select value={current.defaultEnvId} onValueChange={(v) => patch({ defaultEnvId: v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {envs
              .filter((e) => e.enabled)
              .map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </Field>
  )
}

function WallpaperField(): JSX.Element {
  const { config, patchConfig } = useStore()
  const current = config?.wallpaper
  const [busy, setBusy] = useState(false)

  const setWallpaper = (w: Wallpaper): void => void patchConfig({ wallpaper: w })

  const pickImage = async (): Promise<void> => {
    setBusy(true)
    try {
      const dataUrl = await window.kontur.app.pickImage()
      if (dataUrl) setWallpaper({ kind: 'image', value: dataUrl })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field
      label="Обои рабочего стола"
      hint="Фон за плавающими окнами. Своя картинка хранится прямо в конфиге. Живые обои рисуются анимацией и встают на паузу, пока окно скрыто."
    >
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-2">
          {/* Живые обои впереди: их легко проглядеть среди двух десятков плиток. */}
          {WALLPAPER_ANIMATED.map((p) => (
            <button
              key={p.key}
              type="button"
              title={`${p.label} · живые обои`}
              onClick={() => setWallpaper({ kind: 'animated', value: p.key })}
              className={cn(
                'relative size-9 overflow-hidden rounded-md border-2 transition-colors',
                current?.kind === 'animated' && current.value === p.key
                  ? 'border-primary'
                  : 'border-transparent'
              )}
              style={{ background: p.preview }}
            >
              <Sparkles className="absolute right-0.5 bottom-0.5 size-3 text-white/90 drop-shadow" />
            </button>
          ))}
          <span className="mx-1 w-px self-stretch bg-border" />
          {WALLPAPER_IMAGES.map((p) => (
            <button
              key={p.key}
              type="button"
              title={p.label}
              onClick={() => setWallpaper({ kind: 'image', value: p.key })}
              className={cn(
                'size-9 rounded-md border-2 bg-cover bg-center transition-colors',
                current?.kind === 'image' && current.value === p.key
                  ? 'border-primary'
                  : 'border-transparent'
              )}
              style={{ backgroundImage: `url(${p.url})` }}
            />
          ))}
          <span className="mx-1 w-px self-stretch bg-border" />
          {WALLPAPER_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              title={p.label}
              onClick={() => setWallpaper({ kind: 'gradient', value: p.key })}
              className={cn(
                'size-9 rounded-md border-2 transition-colors',
                current?.kind === 'gradient' && current.value === p.key
                  ? 'border-primary'
                  : 'border-transparent'
              )}
              style={{ background: p.css }}
            />
          ))}
          <span className="mx-1 w-px self-stretch bg-border" />
          {WALLPAPER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => setWallpaper({ kind: 'color', value: c })}
              className={cn(
                'size-9 rounded-md border-2 transition-colors',
                current?.kind === 'color' && current.value === c ? 'border-primary' : 'border-transparent'
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickImage()}>
          <ImageIcon />
          {current?.kind === 'image' && !WALLPAPER_IMAGES.some((p) => p.key === current.value)
            ? 'Заменить картинку…'
            : 'Своя картинка…'}
        </Button>
      </div>
    </Field>
  )
}

function CommsTab(): JSX.Element {
  const { config, patchConfig } = useStore()
  return (
    <>
      <Callout>
        Объединение не смешивает контуры: у каждого письма и события остаётся цветная метка своей
        среды, а отправить из одного контура в другой нельзя. Мы объединяем только представление,
        чтобы всё было в одном месте.
      </Callout>
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-3">
            <Switch
              checked={config?.unifyMail ?? true}
              onCheckedChange={(v) => void patchConfig({ unifyMail: v })}
              id="unify-mail"
            />
            <div className="grid gap-1">
              <Label htmlFor="unify-mail" className="text-xs font-medium">
                Единый ящик
              </Label>
              <p className="text-xs text-muted-foreground">
                Письма обоих контуров одним списком. Выключено — раздельно, с заголовком контура.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch
              checked={config?.unifyCalendar ?? true}
              onCheckedChange={(v) => void patchConfig({ unifyCalendar: v })}
              id="unify-cal"
            />
            <div className="grid gap-1">
              <Label htmlFor="unify-cal" className="text-xs font-medium">
                Единый календарь
              </Label>
              <p className="text-xs text-muted-foreground">
                События обоих контуров на одной сетке — видно наложения встреч между средами.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function LogsTab(): JSX.Element {
  const [text, setText] = useState('Загрузка…')
  const load = (): void => {
    void window.kontur.logs.read().then(setText)
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={load}>
          Обновить
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void window.kontur.logs.reveal()}>
          Показать файл
        </Button>
        <span className="text-xs text-muted-foreground">Обновляется автоматически каждые 3 с</span>
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap selectable">
        {text}
      </pre>
    </>
  )
}

function AssistantTab(): JSX.Element {
  const [info, setInfo] = useState<{ running: boolean; url: string; token: string } | null>(null)
  const [agents, setAgents] = useState<
    { id: string; name: string; detected: boolean; configured: boolean; configPath: string }[]
  >([])

  const reload = (): void => {
    void window.kontur.mcp.info().then(setInfo)
    void window.kontur.mcp.agents().then(setAgents)
  }
  useEffect(reload, [])

  const connect = async (id: string): Promise<void> => {
    const r = await window.kontur.mcp.connect(id)
    if (r.ok) toast.success(r.message)
    else toast.error(r.message)
    reload()
  }

  return (
    <>
      <Callout>
        Kontur поднимает локальный MCP-сервер и отдаёт агентам (Cursor, Codex, Claude) инструменты
        подключённых сервисов: найти и завести задачу в Jira, прокомментировать и одобрить ревью,
        написать страницу в Confluence, отправить сообщение, назначить встречу, вести заметки и
        личные дела планировщика. Агент работает через ваши контуры — токены сервисов ему не
        передаются, только безопасные операции.
      </Callout>

      <Card className="mb-4">
        <CardContent className="space-y-3">
          <Field label="MCP-сервер" hint="Локальный, только 127.0.0.1, доступ по токену.">
            <div className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${info?.running ? 'bg-[var(--success)]' : 'bg-muted-foreground'}`}
              />
              <Input readOnly className="font-mono text-xs" value={info?.url ?? 'не запущен'} />
            </div>
          </Field>
        </CardContent>
      </Card>

      <h2 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        Локальные агенты
      </h2>
      <Card className="gap-0 overflow-hidden py-0">
        {agents.map((a, i, arr) => (
          <div
            key={a.id}
            className={`flex items-center gap-3 px-4 py-3 ${i < arr.length - 1 ? 'border-b' : ''}`}
          >
            {/* Фирменные логотипы из svgl: у агентов они разные и сразу узнаются */}
            <span className="shrink-0 opacity-90">
              <AgentIcon id={a.id} size={18} />
            </span>
            <div className="grid min-w-0 flex-1">
              <span className="text-[13px] font-medium">{a.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {a.detected ? a.configPath : 'не обнаружен'}
              </span>
            </div>
            {a.configured && (
              <span className="text-xs text-[var(--success)]">подключён</span>
            )}
            <Button size="sm" variant={a.configured ? 'ghost' : 'outline'} onClick={() => void connect(a.id)}>
              {a.configured ? 'Переподключить' : 'Подключить'}
            </Button>
          </div>
        ))}
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        После подключения перезапустите агента. Claude Desktop и Codex ходят по stdio — для них
        используется мост <span className="font-mono">mcp-remote</span> (нужен Node с npx).
      </p>
    </>
  )
}

/** Сводный список всех кредов в keychain — показать / заменить / удалить. */
function SecretsTab({
  secrets,
  onSecrets
}: {
  secrets: SecretMeta[]
  onSecrets: (m: SecretMeta[]) => void
}): JSX.Element {
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    void window.kontur.secrets.available().then(setAvailable)
  }, [])

  const sorted = [...secrets].sort((a, b) => a.label.localeCompare(b.label, 'ru'))

  return (
    <>
      <Callout tone={available ? 'info' : 'warning'}>
        {available
          ? 'Все значения шифруются системным keychain и лежат только на этой машине. Никакой синхронизации наружу.'
          : 'Системное шифрование недоступно — сохранять секреты нельзя. Проверьте доступ к связке ключей.'}
      </Callout>

      <Card className="mt-4 gap-0 overflow-hidden py-0">
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">Пока ничего не сохранено.</p>
        ) : (
          sorted.map((s, i, arr) => (
            <div
              key={s.ref}
              className={`flex items-center gap-4 px-4 py-3 ${i < arr.length - 1 ? 'border-b' : ''}`}
            >
              <div className="grid min-w-0 flex-1">
                <span className="truncate text-[13px] font-medium">{s.label}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{s.ref}</span>
              </div>
              <div className="w-80 shrink-0">
                <SecretField secretRef={s.ref} label={s.label} meta={s} onSaved={onSecrets} />
              </div>
            </div>
          ))
        )}
      </Card>
    </>
  )
}

export function Settings(): JSX.Element {
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [tab, setTab] = useState('services')

  useEffect(() => {
    void window.kontur.secrets.list().then(setSecrets)
  }, [])

  return (
    <div className="w-full px-4 pt-5 pb-16 sm:px-6 lg:px-8">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Настройки</h1>
      <p className="mt-1 mb-6 text-muted-foreground">
        Адреса, логины и токены обоих контуров в одном месте.
      </p>

      <Segmented
        className="mb-6"
        ariaLabel="Разделы настроек"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'profile', label: 'Профиль' },
          { value: 'services', label: 'Сервисы' },
          { value: 'envs', label: 'Контуры' },
          { value: 'secrets', label: 'Пароли' },
          { value: 'general', label: 'Общее' },
          { value: 'assistant', label: 'AI-ассистент' },
          { value: 'logs', label: 'Логи' }
        ]}
      />

      {tab === 'profile' && <ProfileTab />}
      {tab === 'services' && <ServicesTab secrets={secrets} onSecrets={setSecrets} />}
      {tab === 'envs' && <EnvsTab secrets={secrets} onSecrets={setSecrets} />}
      {tab === 'secrets' && <SecretsTab secrets={secrets} onSecrets={setSecrets} />}
      {tab === 'general' && (
        <div className="space-y-8">
          <AppearanceTab />
          <section>
            <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Почта и календарь
            </h2>
            <CommsTab />
          </section>
          <section>
            <h2 className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Заметки
            </h2>
            <NotesTab />
          </section>
        </div>
      )}
      {tab === 'assistant' && <AssistantTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  )
}
