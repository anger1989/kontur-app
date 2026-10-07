import type {
  AppConfig,
  BrowserConfig,
  EnvConfig,
  ServiceConfig,
  ServiceKind,
  UserProfile,
  VpnConfig,
  WidgetId,
  WidgetLayout
} from './types'
import { WIDGET_IDS } from './types'

export const CONFIG_VERSION = 1

/** Виртуальный «контур» для сервисов вне VPN (Mattermost, Толк, А-Чат…). */
export const SHARED_ENV_ID = 'shared'

export const NO_VPN = (): VpnConfig => ({
  kind: 'none',
  profile: null,
  ovpnPath: null,
  command: null,
  args: [],
  appPath: null,
  appleScript: null,
  site: null,
  cliPath: null,
  cliArgs: ['connect', '-s', '{site}', '-u', '{user}', '-p', '{password}'],
  snxServer: null,
  snxLoginType: null,
  username: null,
  requiresOtp: false,
  autoConnect: false,
  waitSeconds: 90
})

/** Склейка vpn из сейва с дефолтами — новые поля (snx-*) появляются без ручной миграции. */
export function normalizeVpn(saved?: Partial<VpnConfig> | null): VpnConfig {
  const base = NO_VPN()
  if (!saved) return base
  return {
    ...base,
    ...saved,
    args: Array.isArray(saved.args) ? saved.args : base.args,
    cliArgs: Array.isArray(saved.cliArgs) ? saved.cliArgs : base.cliArgs,
    snxServer: saved.snxServer ?? null,
    snxLoginType: saved.snxLoginType ?? null
  }
}

/** Сервисы, общие для обоих контуров — не привязаны к VPN-туннелю. */
export const SHARED_KINDS = new Set<ServiceKind>(['mattermost', 'achat', 'ktalk'])

/**
 * Два рабочих контура + общая группа. Акценты контуров далеки по тону.
 */
export const DEFAULT_ENVS: EnvConfig[] = [
  {
    id: 'bank',
    name: 'Контур A',
    short: 'A',
    accent: '#F09A05',
    partition: 'persist:bank',
    healthCheckUrl: null,
    proxy: null,
    caCertPath: null,
    allowInsecureTls: false,
    splitDns: true,
    dnsDomains: [],
    dnsServers: [],
    vpn: NO_VPN(),
    enabled: true
  },
  {
    id: 'ecom',
    name: 'Контур B',
    short: 'B',
    accent: '#D02670',
    partition: 'persist:ecom',
    healthCheckUrl: null,
    proxy: null,
    caCertPath: null,
    allowInsecureTls: false,
    splitDns: true,
    dnsDomains: [],
    dnsServers: [],
    vpn: NO_VPN(),
    enabled: true
  },
  {
    id: SHARED_ENV_ID,
    name: 'Общие',
    short: 'ОБЩ',
    accent: '#64748b',
    partition: 'persist:shared',
    healthCheckUrl: null,
    proxy: null,
    caCertPath: null,
    allowInsecureTls: false,
    splitDns: false,
    dnsDomains: [],
    dnsServers: [],
    vpn: NO_VPN(),
    enabled: true
  }
]

/**
 * Селекторы формы входа по умолчанию.
 *
 * Jira и Confluence (Server/DC) называют поля `os_username` / `os_password` —
 * под прежние `name="username"` / `#username` логин не подставлялся вообще,
 * а пароль подставлялся (он ловился по `type="password"`), и форма уходила
 * на сервер с пустым логином. Старые сохранённые значения подменяются на эти
 * при загрузке конфига (см. config/store).
 */
export const DEFAULT_LOGIN_SELECTORS = {
  userSelector:
    'input[name="os_username"], input[name="j_username"], input[name="username"], input[type="email"], #login-form-username, #os_username, #username',
  passSelector:
    'input[name="os_password"], input[name="j_password"], input[name="password"], input[type="password"], #login-form-password, #os_password, #password',
  submitSelector: '#login-form-submit, #loginButton, button[type="submit"], input[type="submit"]'
} as const

/** Прежние дефолты — чтобы отличить «не трогали» от «настроили руками». */
export const LEGACY_LOGIN_SELECTORS = {
  userSelector: 'input[name="username"], input[type="email"], #username',
  passSelector: 'input[name="password"], input[type="password"], #password',
  submitSelector: 'button[type="submit"], input[type="submit"]'
} as const

export const VPN_LABELS: Record<string, string> = {
  none: 'Поднимаю вручную',
  scutil: 'Профиль VPN из настроек macOS',
  command: 'Команда (wg-quick, openvpn, openconnect…)',
  app: 'Штатное приложение-клиент',
  checkpoint: 'Сайт в Check Point Endpoint Security VPN',
  openvpn: 'Профиль OpenVPN (Tunnelblick или напрямую)',
  'snx-rs': 'Check Point через snx-rs (можно параллельно с официальным CP)'
}

type ServiceTpl = {
  kind: ServiceKind
  name: string
  mode: ServiceConfig['mode']
  auth: ServiceConfig['auth']
  options?: Record<string, string>
}

const MAIL_TPL: ServiceTpl = {
  kind: 'mail',
  name: 'Почта и календарь',
  mode: 'both',
  auth: { kind: 'basic', username: null, secretRef: null },
  options: {
    email: '',
    displayName: '',
    protocol: 'eas',
    easUrl: '',
    easDeviceId: '',
    ewsUrl: '',
    jmapUrl: '',
    caldavUrl: '',
    imapHost: '',
    imapPort: '993',
    smtpHost: '',
    smtpPort: '465'
  }
}

/** Контур A: Bitbucket, без GitLab. */
const BANK_TEMPLATE: ServiceTpl[] = [
  { kind: 'jira', name: 'Jira', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  { kind: 'confluence', name: 'Confluence', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  { kind: 'bitbucket', name: 'Bitbucket', mode: 'both', auth: { kind: 'basic', username: null, secretRef: null } },
  MAIL_TPL
]

/** Контур B: GitLab, без Bitbucket. */
const ECOM_TEMPLATE: ServiceTpl[] = [
  { kind: 'jira', name: 'Jira', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  { kind: 'confluence', name: 'Confluence', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  { kind: 'gitlab', name: 'GitLab', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  MAIL_TPL
]

/** Общие сервисы (не зависят от поднятого контура). */
const SHARED_TEMPLATE: ServiceTpl[] = [
  { kind: 'mattermost', name: 'Mattermost', mode: 'both', auth: { kind: 'pat', username: null, secretRef: null } },
  {
    kind: 'achat',
    name: 'А-Чат',
    mode: 'embed',
    auth: { kind: 'none', username: null, secretRef: null },
    options: { appPath: '/Applications/А-Чат.app', ctsUrl: 'cts1.achat.best' }
  },
  {
    kind: 'ktalk',
    name: 'Толк',
    mode: 'embed',
    auth: { kind: 'none', username: null, secretRef: null },
    options: { appPath: '/Applications/Толк.app' }
  }
]

/** Дефолтные URL по контуру и kind — пусто: пользователь задаёт свои адреса. */
const DEFAULT_BASE_URL: Partial<Record<string, Partial<Record<ServiceKind, string>>>> = {
  bank: {},
  ecom: {},
  [SHARED_ENV_ID]: {
    achat: 'https://achat.best',
    ktalk: 'https://app.ktalk.ru'
  }
}

/** Сервисы, которые по умолчанию включены в онбординге. */
const DEFAULT_ENABLED = new Set<ServiceKind>(['jira', 'confluence', 'gitlab', 'bitbucket', 'mattermost'])

export function defaultBaseUrl(envId: string, kind: ServiceKind): string {
  return DEFAULT_BASE_URL[envId]?.[kind] ?? ''
}

function materialize(tpl: ServiceTpl, envId: string): ServiceConfig {
  const options = { ...(tpl.options ?? {}) }
  return {
    id: `${envId}.${tpl.kind}`,
    envId,
    kind: tpl.kind,
    name: tpl.name,
    baseUrl: defaultBaseUrl(envId, tpl.kind),
    mode: tpl.mode,
    auth: { ...tpl.auth },
    options,
    autoLogin: { enabled: false, ...DEFAULT_LOGIN_SELECTORS },
    enabled: DEFAULT_ENABLED.has(tpl.kind)
  }
}

export function defaultServicesFor(envId: string): ServiceConfig[] {
  if (envId === SHARED_ENV_ID) return SHARED_TEMPLATE.map((t) => materialize(t, envId))
  if (envId === 'bank') return BANK_TEMPLATE.map((t) => materialize(t, envId))
  if (envId === 'ecom') return ECOM_TEMPLATE.map((t) => materialize(t, envId))
  // Неизвестный контур — универсальный набор без VCS-специфики.
  return [BANK_TEMPLATE[0]!, BANK_TEMPLATE[1]!, MAIL_TPL].map((t) => materialize(t, envId))
}

/** Kind, который не должен жить в этом контуре (GitLab ↔ Bitbucket). */
export function isForeignVcs(envId: string, kind: ServiceKind): boolean {
  if (envId === 'bank' && kind === 'gitlab') return true
  if (envId === 'ecom' && kind === 'bitbucket') return true
  return false
}

export function defaultProfile(): UserProfile {
  return {
    displayName: '',
    username: '',
    screensaverMinutes: 5,
    lockMinutes: 10
  }
}

/** Все виджеты видимы и стоят в автоматической стопке справа. */
export function defaultWidgets(): Record<WidgetId, WidgetLayout> {
  return Object.fromEntries(
    WIDGET_IDS.map((id) => [id, { visible: true, x: null, y: null }])
  ) as Record<WidgetId, WidgetLayout>
}

/**
 * Браузер по умолчанию: вкладки в общем контуре (он не требует туннеля),
 * поиск и стартовая страница — Яндекс, как самый предсказуемый вариант для
 * рабочей машины. Всё три значения правятся в Настройках → Общее.
 */
export function defaultBrowser(): BrowserConfig {
  return {
    homeUrl: 'https://ya.ru',
    searchUrl: 'https://ya.ru/search/?text=%s',
    defaultEnvId: SHARED_ENV_ID
  }
}

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    theme: 'system',
    wallpaper: { kind: 'image', value: '1' },
    vaultPath: null,
    unifyMail: true,
    unifyCalendar: true,
    notifications: true,
    linkOpen: 'app',
    widgets: defaultWidgets(),
    browser: defaultBrowser(),
    onboardingCompleted: false,
    profile: defaultProfile(),
    removedServiceIds: [],
    envs: DEFAULT_ENVS.map((e) => ({ ...e })),
    services: DEFAULT_ENVS.flatMap((e) => defaultServicesFor(e.id))
  }
}

/** Человекочитаемые подписи для UI настроек. */
export const SERVICE_LABELS: Record<ServiceKind, string> = {
  jira: 'Jira',
  confluence: 'Confluence',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  mattermost: 'Mattermost',
  achat: 'А-чат',
  ktalk: 'Толк',
  mail: 'Почта и календарь',
  calendar: 'Календарь',
  custom: 'Другой сервис'
}

export const AUTH_LABELS: Record<string, string> = {
  none: 'Без авторизации',
  pat: 'Персональный токен',
  basic: 'Логин и пароль',
  bearer: 'Bearer-токен',
  cookie: 'Сессия в вебвью'
}
