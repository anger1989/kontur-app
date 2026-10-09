/**
 * Общая модель данных. Импортируется и main-процессом, и renderer'ом,
 * поэтому здесь не должно быть ни node-, ни dom-зависимостей.
 */

/** Изолированный рабочий контур: своя сеть, своя авторизация, свои сервисы. */
export type EnvId = string

/**
 * Чем поднимается туннель контура.
 *
 * `scutil`  — профиль VPN из системных настроек macOS (IKEv2/L2TP/IPsec).
 *             Пароль хранит сама система, root не нужен, полностью без участия человека.
 * `command` — свой клиент с CLI: wg-quick, openvpn, openconnect и прочие.
 * `app`     — штатное приложение-клиент. Мы его запускаем и, если задан
 *             AppleScript, нажимаем в нём «Connect». Multi-factor пользователь
 *             подтверждает сам: обходить его мы не пытаемся и не должны.
 * `checkpoint` — сайт в Check Point Endpoint Security VPN. Оба контура живут
 *             в одном клиенте как разные site, поэтому подключение идёт по
 *             имени сайта: через CLI клиента, если он есть, иначе AppleScript.
 * `openvpn` — профиль OpenVPN. Через Tunnelblick по имени конфигурации (без
 *             пароля каждый раз) либо напрямую из .ovpn с разовым запросом прав.
 * `none`    — контур поднимается вручную, приложение только наблюдает.
 */
export type VpnKind =
  | 'none'
  | 'scutil'
  | 'command'
  | 'app'
  | 'checkpoint'
  | 'openvpn'
  /** Второй Check Point-gateway через встроенный/системный snx-rs (параллельно с официальным CP). */
  | 'snx-rs'

export interface VpnConfig {
  kind: VpnKind
  /** scutil: имя сервиса в системных настройках сети. openvpn: имя конфигурации Tunnelblick. */
  profile: string | null
  /** openvpn: путь к .ovpn, если подключаемся напрямую, без Tunnelblick. */
  ovpnPath: string | null
  /** command: исполняемый файл и аргументы. Запускается без shell. */
  command: string | null
  args: string[]
  /** app: путь к .app штатного клиента. */
  appPath: string | null
  /** app и checkpoint: AppleScript. Подстановка {site} — имя сайта. */
  appleScript: string | null
  /** checkpoint: имя сайта ровно так, как он назван в клиенте. */
  site: string | null
  /** checkpoint: путь к CLI клиента, если он найден. Пусто — работаем через AppleScript. */
  cliPath: string | null
  /**
   * checkpoint: шаблон аргументов CLI. Подстановки {site}, {user}, {password}.
   * Пара «флаг + значение» выбрасывается целиком, если значения нет, —
   * тогда клиент спросит недостающее сам.
   */
  cliArgs: string[]
  /** snx-rs: адрес VPN-сервера (host или host:port). */
  snxServer: string | null
  /** snx-rs: login-type с gateway (vpn_xxx), из `snx-rs -m info`. */
  snxLoginType: string | null
  /** Логин для подключения. Пароль лежит в keychain под ключом env.<id>.vpn. */
  username: string | null
  /**
   * Контур требует одноразовый код (Indeed, OTP, токен).
   *
   * Код не хранится и не генерируется — его вводит человек перед каждым
   * подключением. Это и есть второй фактор: если его автоматизировать,
   * он перестанет быть фактором. Мы избавляем только от ввода пароля.
   *
   * Для Indeed push: диалог кода не показываем, ждём health после connect.
   */
  requiresOtp: boolean
  /** Поднимать этот контур при старте приложения. */
  autoConnect: boolean
  /** Сколько секунд ждать появления сети: при MFA нужно время на подтверждение. */
  waitSeconds: number
}

/** Что приложение знает про туннель: 'unmanaged' — поднимается вручную. */
export type VpnState = 'connected' | 'connecting' | 'disconnected' | 'unmanaged'

export interface EnvConfig {
  id: EnvId
  /** Отображаемое имя: «Банк», «B2B Ecom». */
  name: string
  /** Короткая метка для бейджей и табов: «БНК». */
  short: string
  /** Акцентный цвет контура. Главное средство не перепутать среды. */
  accent: string
  /** Electron-партиция: у каждого контура своя банка кук и свой localStorage. */
  partition: string
  /** Внутренний URL, по которому проверяется, поднят ли туннель. */
  healthCheckUrl: string | null
  /** SOCKS5/HTTP прокси, если контур когда-нибудь уедет за отдельный туннель. */
  proxy: string | null
  /** Путь к корпоративному CA-бандлу: без него Node не доверяет TLS-инспекции. */
  caCertPath: string | null
  /**
   * Доверять любым сертификатам этого контура без проверки.
   *
   * Осознанный выбор для внутренней среды, где сертификат самоподписанный и
   * взять корпоративный CA негде. Отключает проверку TLS только для сессий и
   * запросов этого контура, не глобально.
   */
  allowInsecureTls: boolean
  /**
   * Split-DNS: домены этого контура и его серверы имён. Когда подняты оба
   * туннеля, эти домены резолвятся своим сервером через /etc/resolver, не
   * завися от того, чей резолвер сейчас основной.
   */
  /**
   * Включён ли раздельный DNS. Домены и серверы определяются сами —
   * поля ниже нужны лишь для ручного переопределения.
   */
  splitDns: boolean
  dnsDomains: string[]
  dnsServers: string[]
  vpn: VpnConfig
  enabled: boolean
}

export type ServiceKind =
  | 'jira'
  | 'confluence'
  | 'gitlab'
  | 'bitbucket'
  | 'mattermost'
  | 'achat'
  | 'ktalk'
  | 'mail'
  | 'calendar'
  | 'custom'

/**
 * Как мы общаемся с сервисом.
 *
 * `launcher` — отдельное нативное приложение (опционально для А-Чата / Толка и т.п.):
 * встроить чужой .app как WebContentsView нельзя, но открывать одним кликом — можно.
 * У А-Чата и Толка по умолчанию веб (`embed`).
 */
export type ServiceMode = 'api' | 'embed' | 'both' | 'launcher'

export type AuthKind = 'none' | 'pat' | 'basic' | 'bearer' | 'cookie'

export interface AuthConfig {
  kind: AuthKind
  /** Логин хранится открыто — это не секрет. */
  username: string | null
  /** Ключ в хранилище секретов. Значение никогда не покидает main-процесс без явного запроса. */
  secretRef: string | null
}

export interface ServiceConfig {
  id: string
  envId: EnvId
  kind: ServiceKind
  name: string
  baseUrl: string
  mode: ServiceMode
  auth: AuthConfig
  /** Несекретные параметры: почтовый хост, порт IMAP, id проекта по умолчанию и т.п. */
  options: Record<string, string>
  /**
   * Автозаполнение формы входа во встроенной вкладке.
   *
   * Работает, когда форма входа стабильна: при загрузке страницы приложение
   * подставляет логин и пароль в поля по CSS-селекторам. Второй фактор и SSO
   * это не отменяет — только убирает ручной ввод логина и пароля.
   */
  autoLogin: {
    enabled: boolean
    userSelector: string
    passSelector: string
    /** Нажимать ли кнопку отправки после подстановки. */
    submitSelector: string
  }
  enabled: boolean
  /** Порядок в сайдбаре контура (меньше — выше). */
  order?: number
}

/**
 * Вкладка встроенного браузера.
 *
 * Живёт в памяти main рядом со своим `WebContentsView`; на диск не пишется —
 * как вкладки обычного браузера, она существует до перезапуска. Контур задаёт
 * партицию и туннель: вкладка, открытая в банковском контуре, ходит в сеть
 * его сессией и видит его куки.
 */
export interface BrowserTabState {
  id: string
  envId: EnvId
  /** Адрес, который показывает адресная строка. */
  url: string
  title: string
  /** data URL иконки сайта, забранной сессией самой вкладки. */
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Полное состояние браузера для рендерера: вкладки по порядку + активная. */
export interface BrowserState {
  tabs: BrowserTabState[]
  activeId: string | null
}

/** Настройки встроенного браузера. */
export interface BrowserConfig {
  /** Адрес новой вкладки и кнопки «домой». */
  homeUrl: string
  /** Шаблон поиска; `%s` — запрос. */
  searchUrl: string
  /** Контур, в котором открываются вкладки по умолчанию. */
  defaultEnvId: EnvId
}

export type ThemePref = 'system' | 'light' | 'dark'

/**
 * Обои рабочего стола: заливка, встроенный градиент, картинка или живой фон.
 * Для image: ключ встроенного пресета (`1`…`9`) или data URL своей картинки.
 * Для animated: ключ живого фона (`aurora`), сам фон рисует компонент.
 */
export interface Wallpaper {
  kind: 'color' | 'gradient' | 'image' | 'animated'
  value: string
}

/** Профиль пользователя: логин для сервисов и политика простоя. */
export interface UserProfile {
  displayName: string
  /** Логин/email — подставляется в формы входа сервисов. */
  username: string
  /** Минуты бездействия до заставки (wavy). 0 — выкл. */
  screensaverMinutes: number
  /** Минуты бездействия до блокировки (экран логина). 0 — выкл. */
  lockMinutes: number
}

/** Ключ пароля профиля в secrets (экран блокировки + дефолт для сервисов). */
export const PROFILE_PASSWORD_REF = 'profile.password'

/**
 * «В приложении» — ссылку забирает вкладка Kontur того сервиса, которому
 * принадлежит адрес (сессия контура уже есть, второй логин не нужен).
 * «В системе» — всегда наружу, в браузер по умолчанию.
 */
export type LinkOpenMode = 'app' | 'system'

/** Виджеты рабочего стола. Порядок задаёт стопку по умолчанию. */
export const WIDGET_IDS = [
  'day',
  'assistant',
  'insights',
  'meetings',
  'todos',
  'automations',
  'attention'
] as const
export type WidgetId = (typeof WIDGET_IDS)[number]

export const WIDGET_TITLES: Record<WidgetId, string> = {
  day: 'Мой день',
  assistant: 'Ассистент',
  insights: 'Метрики',
  meetings: 'Встречи сегодня',
  todos: 'Дела',
  automations: 'Автоматизации',
  attention: 'Требует внимания'
}

/**
 * Где лежит виджет и показывать ли его.
 *
 * `x`/`y` = null — виджет ещё не двигали, он стоит в автоматической стопке
 * справа. Как только его перетащили, координаты фиксируются, и дальше он
 * живёт сам по себе, как виджет в macOS.
 */
export interface WidgetLayout {
  visible: boolean
  x: number | null
  y: number | null
}

export interface AppConfig {
  version: number
  theme: ThemePref
  wallpaper: Wallpaper
  /** Путь к папке с заметками. По умолчанию ~/Documents/Kontur Vault. */
  vaultPath: string | null
  /** Показывать почту обоих контуров одним ящиком. */
  unifyMail: boolean
  /** Показывать календари обоих контуров одной сеткой. */
  unifyCalendar: boolean
  /** Показывать системные уведомления о новом в подключённых сервисах. */
  notifications: boolean
  /** Куда уводить веб-ссылки из писем, заметок, встреч и закладок. */
  linkOpen: LinkOpenMode
  /** Видимость и положение виджетов рабочего стола. */
  widgets: Record<WidgetId, WidgetLayout>
  /** Встроенный браузер: стартовая страница, поиск, контур по умолчанию. */
  browser: BrowserConfig
  /**
   * Мастер первого запуска пройден. У существующих установок при мерже
   * считается true, если поля не было.
   */
  onboardingCompleted: boolean
  profile: UserProfile
  /** Дефолтные сервисы, удалённые пользователем из контура, — не возвращать их. */
  removedServiceIds: string[]
  envs: EnvConfig[]
  services: ServiceConfig[]
}

/** Куда вести по клику на уведомление или элемент ленты. */
export type NavTarget =
  | { kind: 'page'; page: string; itemId?: string }
  | { kind: 'service'; serviceId: string; url?: string }

/** Единый элемент работы, в который нормализуются задачи, ревью, письма и сообщения. */
export type ItemKind = 'task' | 'review' | 'message' | 'mail' | 'page' | 'event' | 'todo'

export interface Item {
  /** `{envId}:{serviceId}:{nativeId}` */
  id: string
  envId: EnvId
  serviceId: string
  kind: ItemKind
  title: string
  body: string
  author: string | null
  state: string | null
  url: string
  updatedAt: number
  unread: boolean
  mentioned: boolean
  /** Локальный флаг письма (звезда). Синк сервера не перетирает. */
  flagged?: boolean
  /** Для событий календаря: начало и конец, мс. Для остального null. */
  startsAt: number | null
  endsAt: number | null
  /** Только для kind: 'mail' — 'inbox' | 'sent' | 'drafts' | 'trash'. Для остального не задаётся. */
  folder?: string | null
}

/** Локальный планировщик (не Jira). Body хранит cat/remind/cal. */
export interface TodoCreatePayload {
  title: string
  /** Срок (мс). null — без даты. */
  dueAt: number | null
  /** Когда напомнить (мс). null — без напоминания. */
  remindAt: number | null
  /** Показывать в календаре (если есть dueAt). */
  showInCalendar?: boolean
  note?: string
}

export interface TodoUpdatePayload {
  id: string
  title?: string
  dueAt?: number | null
  remindAt?: number | null
  showInCalendar?: boolean
  note?: string
  /** true → cat:done, false → cat:open */
  done?: boolean
}

/** Канонические папки почты, которые приложение умеет синхронизировать и показывать. */
export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'trash'

/** Папка почтового ящика (live с сервера). role — канонический alias, если есть. */
export interface MailMailbox {
  id: string
  name: string
  parentId: string | null
  role?: MailFolder | null
  total?: number
  unread?: number
}

/** Условие inbox-правила (упрощённая модель). */
export interface MailRuleCondition {
  fromContains?: string
  toContains?: string
  subjectContains?: string
}

/** Действие inbox-правила. */
export interface MailRuleAction {
  moveToFolder?: string
  markRead?: boolean
  markImportant?: boolean
}

/** Серверное inbox-правило (EWS). */
export interface MailRule {
  id: string
  name: string
  enabled: boolean
  conditions: MailRuleCondition
  actions: MailRuleAction
}

/** Создать / обновить правило. Без id — создать. */
export interface MailRuleUpsert {
  id?: string
  name: string
  enabled?: boolean
  conditions: MailRuleCondition
  actions: MailRuleAction
}

/** Полное письмо для чтения в клиенте. */
export interface MailDetail {
  id: string
  serviceId: string
  subject: string
  from: string
  to: string
  cc: string
  date: number
  bodyText: string
  bodyHtml: string | null
  unread: boolean
}

/** Исходящее письмо (новое или ответ). */
export interface MailSendPayload {
  serviceId: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  /** Id исходного письма при ответе — чтобы подставить In-Reply-To, если протокол умеет. */
  replyToId?: string
}

export type MeetingResponseKind = 'accept' | 'tentative' | 'decline'

/** Создание встречи в календаре. */
export interface CalendarCreatePayload {
  serviceId: string
  subject: string
  startsAt: number
  endsAt: number
  location?: string
  body?: string
  attendees?: string
  allDay?: boolean
}

/** Человек из GAL / локального кэша для автокомплита участников. */
export interface CalendarPerson {
  email: string
  name: string
  source: 'gal' | 'local'
}

/** 0 free · 1 tentative · 2 busy · 3 oof · 4 unknown (EAS MergedFreeBusy). */
export type FreeBusySlot = 0 | 1 | 2 | 3 | 4

export interface CalendarScheduleQuery {
  serviceId: string
  startsAt: number
  endsAt: number
  emails: string[]
  /** Встреча, которую редактируем, — не считать пересечением с самой собой. */
  excludeItemId?: string
}

/**
 * Изменение своей встречи. Передаются только меняемые поля: в EAS 16.x
 * отсутствующее в Change поле на сервере остаётся как было.
 * У повторяющейся встречи меняется только это вхождение (itemId несёт его дату).
 */
export interface CalendarUpdatePayload {
  itemId: string
  subject?: string
  startsAt?: number
  endsAt?: number
  location?: string
  body?: string
  /** Полный новый список участников (email через запятую); пустая строка — без участников. */
  attendees?: string
}

/** Отмена своей встречи: одно вхождение повторяющейся или вся серия. */
export interface CalendarCancelPayload {
  itemId: string
  scope?: 'occurrence' | 'series'
}

/** Детали встречи с сервера — для формы редактирования. */
export interface CalendarMeetingDetails {
  location: string
  body: string
  attendees: CalendarPerson[]
  /** Повторяющаяся встреча, а itemId — одно её вхождение. */
  recurring: boolean
}

export interface CalendarScheduleRow {
  email: string
  name: string
  isSelf?: boolean
  slots: FreeBusySlot[]
  events?: { title: string; startsAt: number; endsAt: number }[]
}

export interface CalendarScheduleResult {
  dayStart: number
  slotMinutes: number
  proposedStart: number
  proposedEnd: number
  rows: CalendarScheduleRow[]
  /** Мои встречи, пересекающиеся с черновиком. */
  conflicts: { title: string; startsAt: number; endsAt: number }[]
}

export type TunnelState = 'up' | 'down' | 'checking' | 'unknown'

export interface EnvStatus {
  envId: EnvId
  tunnel: TunnelState
  vpn: VpnState
  /** Когда контур последний раз успешно синхронизировался. */
  lastSyncAt: number | null
  lastError: string | null
  /** Сколько действий ждёт подъёма этого контура. */
  pendingOutbox: number
}

/** Отложенное действие на запись: уходит, когда контур снова доступен. */
export interface OutboxEntry {
  id: string
  envId: EnvId
  serviceId: string
  /** Идемпотентный ключ: повтор при флапе туннеля не задвоит комментарий. */
  idempotencyKey: string
  action: string
  payload: unknown
  createdAt: number
  attempts: number
  lastError: string | null
}

/* ── Заметки ─────────────────────────────────────────────────────────── */

export interface NoteRef {
  /** Путь относительно корня хранилища, с расширением: `Банк/Онбординг.md`. */
  path: string
  title: string
  updatedAt: number
  size: number
}

export interface NoteDoc extends NoteRef {
  content: string
  /** Исходящие вики-ссылки `[[…]]`. */
  links: string[]
}

export interface NoteSearchHit {
  path: string
  title: string
  /** Фрагмент вокруг совпадения. */
  excerpt: string
}

/** Узел дерева хранилища: папка или заметка. */
export interface VaultNode {
  name: string
  path: string
  kind: 'folder' | 'note'
  children?: VaultNode[]
  updatedAt?: number
}

/* ── Файловый менеджер ──────────────────────────────────────────────── */

export interface FsEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  ext: string
}

export interface FsFavorite {
  id: string
  label: string
  path: string
}

/* ── Закладки ────────────────────────────────────────────────────────── */

/**
 * Закладка в едином каталоге.
 *
 * Группа каталога не хранится отдельно — она всегда `host`, так каталог
 * формируется и сортируется сам, без ручного заведения папок.
 */
export interface Bookmark {
  id: string
  url: string
  title: string
  /** data: URL иконки, либо null, пока не нашлась (досылается фоном после добавления). */
  favicon: string | null
  /** Хост адреса — по нему группируется каталог. */
  host: string
  /** Сервис, из окна которого добавили (если есть) — иконка берётся из его кэша. */
  serviceId: string | null
  createdAt: number
  updatedAt: number
}

/* ── Секреты ─────────────────────────────────────────────────────────── */

/** Метаданные секрета без самого значения — это и уходит в renderer по умолчанию. */
export interface SecretMeta {
  ref: string
  label: string
  hasValue: boolean
  updatedAt: number | null
}
