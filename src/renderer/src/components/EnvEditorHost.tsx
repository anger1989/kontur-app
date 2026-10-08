import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { EnvConfig, SecretMeta, VpnKind } from '@shared/types'
import { VPN_LABELS } from '@shared/defaults'
import { domainsFromServices, parseDnsList } from '@shared/dnsDomains'
import { useStore } from '@/store'
import { Callout } from '@/components/Callout'
import { ConfirmDialog } from '@/components/prompts'
import { EnvDot } from '@/components/EnvDot'
import { SecretField } from '@/components/SecretField'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

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

/**
 * Модалка настройки контура — общая для вкладки «Контуры» и меню в шапке.
 * Открывается через store.openEnvEditor(envId).
 */
export function EnvEditorHost(): JSX.Element {
  const config = useStore((s) => s.config)
  const load = useStore((s) => s.load)
  const editing = useStore((s) => s.envEditorId)
  const openEnvEditor = useStore((s) => s.openEnvEditor)
  const closeEnvEditor = useStore((s) => s.closeEnvEditor)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [drafts, setDrafts] = useState<Record<string, EnvConfig>>({})
  const [clearing, setClearing] = useState<EnvConfig | null>(null)

  useEffect(() => {
    void window.kontur.secrets.list().then(setSecrets)
  }, [editing])

  const onSecrets = (m: SecretMeta[]): void => setSecrets(m)
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
      {(config?.envs ?? [])
        .filter((e) => e.id !== 'shared')
        .map((env) => {
        const d = draftOf(env)
        const dirty = JSON.stringify(d) !== JSON.stringify(env)
        return (
          <Dialog
            key={env.id}
            open={editing === env.id}
            onOpenChange={(open) => (open ? openEnvEditor(env.id) : closeEnvEditor())}
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
