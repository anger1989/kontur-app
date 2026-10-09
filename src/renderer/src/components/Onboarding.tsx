import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { EnvConfig, SecretMeta, ServiceConfig, ThemePref, UserProfile, VpnKind, Wallpaper } from '@shared/types'
import { PROFILE_PASSWORD_REF } from '@shared/types'
import { defaultProfile, VPN_LABELS } from '@shared/defaults'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { applyProfileCredentials, saveProfilePassword } from '@/lib/profileCreds'
import { WALLPAPER_IMAGES, WALLPAPER_PRESETS, wallpaperStyle } from '@/lib/wallpapers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ServiceIcon } from '@/components/ServiceIcon'
import { SecretField } from '@/components/SecretField'

type StepId =
  | 'welcome'
  | 'look'
  | 'profile'
  | 'contours'
  | 'vpn-bank'
  | 'vpn-ecom'
  | 'shared'
  | 'svc-bank'
  | 'svc-ecom'
  | 'finish'

const STEPS: { id: StepId; title: string; hint: string }[] = [
  { id: 'welcome', title: 'Приветствие', hint: 'Что такое Kontur' },
  { id: 'look', title: 'Внешний вид', hint: 'Тема и обои' },
  { id: 'profile', title: 'Профиль', hint: 'Логин и пароль' },
  { id: 'contours', title: 'Контуры', hint: 'Банк, Ecom, Общие' },
  { id: 'vpn-bank', title: 'Банк', hint: 'VPN и проверка сети' },
  { id: 'vpn-ecom', title: 'B2B Ecom', hint: 'VPN и проверка сети' },
  { id: 'shared', title: 'Общие', hint: 'Mattermost, Толк…' },
  { id: 'svc-bank', title: 'Сервисы Банка', hint: 'Jira, почта…' },
  { id: 'svc-ecom', title: 'Сервисы Ecom', hint: 'Jira, почта…' },
  { id: 'finish', title: 'Готово', hint: 'Запуск рабочего стола' }
]

const VPN_KINDS = Object.keys(VPN_LABELS) as VpnKind[]

/**
 * Мастер первого запуска — как установка ОС: шаги слева, содержимое справа,
 * в конце тот же приветственный splash, что при обычной загрузке.
 */
export function Onboarding({ onFinished }: { onFinished: () => void }): JSX.Element {
  const config = useStore((s) => s.config)
  const patchConfig = useStore((s) => s.patchConfig)
  const saveService = useStore((s) => s.saveService)
  const setTheme = useStore((s) => s.setTheme)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<UserProfile>(() => ({
    ...defaultProfile(),
    ...config?.profile
  }))
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')

  const current = STEPS[step]!
  const progress = ((step + 1) / STEPS.length) * 100
  const profileBlocked =
    current.id === 'profile' &&
    Boolean(password || password2) &&
    (password !== password2 || !password.trim())

  const goNext = (): void => {
    if (profileBlocked) return
    setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }
  const goBack = (): void => setStep((s) => Math.max(s - 1, 0))

  const finish = async (): Promise<void> => {
    setBusy(true)
    try {
      if (password && password === password2) {
        await saveProfilePassword(password)
      }
      await patchConfig({
        onboardingCompleted: true,
        profile
      })
      if (
        profile.username.trim() &&
        (password || (await window.kontur.secrets.has(PROFILE_PASSWORD_REF)))
      ) {
        await applyProfileCredentials({
          username: profile.username,
          password: password && password === password2 ? password : undefined,
          services: useStore.getState().config?.services ?? [],
          saveService
        })
      }
      onFinished()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#141518] text-[#f3f4f6]">
      {/* Тонкая полоса прогресса — как при установке ОС */}
      <div className="h-0.5 w-full bg-white/5">
        <div
          className="h-full bg-neutral-200 transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Левый rail со шагами */}
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-white/8 bg-[#101114] px-5 py-8">
          <div className="mb-8">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-neutral-300 uppercase">
              Установка
            </p>
            <h1 className="mt-1 font-sans text-[22px] font-semibold tracking-tight text-white">
              Kontur
            </h1>
          </div>
          <ol className="flex flex-1 flex-col gap-1 overflow-y-auto">
            {STEPS.map((s, i) => {
              const done = i < step
              const active = i === step
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => i <= step && setStep(i)}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                      active && 'bg-white/6',
                      !active && i <= step && 'hover:bg-white/4',
                      i > step && 'opacity-40'
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                        done && 'bg-neutral-200 text-neutral-900',
                        active && !done && 'bg-white/12 text-white ring-1 ring-white/25',
                        !done && !active && 'bg-white/8 text-white/50'
                      )}
                    >
                      {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'block truncate text-[13px] font-medium',
                          active ? 'text-white' : 'text-white/70'
                        )}
                      >
                        {s.title}
                      </span>
                      <span className="block truncate text-[11px] text-white/35">{s.hint}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </aside>

        {/* Контент шага */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0 opacity-[0.35]" style={wallpaperStyle(config?.wallpaper)} />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#141518]/92 via-[#141518]/88 to-[#141518]/75" />

          <div className="relative flex min-h-0 flex-1 flex-col px-10 py-9 lg:px-14">
            <div className="mb-6">
              <p className="text-[11px] font-semibold tracking-[0.12em] text-neutral-300 uppercase">
                Шаг {step + 1} из {STEPS.length}
              </p>
              <h2 className="mt-1 font-sans text-[28px] font-semibold tracking-tight text-white">
                {current.title}
              </h2>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {current.id === 'welcome' && <WelcomeStep />}
              {current.id === 'look' && (
                <LookStep
                  theme={config?.theme ?? 'system'}
                  wallpaper={config?.wallpaper}
                  onTheme={(t) => void setTheme(t)}
                  onWallpaper={(w) => void patchConfig({ wallpaper: w })}
                />
              )}
              {current.id === 'profile' && (
                <ProfileStep
                  profile={profile}
                  password={password}
                  password2={password2}
                  onProfile={setProfile}
                  onPassword={setPassword}
                  onPassword2={setPassword2}
                />
              )}
              {current.id === 'contours' && <ContoursStep />}
              {(current.id === 'vpn-bank' || current.id === 'vpn-ecom') && config && (
                <VpnStep
                  envId={current.id === 'vpn-bank' ? 'bank' : 'ecom'}
                  env={config.envs.find((e) => e.id === (current.id === 'vpn-bank' ? 'bank' : 'ecom'))}
                  onSave={(env) =>
                    void window.kontur.config.upsertEnv(env).then((c) => useStore.setState({ config: c }))
                  }
                />
              )}
              {current.id === 'shared' && config && (
                <ServicesStep
                  envId="shared"
                  services={config.services.filter((s) => s.envId === 'shared')}
                  defaultUsername={profile.username}
                  onSave={(s) => void saveService(s)}
                />
              )}
              {current.id === 'svc-bank' && config && (
                <ServicesStep
                  envId="bank"
                  services={config.services.filter((s) => s.envId === 'bank')}
                  defaultUsername={profile.username}
                  onSave={(s) => void saveService(s)}
                />
              )}
              {current.id === 'svc-ecom' && config && (
                <ServicesStep
                  envId="ecom"
                  services={config.services.filter((s) => s.envId === 'ecom')}
                  defaultUsername={profile.username}
                  onSave={(s) => void saveService(s)}
                />
              )}
              {current.id === 'finish' && <FinishStep profile={profile} />}
            </div>

            <div className="mt-6 flex items-center justify-between border-t border-white/8 pt-5">
              <Button
                type="button"
                variant="ghost"
                className="text-white/70 hover:bg-white/8 hover:text-white"
                disabled={step === 0 || busy}
                onClick={goBack}
              >
                <ChevronLeft className="size-4" />
                Назад
              </Button>
              <div className="flex items-center gap-2">
                {step < STEPS.length - 1 && step > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-white/45 hover:bg-white/8 hover:text-white/80"
                    onClick={goNext}
                  >
                    Пропустить
                  </Button>
                )}
                {step < STEPS.length - 1 ? (
                  <Button
                    type="button"
                    className="bg-neutral-100 text-neutral-900 hover:bg-white"
                    disabled={profileBlocked}
                    onClick={goNext}
                  >
                    Далее
                    <ChevronRight className="size-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="bg-neutral-100 text-neutral-900 hover:bg-white"
                    disabled={busy}
                    onClick={() => void finish()}
                  >
                    Запустить Kontur
                    <ChevronRight className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function WelcomeStep(): JSX.Element {
  return (
    <div className="max-w-xl space-y-5">
      <p className="text-[16px] leading-relaxed text-white/75">
        Сейчас настроим рабочее место под два изолированных контура — как при установке системы:
        внешний вид, туннели, общие приложения и сервисы внутри VPN.
      </p>
      <ul className="space-y-3 text-[14px] text-white/60">
        <li className="flex gap-3">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-300" />
          Каждый контур — своя сеть, куки и сессия браузера
        </li>
        <li className="flex gap-3">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-300" />
          Mattermost и Толк живут в «Общих» и не зависят от VPN
        </li>
        <li className="flex gap-3">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-300" />
          Всё можно донастроить позже в Настройках
        </li>
      </ul>
    </div>
  )
}

function LookStep({
  theme,
  wallpaper,
  onTheme,
  onWallpaper
}: {
  theme: ThemePref
  wallpaper: Wallpaper | undefined
  onTheme: (t: ThemePref) => void
  onWallpaper: (w: Wallpaper) => void
}): JSX.Element {
  const themes: { id: ThemePref; label: string }[] = [
    { id: 'system', label: 'Как в системе' },
    { id: 'dark', label: 'Тёмная' },
    { id: 'light', label: 'Светлая' }
  ]
  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <h3 className="mb-3 text-[13px] font-medium text-white/80">Тема интерфейса</h3>
        <div className="flex flex-wrap gap-2">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTheme(t.id)}
              className={cn(
                'rounded-lg border px-4 py-2.5 text-[13px] transition-colors',
                theme === t.id
                  ? 'border-white/35 bg-white/10 text-white'
                  : 'border-white/10 bg-white/4 text-white/65 hover:border-white/20'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-[13px] font-medium text-white/80">Обои рабочего стола</h3>
        <div className="flex flex-wrap gap-2">
          {WALLPAPER_IMAGES.map((img) => (
            <button
              key={img.key}
              type="button"
              title={img.label}
              onClick={() => onWallpaper({ kind: 'image', value: img.key })}
              className={cn(
                'size-14 rounded-lg border-2 bg-cover bg-center',
                wallpaper?.kind === 'image' && wallpaper.value === img.key
                  ? 'border-white/70'
                  : 'border-transparent'
              )}
              style={{ backgroundImage: `url(${img.url})` }}
            />
          ))}
          {WALLPAPER_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              title={p.label}
              onClick={() => onWallpaper({ kind: 'gradient', value: p.key })}
              className={cn(
                'size-14 rounded-lg border-2',
                wallpaper?.kind === 'gradient' && wallpaper.value === p.key
                  ? 'border-white/70'
                  : 'border-transparent'
              )}
              style={{ background: p.css }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function ProfileStep({
  profile,
  password,
  password2,
  onProfile,
  onPassword,
  onPassword2
}: {
  profile: UserProfile
  password: string
  password2: string
  onProfile: (p: UserProfile) => void
  onPassword: (v: string) => void
  onPassword2: (v: string) => void
}): JSX.Element {
  const mismatch = Boolean(password2) && password !== password2
  return (
    <div className="max-w-xl space-y-5">
      <p className="text-[14px] text-white/55">
        Логин и пароль пойдут в формы входа сервисов (auto-login) и на экран блокировки Kontur.
        Пароль хранится в системном keychain.
      </p>
      <Field label="Как к вам обращаться">
        <Input
          value={profile.displayName}
          className="border-white/10 bg-white/5 text-white"
          placeholder="Имя"
          onChange={(e) => onProfile({ ...profile, displayName: e.target.value })}
        />
      </Field>
      <Field label="Логин / email">
        <Input
          value={profile.username}
          className="border-white/10 bg-white/5 text-white"
          placeholder="name@company.com"
          autoComplete="username"
          onChange={(e) => onProfile({ ...profile, username: e.target.value })}
        />
      </Field>
      <Field label="Пароль">
        <Input
          type="password"
          value={password}
          className="border-white/10 bg-white/5 text-white"
          autoComplete="new-password"
          onChange={(e) => onPassword(e.target.value)}
        />
      </Field>
      <Field label="Пароль ещё раз">
        <Input
          type="password"
          value={password2}
          className="border-white/10 bg-white/5 text-white"
          autoComplete="new-password"
          onChange={(e) => onPassword2(e.target.value)}
        />
      </Field>
      {mismatch && <p className="text-[12px] text-red-300">Пароли не совпадают</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Заставка через, мин (0 — выкл)">
          <Input
            type="number"
            min={0}
            max={120}
            value={profile.screensaverMinutes}
            className="border-white/10 bg-white/5 text-white"
            onChange={(e) =>
              onProfile({ ...profile, screensaverMinutes: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </Field>
        <Field label="Блокировка через, мин (0 — выкл)">
          <Input
            type="number"
            min={0}
            max={240}
            value={profile.lockMinutes}
            className="border-white/10 bg-white/5 text-white"
            onChange={(e) =>
              onProfile({ ...profile, lockMinutes: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </Field>
      </div>
    </div>
  )
}

function ContoursStep(): JSX.Element {
  const cards = [
    {
      name: 'Банк',
      accent: '#F09A05',
      text: 'Корпоративный контур. Своя VPN-сессия, Jira, почта и остальное внутри туннеля.'
    },
    {
      name: 'B2B Ecom',
      accent: '#D02670',
      text: 'Второй контур — изолирован от Банка. Отдельные куки и свой health-check.'
    },
    {
      name: 'Общие',
      accent: '#64748b',
      text: 'Сервисы вне VPN: Mattermost, Толк, А-Чат. Доступны всегда.'
    }
  ]
  return (
    <div className="grid max-w-2xl gap-3">
      {cards.map((c) => (
        <div
          key={c.name}
          className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
          style={{ borderLeftWidth: 3, borderLeftColor: c.accent }}
        >
          <p className="text-[15px] font-semibold text-white">{c.name}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-white/55">{c.text}</p>
        </div>
      ))}
    </div>
  )
}

function VpnStep({
  envId,
  env,
  onSave
}: {
  envId: string
  env: EnvConfig | undefined
  onSave: (env: EnvConfig) => void
}): JSX.Element {
  if (!env) {
    return <p className="text-white/50">Контур «{envId}» не найден в конфиге.</p>
  }
  const [draft, setDraft] = useState(env)
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  useEffect(() => {
    setDraft(env)
  }, [env])
  useEffect(() => {
    void window.kontur.secrets.list().then(setSecrets)
  }, [envId])

  const commit = (next: EnvConfig): void => {
    setDraft(next)
    onSave(next)
  }

  return (
    <div className="max-w-xl space-y-5">
      <p className="text-[14px] text-white/55">
        Укажите, как поднимается туннель «{env.name}» и какой внутренний адрес считать признаком
        живой сети. Подробные CLI/AppleScript — в Настройках.
      </p>
      <Field label="Адрес проверки (health-check)">
        <Input
          value={draft.healthCheckUrl ?? ''}
          placeholder="https://внутр.сервис.контура/"
          className="border-white/10 bg-white/5 text-white placeholder:text-white/30"
          onChange={(e) => commit({ ...draft, healthCheckUrl: e.target.value || null })}
        />
      </Field>
      <Field label="Тип VPN">
        <Select
          value={draft.vpn.kind}
          onValueChange={(v) => commit({ ...draft, vpn: { ...draft.vpn, kind: v as VpnKind } })}
        >
          <SelectTrigger className="border-white/10 bg-white/5 text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VPN_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {VPN_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {draft.vpn.kind === 'checkpoint' && (
        <Field label="Имя сайта Check Point">
          <Input
            value={draft.vpn.site ?? ''}
            className="border-white/10 bg-white/5 text-white"
            onChange={(e) => commit({ ...draft, vpn: { ...draft.vpn, site: e.target.value || null } })}
          />
        </Field>
      )}
      {draft.vpn.kind === 'snx-rs' && (
        <>
          <Field label="Сервер snx-rs">
            <Input
              value={draft.vpn.snxServer ?? ''}
              placeholder="vpn.example.com"
              className="border-white/10 bg-white/5 text-white font-mono text-xs"
              onChange={(e) =>
                commit({ ...draft, vpn: { ...draft.vpn, snxServer: e.target.value || null } })
              }
            />
          </Field>
          <Field label="Login type">
            <Input
              value={draft.vpn.snxLoginType ?? ''}
              placeholder="vpn_AD_Password"
              className="border-white/10 bg-white/5 text-white font-mono text-xs"
              onChange={(e) =>
                commit({ ...draft, vpn: { ...draft.vpn, snxLoginType: e.target.value || null } })
              }
            />
          </Field>
        </>
      )}
      {(draft.vpn.kind === 'scutil' || draft.vpn.kind === 'openvpn') && (
        <Field label="Имя профиля">
          <Input
            value={draft.vpn.profile ?? ''}
            className="border-white/10 bg-white/5 text-white"
            onChange={(e) =>
              commit({ ...draft, vpn: { ...draft.vpn, profile: e.target.value || null } })
            }
          />
        </Field>
      )}
      {draft.vpn.kind !== 'none' && (
        <>
          <Field label="Логин VPN">
            <Input
              value={draft.vpn.username ?? ''}
              className="border-white/10 bg-white/5 text-white"
              onChange={(e) =>
                commit({ ...draft, vpn: { ...draft.vpn, username: e.target.value || null } })
              }
            />
          </Field>
          <Field label="Пароль VPN">
            <SecretField
              secretRef={`env.${envId}.vpn`}
              label={`${env.name} · VPN`}
              meta={secrets.find((x) => x.ref === `env.${envId}.vpn`)}
              onSaved={setSecrets}
            />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
            <span className="text-[13px] text-white/75">
              {draft.vpn.kind === 'checkpoint'
                ? 'Indeed / второй фактор (ждём подтверждение)'
                : 'Нужен OTP / второй фактор'}
            </span>
            <Switch
              checked={draft.vpn.requiresOtp}
              onCheckedChange={(v) => commit({ ...draft, vpn: { ...draft.vpn, requiresOtp: v } })}
            />
          </label>
        </>
      )}
    </div>
  )
}

function ServicesStep({
  envId,
  services,
  defaultUsername,
  onSave
}: {
  envId: string
  services: ServiceConfig[]
  defaultUsername: string
  onSave: (s: ServiceConfig) => void
}): JSX.Element {
  const sorted = useMemo(
    () =>
      [...services].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru')
      ),
    [services]
  )
  const isShared = envId === 'shared'

  return (
    <div className="max-w-2xl space-y-3">
      <p className="mb-4 text-[14px] text-white/55">
        {isShared
          ? 'Включите приложения вне VPN и укажите адреса. Логин из профиля подставится при завершении.'
          : 'Включите сервисы и URL. Логин/пароль профиля применятся к формам входа в конце мастера.'}
      </p>
      {sorted.map((s) => (
        <div
          key={s.id}
          className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
        >
          <div className="flex items-center gap-3">
            <ServiceIcon serviceId={s.id} kind={s.kind} size={18} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-white">{s.name}</p>
              <p className="truncate font-mono text-[11px] text-white/35">{s.kind}</p>
            </div>
            <Switch
              checked={s.enabled}
              onCheckedChange={(v) =>
                onSave({
                  ...s,
                  enabled: v,
                  auth: {
                    ...s.auth,
                    username: s.auth.username || defaultUsername || null
                  }
                })
              }
            />
          </div>
          {s.enabled && s.mode !== 'launcher' && (
            <Input
              className="mt-3 border-white/10 bg-white/5 font-mono text-xs text-white placeholder:text-white/30"
              placeholder="https://…"
              value={s.baseUrl}
              onChange={(e) => onSave({ ...s, baseUrl: e.target.value })}
            />
          )}
          {s.enabled && s.auth.kind !== 'none' && s.mode !== 'launcher' && (
            <Input
              className="mt-2 border-white/10 bg-white/5 text-xs text-white placeholder:text-white/30"
              placeholder="Логин для этого сервиса"
              value={s.auth.username ?? ''}
              onChange={(e) =>
                onSave({ ...s, auth: { ...s.auth, username: e.target.value || null } })
              }
            />
          )}
          {s.enabled && s.kind === 'achat' && (
            <Input
              className="mt-2 border-white/10 bg-white/5 font-mono text-xs text-white"
              placeholder="Путь к .app"
              value={s.options.appPath ?? ''}
              onChange={(e) =>
                onSave({ ...s, options: { ...s.options, appPath: e.target.value } })
              }
            />
          )}
          {s.enabled && s.kind === 'ktalk' && (
            <Input
              className="mt-2 border-white/10 bg-white/5 font-mono text-xs text-white"
              placeholder="Путь к Толк.app"
              value={s.options.appPath ?? ''}
              onChange={(e) =>
                onSave({ ...s, options: { ...s.options, appPath: e.target.value } })
              }
            />
          )}
        </div>
      ))}
    </div>
  )
}

function FinishStep({ profile }: { profile: UserProfile }): JSX.Element {
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-[16px] leading-relaxed text-white/75">
        Профиль{profile.displayName ? ` «${profile.displayName}»` : ''} сохранён. Логин и пароль
        раздадутся включённым сервисам для автозаполнения форм входа.
      </p>
      <p className="text-[13px] text-white/45">
        Дальше — приветственный экран, как при обычном старте, затем рабочий стол.
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-white/55">{label}</span>
      {children}
    </label>
  )
}
