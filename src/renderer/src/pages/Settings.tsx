import { useEffect, useState, type JSX } from 'react'
import { ExternalLink, Image as ImageIcon, Plus, Sparkles } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type {
  BrowserConfig,
  EnvConfig,
  LinkOpenMode,
  SecretMeta,
  ServiceConfig,
  ThemePref,
  UserProfile,
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
  defaultProfile
} from '@shared/defaults'
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
import { SecretField } from '@/components/SecretField'
import { Diagnostics } from '@/components/Diagnostics'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Segmented } from '@/components/ui/segmented'

/**
 * У каких сервисов уже есть коннектор синхронизации по API. Остальным логин и
 * токен пока ни на что не влияют — работает только встроенная вкладка.
 */
const SYNC_KINDS = new Set(['mattermost', 'jira', 'confluence', 'gitlab', 'bitbucket'])

/** Сервисы, где можно взять сессионный токен из куки открытой вкладки. */
const SESSION_KINDS = new Set(['mattermost', 'gitlab', 'jira', 'confluence', 'bitbucket'])

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

function EnvsTab(): JSX.Element {
  const config = useStore((s) => s.config)
  const openEnvEditor = useStore((s) => s.openEnvEditor)

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
      <EnvConnect onConfigure={(env) => openEnvEditor(env.id)} />
      <p className="mt-3 text-xs text-muted-foreground">
        Логин, VPN и DNS открываются в модалке контура (та же, что из меню в шапке).
      </p>
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
      {tab === 'envs' && <EnvsTab />}
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
