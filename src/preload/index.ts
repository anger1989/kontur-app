import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '@shared/ipc'
import type {
  AppConfig,
  Bookmark,
  BrowserState,
  BrowserTabState,
  EnvConfig,
  EnvStatus,
  Item,
  MailDetail,
  MailMailbox,
  MailRule,
  MailRuleUpsert,
  MailSendPayload,
  CalendarCreatePayload,
  CalendarUpdatePayload,
  CalendarCancelPayload,
  CalendarMeetingDetails,
  CalendarPerson,
  CalendarScheduleQuery,
  CalendarScheduleResult,
  MeetingResponseKind,
  NavTarget,
  FsEntry,
  FsFavorite,
  NoteDoc,
  NoteRef,
  NoteSearchHit,
  SecretMeta,
  ServiceConfig,
  ThemePref,
  TodoCreatePayload,
  TodoUpdatePayload,
  VaultNode,
  VpnState
} from '@shared/types'
import type {
  AutomationRunResult,
  AutomationStepTypeInfo,
  AutomationUpsert,
  AutomationView
} from '@shared/automations'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  config: {
    get: () => invoke<AppConfig>(CH.configGet),
    save: (cfg: AppConfig) => invoke<AppConfig>(CH.configSave, cfg),
    patch: (patch: Partial<AppConfig>) => invoke<AppConfig>(CH.configPatch, patch),
    upsertService: (s: ServiceConfig) => invoke<AppConfig>(CH.configUpsertService, s),
    removeService: (id: string) => invoke<AppConfig>(CH.configRemoveService, id),
    upsertEnv: (e: EnvConfig) => invoke<AppConfig>(CH.configUpsertEnv, e),
    /** Конфиг изменили где-то ещё — перечитать. */
    onChange: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on(CH.configChanged, h)
      return (): void => {
        ipcRenderer.off(CH.configChanged, h)
      }
    },
    reorderServices: (envId: string, orderedIds: string[]) =>
      invoke<AppConfig>(CH.configReorderServices, envId, orderedIds)
  },
  secrets: {
    available: () => invoke<boolean>(CH.secretsAvailable),
    list: () => invoke<SecretMeta[]>(CH.secretsList),
    set: (ref: string, value: string, label?: string) => invoke<SecretMeta[]>(CH.secretsSet, ref, value, label),
    remove: (ref: string) => invoke<SecretMeta[]>(CH.secretsDelete, ref),
    /** Явное «показать» в настройках. По умолчанию значения в renderer не уходят. */
    reveal: (ref: string) => invoke<string | null>(CH.secretsReveal, ref),
    /** Сверка пароля (блокировка) — значение наружу не отдаём. */
    verify: (ref: string, value: string) => invoke<boolean>(CH.secretsVerify, ref, value),
    has: (ref: string) => invoke<boolean>(CH.secretsHas, ref),
    copy: (fromRef: string, toRef: string, label?: string) =>
      invoke<boolean>(CH.secretsCopy, fromRef, toRef, label)
  },
  env: {
    status: () => invoke<EnvStatus[]>(CH.envStatus),
    probe: (envId: string) => invoke<EnvStatus[]>(CH.envProbe, envId),
    clearSession: (envId: string) => invoke<void>(CH.envClearSession, envId),
    onChange: (cb: (s: EnvStatus) => void) => {
      const h = (_e: unknown, s: EnvStatus): void => cb(s)
      ipcRenderer.on(CH.envChanged, h)
      return (): void => {
        ipcRenderer.off(CH.envChanged, h)
      }
    },
    /** Запрос из трея: connect / connectBoth — в renderer (OTP + тосты). */
    onTrayAction: (
      cb: (action: { kind: 'connect'; envId: string } | { kind: 'connectBoth' }) => void
    ) => {
      const h = (
        _e: unknown,
        action: { kind: 'connect'; envId: string } | { kind: 'connectBoth' }
      ): void => cb(action)
      ipcRenderer.on(CH.envTrayAction, h)
      return (): void => {
        ipcRenderer.off(CH.envTrayAction, h)
      }
    }
  },
  vpn: {
    /** Одноразовый код передаётся прямо в вызов и нигде не сохраняется. */
    connect: (envId: string, otp?: string) => invoke<VpnState>(CH.vpnConnect, envId, otp),
    disconnect: (envId: string) => invoke<VpnState>(CH.vpnDisconnect, envId),
    /** Банк → второй контур; otps — коды только где нужен ручной OTP. */
    connectBoth: (otps?: Record<string, string | undefined>) =>
      invoke<{ envId: string; up: boolean }[]>(CH.vpnConnectBoth, otps),
    /** Перепроверка после подъёма: не вытеснил ли второй CP-сайт первый. */
    verifyAll: () => invoke<{ envId: string; up: boolean }[]>(CH.vpnVerifyAll),
    /** Что за клиент Check Point стоит на машине, где его CLI и какие сайты он знает. */
    discoverCheckpoint: () =>
      invoke<{
        apps: string[]
        executables: string[]
        cli: string | null
        sites: { site: string; username: string | null; authMethod: string | null; status: string | null }[]
      }>(CH.vpnDiscoverCheckpoint),
    snxAvailable: () =>
      invoke<{
        ok: boolean
        source: 'bundled' | 'system' | 'missing'
        path: string | null
        service: boolean
      }>(CH.vpnSnxAvailable),
    snxLoginTypes: (
      server: string,
      tls?: { allowInsecureTls?: boolean; caCertPath?: string | null }
    ) => invoke<string[]>(CH.vpnSnxLoginTypes, server, tls),
    snxOpenInstaller: () => invoke<void>(CH.vpnSnxOpenInstaller),
    /** Текущие серверы имён основного резолвера — чтобы определить их для контура. */
    captureDns: () => invoke<string[]>(CH.dnsCapture),
    applyDns: (envId: string) => invoke<void>(CH.dnsApply, envId),
    clearDns: (envId: string) => invoke<void>(CH.dnsClear, envId)
  },
  view: {
    show: (serviceId: string, url?: string) => invoke<boolean>(CH.viewShow, serviceId, url),
    /** Без id — спрятать все вебвью (попап / lock / React-страница сверху). */
    hide: (serviceId?: string) => invoke<void>(CH.viewHide, serviceId),
    /** Вернуть несколько вебвью после hide() (порядок = z снизу вверх). */
    restore: (serviceIds: string[]) => invoke<void>(CH.viewRestore, serviceIds),
    setBounds: (b: {
      serviceId: string
      x: number
      y: number
      width: number
      height: number
      borderRadius?: number
    }) => ipcRenderer.send(CH.viewBounds, b),
    reload: (serviceId: string) => invoke<void>(CH.viewReload, serviceId),
    back: (serviceId: string) => invoke<void>(CH.viewBack, serviceId),
    home: (serviceId: string) => invoke<void>(CH.viewHome, serviceId),
    /** Текущий URL открытой вкладки сервиса (или null). */
    url: (serviceId: string) => invoke<string | null>(CH.viewUrl, serviceId),
    /** Снимок вкладки без hide (data URL). */
    capture: (serviceId: string) => invoke<string | null>(CH.viewCapture, serviceId),
    /** Снять кадр и сразу спрятать view (атомарно для freeze-UI). */
    freeze: (serviceId: string) => invoke<string | null>(CH.viewFreeze, serviceId),
    devTools: (serviceId: string) => invoke<void>(CH.viewDevTools, serviceId),
    suppress: (on: boolean) => invoke<void>(CH.viewSuppress, on),
    /** Сейчас ли вебвью в did-start…did-stop loading. */
    isLoading: (serviceId: string) => invoke<boolean>(CH.viewLoading, serviceId),
    onLoading: (cb: (id: string, loading: boolean) => void) => {
      const h = (_e: unknown, p: { id: string; loading: boolean }): void => cb(p.id, p.loading)
      ipcRenderer.on(CH.viewLoadingChanged, h)
      return (): void => {
        ipcRenderer.off(CH.viewLoadingChanged, h)
      }
    }
  },
  /**
   * Встроенный браузер. Сами страницы живут в нативных WebContentsView (как и
   * сервисы), поэтому здесь только список вкладок и навигация; показ, геометрия
   * и freeze идут через общий `view.*` по id вкладки.
   */
  browser: {
    state: () => invoke<BrowserState>(CH.browserState),
    newTab: (opts?: { envId?: string; url?: string; activate?: boolean; afterId?: string }) =>
      invoke<BrowserTabState | null>(CH.browserNewTab, opts ?? {}),
    closeTab: (id: string) => invoke<void>(CH.browserCloseTab, id),
    activateTab: (id: string) => invoke<void>(CH.browserActivateTab, id),
    moveTab: (id: string, toIndex: number) => invoke<void>(CH.browserMoveTab, id, toIndex),
    /** Адресная строка: готовый URL, хост или поисковый запрос. */
    navigate: (id: string, input: string) => invoke<void>(CH.browserNavigate, id, input),
    back: (id: string) => invoke<void>(CH.browserBack, id),
    forward: (id: string) => invoke<void>(CH.browserForward, id),
    reload: (id: string) => invoke<void>(CH.browserReload, id),
    stop: (id: string) => invoke<void>(CH.browserStop, id),
    home: (id: string) => invoke<void>(CH.browserHome, id),
    devTools: (id: string) => invoke<void>(CH.browserDevTools, id),
    bookmark: (id: string) => invoke<Bookmark>(CH.browserBookmark, id),
    onChange: (cb: (state: BrowserState) => void) => {
      const h = (_e: unknown, state: BrowserState): void => cb(state)
      ipcRenderer.on(CH.browserChanged, h)
      return (): void => {
        ipcRenderer.off(CH.browserChanged, h)
      }
    }
  },
  items: {
    query: (q: Record<string, unknown>) => invoke<Item[]>(CH.itemsQuery, q),
    search: (q: string) => invoke<Item[]>(CH.itemsSearch, q),
    markRead: (ids: string | string[]) => invoke<number>(CH.itemsMarkRead, ids),
    syncNow: () => invoke<void>(CH.syncNow),
    /** Пошаговая проверка: туннель → сеть/TLS → HTTP → данные. */
    diagnose: (serviceId: string) =>
      invoke<{
        serviceId: string
        steps: { label: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string }[]
        verdict: string
      }>(CH.diagnose, serviceId),
    /** Взять сессионный токен из куки открытой вкладки (когда PAT закрыты). */
    grabSessionToken: (serviceId: string) => invoke<boolean>(CH.grabSessionToken, serviceId),
    onChange: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on(CH.itemsChanged, h)
      return (): void => {
        ipcRenderer.off(CH.itemsChanged, h)
      }
    }
  },
  mail: {
    get: (id: string) => invoke<MailDetail>(CH.mailGet, id),
    send: (payload: MailSendPayload) => invoke<void>(CH.mailSend, payload),
    markRead: (id: string) => invoke<void>(CH.mailMarkRead, id),
    markUnread: (id: string) => invoke<void>(CH.mailMarkUnread, id),
    setFlagged: (id: string, flagged: boolean) => invoke<void>(CH.mailSetFlagged, id, flagged),
    listFolders: (opts?: { serviceId?: string; envId?: string }) =>
      invoke<MailMailbox[]>(CH.mailListFolders, opts ?? {}),
    listFoldersForRules: (opts?: { serviceId?: string; envId?: string }) =>
      invoke<MailMailbox[]>(CH.mailListFoldersForRules, opts ?? {}),
    createFolder: (opts: { serviceId: string; name: string; parentId?: string | null }) =>
      invoke<MailMailbox>(CH.mailCreateFolder, opts),
    move: (opts: { itemIds: string[]; folderId: string }) => invoke<void>(CH.mailMove, opts),
    listRules: (opts?: { serviceId?: string; envId?: string }) =>
      invoke<MailRule[]>(CH.mailListRules, opts ?? {}),
    upsertRule: (opts: { serviceId?: string; envId?: string; rule: MailRuleUpsert }) =>
      invoke<MailRule>(CH.mailUpsertRule, opts),
    deleteRule: (opts: { serviceId?: string; envId?: string; ruleId: string }) =>
      invoke<void>(CH.mailDeleteRule, opts),
    setRuleEnabled: (opts: {
      serviceId?: string
      envId?: string
      ruleId: string
      enabled: boolean
    }) => invoke<MailRule>(CH.mailSetRuleEnabled, opts),
    rulesSupported: (serviceId: string) => invoke<boolean>(CH.mailRulesSupported, serviceId)
  },
  calendar: {
    respond: (id: string, response: MeetingResponseKind) =>
      invoke<Item>(CH.calendarRespond, id, response),
    create: (payload: CalendarCreatePayload) => invoke<Item>(CH.calendarCreate, payload),
    /** Изменить/перенести свою встречу — только переданные поля. */
    update: (payload: CalendarUpdatePayload) => invoke<Item>(CH.calendarUpdate, payload),
    /** Отменить свою встречу (участникам отмену рассылает сервер). */
    cancel: (payload: CalendarCancelPayload) => invoke<void>(CH.calendarCancel, payload),
    /** Участники, место и описание с сервера — для формы редактирования. */
    details: (id: string) => invoke<CalendarMeetingDetails>(CH.calendarDetails, id),
    suggestPeople: (serviceId: string, query: string) =>
      invoke<CalendarPerson[]>(CH.calendarSuggestPeople, serviceId, query),
    schedule: (query: CalendarScheduleQuery) =>
      invoke<CalendarScheduleResult>(CH.calendarSchedule, query)
  },
  tasks: {
    transition: (
      id: string,
      target: { category?: string; statusName?: string; statusIds?: string[] }
    ) => invoke<Item>(CH.tasksTransition, id, target),
    board: (serviceId?: string) =>
      invoke<{
        serviceId: string | null
        projectKey: string | null
        columns: {
          id: string
          title: string
          category: 'new' | 'indeterminate' | 'done'
          statusIds: string[]
          statusName: string
        }[]
      }>(CH.tasksBoard, serviceId)
  },
  todos: {
    list: () => invoke<Item[]>(CH.todosList),
    create: (payload: TodoCreatePayload) => invoke<Item>(CH.todosCreate, payload),
    update: (payload: TodoUpdatePayload) => invoke<Item>(CH.todosUpdate, payload),
    remove: (id: string) => invoke<boolean>(CH.todosRemove, id)
  },
  automations: {
    list: () => invoke<AutomationView[]>(CH.automationsList),
    get: (id: string) => invoke<AutomationView | null>(CH.automationsGet, id),
    upsert: (payload: AutomationUpsert) => invoke<AutomationView>(CH.automationsUpsert, payload),
    remove: (id: string) => invoke<boolean>(CH.automationsDelete, id),
    setEnabled: (id: string, enabled: boolean) =>
      invoke<AutomationView>(CH.automationsSetEnabled, id, enabled),
    runNow: (id: string) => invoke<AutomationRunResult>(CH.automationsRunNow, id),
    stepTypes: () => invoke<AutomationStepTypeInfo[]>(CH.automationsStepTypes),
    onChange: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on(CH.automationsChanged, h)
      return (): void => {
        ipcRenderer.off(CH.automationsChanged, h)
      }
    }
  },
  notes: {
    tree: () => invoke<VaultNode[]>(CH.notesTree),
    read: (path: string) => invoke<NoteDoc>(CH.notesRead, path),
    write: (path: string, content: string) => invoke<NoteRef>(CH.notesWrite, path, content),
    create: (path: string) => invoke<NoteRef>(CH.notesCreate, path),
    createFolder: (path: string) => invoke<void>(CH.notesCreateFolder, path),
    rename: (from: string, to: string) => invoke<NoteRef>(CH.notesRename, from, to),
    remove: (path: string) => invoke<void>(CH.notesDelete, path),
    search: (q: string) => invoke<NoteSearchHit[]>(CH.notesSearch, q),
    backlinks: (path: string) => invoke<NoteRef[]>(CH.notesBacklinks, path),
    resolveLink: (title: string) => invoke<string | null>(CH.notesResolveLink, title),
    pickVault: () => invoke<string | null>(CH.notesPickVault),
    revealVault: () => invoke<void>(CH.notesRevealVault)
  },
  fs: {
    home: () => invoke<string>(CH.fsHome),
    favorites: () => invoke<FsFavorite[]>(CH.fsFavorites),
    list: (dir: string) => invoke<FsEntry[]>(CH.fsList, dir),
    open: (path: string) => invoke<void>(CH.fsOpen, path),
    reveal: (path: string) => invoke<void>(CH.fsReveal, path),
    mkdir: (parent: string, name: string) => invoke<string>(CH.fsMkdir, parent, name),
    rename: (from: string, name: string) => invoke<string>(CH.fsRename, from, name),
    trash: (path: string) => invoke<void>(CH.fsTrash, path),
    pickFolder: () => invoke<string | null>(CH.fsPickFolder),
    /** Native drag в вебвью / другие приложения. */
    startDrag: (paths: string | string[]) => {
      ipcRenderer.send(CH.fsDragStart, paths)
    }
  },
  theme: {
    set: (pref: ThemePref) => invoke<'light' | 'dark'>(CH.themeSet, pref),
    onChange: (cb: (resolved: 'light' | 'dark') => void) => {
      const h = (_e: unknown, v: 'light' | 'dark'): void => cb(v)
      ipcRenderer.on(CH.themeChanged, h)
      return (): void => {
        ipcRenderer.off(CH.themeChanged, h)
      }
    }
  },
  logs: {
    read: () => invoke<string>(CH.logsRead),
    reveal: () => invoke<void>(CH.logsReveal)
  },
  nav: {
    /** Главный процесс просит открыть раздел — например по клику на уведомление. */
    onOpenPage: (cb: (page: string) => void) => {
      const h = (_e: unknown, page: string): void => cb(page)
      ipcRenderer.on(CH.openPage, h)
      return (): void => {
        ipcRenderer.off(CH.openPage, h)
      }
    },
    onOpenRoute: (cb: (target: NavTarget) => void) => {
      const h = (_e: unknown, target: NavTarget): void => cb(target)
      ipcRenderer.on(CH.openRoute, h)
      return (): void => {
        ipcRenderer.off(CH.openRoute, h)
      }
    },
    /** Кнопка «Подключиться» в уведомлении о встрече — main прислал ссылку, маршрутизация (Ктолк и т.п.) уже на renderer. */
    onJoinMeeting: (cb: (url: string) => void) => {
      const h = (_e: unknown, url: string): void => cb(url)
      ipcRenderer.on(CH.joinMeeting, h)
      return (): void => {
        ipcRenderer.off(CH.joinMeeting, h)
      }
    },
    /** ⌘` из вебвью: листать окна стола (dir +1 вперёд, −1 назад). */
    onCycleWindow: (cb: (dir: 1 | -1) => void) => {
      const h = (_e: unknown, dir: 1 | -1): void => cb(dir)
      ipcRenderer.on(CH.deskCycleWindow, h)
      return (): void => {
        ipcRenderer.off(CH.deskCycleWindow, h)
      }
    },
    /** Отпустили ⌘/Ctrl в вебвью — подтвердить выбор в switcher. */
    onConfirmCycleWindow: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on(CH.deskConfirmCycleWindow, h)
      return (): void => {
        ipcRenderer.off(CH.deskConfirmCycleWindow, h)
      }
    }
  },
  icons: {
    /** Иконка ресурса из его favicon (кэшируется на диск). */
    favicon: (serviceId: string, refresh?: boolean) =>
      invoke<string | null>(CH.faviconGet, serviceId, refresh)
  },
  contacts: {
    /**
     * Подсказки получателей «как в Outlook»: кому писали и с кем встречались,
     * затем общая адресная книга (GAL) всех ящиков.
     */
    suggest: (query: string, limit?: number) => invoke<CalendarPerson[]>(CH.contactsSuggest, query, limit)
  },
  bookmarks: {
    list: () => invoke<Bookmark[]>(CH.bookmarksList),
    add: (url: string, title?: string) => invoke<Bookmark>(CH.bookmarksAdd, { url, title }),
    /** Из открытой вкладки сервиса — адрес и заголовок берутся из её живого WebContentsView. */
    addFromService: (serviceId: string) => invoke<Bookmark>(CH.bookmarksAddFromService, serviceId),
    remove: (id: string) => invoke<void>(CH.bookmarksRemove, id),
    onChange: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on(CH.bookmarksChanged, h)
      return (): void => {
        ipcRenderer.off(CH.bookmarksChanged, h)
      }
    }
  },
  mcp: {
    info: () => invoke<{ running: boolean; port: number; token: string; url: string }>(CH.mcpInfo),
    agents: () =>
      invoke<{ id: string; name: string; detected: boolean; configured: boolean; configPath: string }[]>(
        CH.mcpAgents
      ),
    connect: (id: string) => invoke<{ ok: boolean; message: string }>(CH.mcpConnect, id)
  },
  app: {
    pickFile: (filters?: { name: string; extensions: string[] }[]) =>
      invoke<string | null>(CH.pickFile, filters),
    /** Диалог + чтение + base64 одним вызовом — отдаёт готовый data URL. */
    pickImage: () => invoke<string | null>(CH.pickImage),
    openExternal: (url: string) => invoke<void>(CH.openExternal, url),
    openApp: (appPath: string, url?: string) => invoke<void>(CH.openApp, appPath, url),
    notifyTest: () => invoke<{ ok: boolean; message: string }>(CH.notifyTest),
    getVersion: () => invoke<string>(CH.appGetVersion),
    checkUpdate: () =>
      invoke<{
        currentVersion: string
        latestVersion: string
        available: boolean
        releaseUrl: string
        downloadUrl: string
        body: string
      }>(CH.updateCheck),
    openUpdate: (url?: string) => invoke<void>(CH.updateOpen, url),
    onUpdateAvailable: (
      cb: (info: {
        currentVersion: string
        latestVersion: string
        available: boolean
        releaseUrl: string
        downloadUrl: string
        body: string
      }) => void
    ) => {
      const h = (
        _e: unknown,
        info: {
          currentVersion: string
          latestVersion: string
          available: boolean
          releaseUrl: string
          downloadUrl: string
          body: string
        }
      ): void => cb(info)
      ipcRenderer.on(CH.updateAvailable, h)
      return (): void => {
        ipcRenderer.off(CH.updateAvailable, h)
      }
    },
    /** Fullscreen — светофор скрыт, шапка сдвигает кнопки влево (не zoom/maximize). */
    onMaximizedChange: (cb: (fullScreen: boolean) => void) => {
      const h = (_e: unknown, fullScreen: boolean): void => cb(fullScreen)
      ipcRenderer.on(CH.windowMaximizedChanged, h)
      return (): void => {
        ipcRenderer.off(CH.windowMaximizedChanged, h)
      }
    }
  },
  terminal: {
    create: (opts?: {
      cols?: number
      rows?: number
      cwd?: string
      /** Именованная сессия — reuse + scrollback (ассистент). */
      key?: string
      profile?: 'shell' | 'agent'
    }) =>
      invoke<{ id: string; shell: string; scrollback: string; reused: boolean }>(
        CH.terminalCreate,
        opts
      ),
    write: (id: string, data: string) => invoke<void>(CH.terminalWrite, id, data),
    resize: (id: string, cols: number, rows: number) =>
      invoke<void>(CH.terminalResize, id, cols, rows),
    kill: (id: string) => invoke<void>(CH.terminalKill, id),
    onData: (cb: (id: string, data: string) => void) => {
      const h = (_e: unknown, id: string, data: string): void => cb(id, data)
      ipcRenderer.on(CH.terminalData, h)
      return (): void => {
        ipcRenderer.off(CH.terminalData, h)
      }
    },
    onExit: (cb: (id: string, info: { exitCode: number; signal: number | null }) => void) => {
      const h = (_e: unknown, id: string, info: { exitCode: number; signal: number | null }): void =>
        cb(id, info)
      ipcRenderer.on(CH.terminalExit, h)
      return (): void => {
        ipcRenderer.off(CH.terminalExit, h)
      }
    }
  },
  keyboard: {
    layout: () => invoke<{ id: string; short: string; name: string }>(CH.keyboardLayoutGet),
    onLayoutChange: (cb: (layout: { id: string; short: string; name: string }) => void) => {
      const h = (_e: unknown, layout: { id: string; short: string; name: string }): void => cb(layout)
      ipcRenderer.on(CH.keyboardLayoutChanged, h)
      return (): void => {
        ipcRenderer.off(CH.keyboardLayoutChanged, h)
      }
    }
  }
}

export type KonturApi = typeof api

contextBridge.exposeInMainWorld('kontur', api)
