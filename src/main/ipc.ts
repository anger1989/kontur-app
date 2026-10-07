import { ipcMain, dialog, shell, nativeTheme, nativeImage, BrowserWindow, app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { CH } from '@shared/ipc'
import type { AppConfig, EnvConfig, MailSendPayload, MailRuleUpsert, CalendarCreatePayload, CalendarUpdatePayload, CalendarCancelPayload, CalendarScheduleQuery, MeetingResponseKind, ServiceConfig, ThemePref, TodoCreatePayload, TodoUpdatePayload } from '@shared/types'
import {
  getConfig,
  saveConfig,
  patchConfig,
  upsertService,
  removeService,
  upsertEnv,
  reorderServices
} from './config/store'
import * as secrets from './config/secrets'
import * as notes from './notes/vault'
import * as files from './files/browser'
import { queryItems, searchItems, markItemsRead, type ItemQuery } from './db'
import { bindItemsChanged, emitItemsChanged } from './notify/itemsChanged'
import {
  getMail,
  sendMail,
  markMailRead,
  listMailFolders,
  listMailFoldersForRules,
  createMailFolder,
  moveMail,
  listMailRules,
  upsertMailRule,
  deleteMailRule,
  setMailRuleEnabled,
  mailRulesSupported
} from './mail'
import { cancelMeeting, createMeeting, getMeetingDetails, respondToMeeting, updateMeeting } from './calendar'
import { getSchedule, suggestPeople } from './calendar/people'
import { rememberRecipients, suggestContacts } from './contacts'
import { getTaskBoard, transitionTask } from './tasks'
import { createTodo, listTodos, removeTodo, updateTodo } from './todos'
import {
  automationsDelete,
  automationsGet,
  automationsRunNow,
  automationsSetEnabled,
  automationsUpsert,
  bindAutomationsChanged,
  listAutomationsView,
  listStepTypes
} from './automations'
import type { AutomationUpsert } from '@shared/automations'
import { health } from './net/health'
import * as vpn from './net/vpn'
import { captureDefaultDns, applySplitDns, clearSplitDns } from './net/dns'
import { scheduler } from './sync/scheduler'
import { diagnoseService } from './net/diagnose'
import { tailLog, logFilePath, logError } from './log'
import { getFavicon } from './services/favicon'
import { addBookmark, deleteBookmark, listAllBookmarks } from './bookmarks'
import { bindBookmarksChanged, emitBookmarksChanged } from './notify/bookmarksChanged'
import { createPtySession, killPty, resizePty, writePty } from './terminal/pty'
import { getKeyboardLayout } from './keyboardLayout'
import { mcpInfo } from './ai/mcpServer'
import { agentStates, connectAgent, type AgentId } from './ai/agents'
import { grabSessionToken } from './connectors/sessionToken'
import { notifyTest, rebuildTrayMenu } from './tray'
import { checkForUpdate, openUpdateDownload } from './update/check'
import type { ServiceViewManager } from './views/serviceViews'

export function registerIpc(getWin: () => BrowserWindow | null, views: () => ServiceViewManager | null): void {
  bindItemsChanged(getWin)
  bindBookmarksChanged(getWin)
  bindAutomationsChanged(getWin)
  /** Конфиг изменился — пусть интерфейс перечитает его из единственного источника. */
  const announce = <T,>(cfg: T): T => {
    getWin()?.webContents.send(CH.configChanged)
    rebuildTrayMenu()
    return cfg
  }

  /* ── Конфигурация ──────────────────────────────────────────────── */
  ipcMain.handle(CH.configGet, () => getConfig())
  ipcMain.handle(CH.configSave, (_e, cfg: AppConfig) => {
    const next = saveConfig(cfg)
    rebuildTrayMenu()
    return next
  })
  ipcMain.handle(CH.configPatch, (_e, patch: Partial<AppConfig>) => announce(patchConfig(patch)))
  ipcMain.handle(CH.configUpsertService, (_e, s: ServiceConfig) => {
    const prev = getConfig().services.find((x) => x.id === s.id)
    const next = upsertService(s)
    // URL или контур поменялись — вебвью пересоздаём, иначе останется старая сессия.
    if (prev && (prev.baseUrl !== s.baseUrl || prev.envId !== s.envId || (prev.enabled && !s.enabled))) {
      views()?.dispose(s.id)
    }
    return next
  })
  ipcMain.handle(CH.configRemoveService, (_e, id: string) => {
    views()?.dispose(id)
    return announce(removeService(id))
  })
  ipcMain.handle(CH.configReorderServices, (_e, envId: string, orderedIds: string[]) =>
    announce(reorderServices(envId, orderedIds))
  )
  ipcMain.handle(CH.configUpsertEnv, (_e, env: EnvConfig) => {
    const prev = getConfig().envs.find((x) => x.id === env.id)
    const next = upsertEnv(env)
    // Сессия вебвью настраивается при создании (прокси, доверие сертификатам),
    // поэтому при смене этих параметров пересоздаём вкладки контура.
    if (
      prev &&
      (prev.allowInsecureTls !== env.allowInsecureTls ||
        prev.caCertPath !== env.caCertPath ||
        prev.proxy !== env.proxy)
    ) {
      for (const svc of getConfig().services.filter((s) => s.envId === env.id)) {
        views()?.dispose(svc.id)
      }
    }
    rebuildTrayMenu()
    getWin()?.webContents.send(CH.configChanged)
    return next
  })

  /* ── Секреты ───────────────────────────────────────────────────── */
  ipcMain.handle(CH.secretsAvailable, () => secrets.encryptionAvailable())
  ipcMain.handle(CH.secretsList, () => secrets.listSecrets())
  ipcMain.handle(CH.secretsSet, (_e, ref: string, value: string, label?: string) => {
    secrets.setSecret(ref, value, label ?? ref)
    return secrets.listSecrets()
  })
  ipcMain.handle(CH.secretsVerify, (_e, ref: string, value: string) => secrets.verifySecret(ref, value))
  ipcMain.handle(CH.secretsHas, (_e, ref: string) => secrets.hasSecret(ref))
  ipcMain.handle(CH.secretsCopy, (_e, fromRef: string, toRef: string, label?: string) =>
    secrets.copySecret(fromRef, toRef, label)
  )
  ipcMain.handle(CH.secretsDelete, (_e, ref: string) => {
    secrets.deleteSecret(ref)
    return secrets.listSecrets()
  })
  ipcMain.handle(CH.secretsReveal, (_e, ref: string) => secrets.getSecret(ref))

  /* ── Контуры и туннели ─────────────────────────────────────────── */
  ipcMain.handle(CH.envStatus, () => health.all())
  ipcMain.handle(CH.envProbe, async (_e, envId: string) => {
    // Только этот контур, interactive — bank не уходит в checking.
    await health.probe(envId, { interactive: true })
    return health.all()
  })
  ipcMain.handle(CH.envClearSession, (_e, envId: string) => views()?.clearEnvSession(envId))

  /* ── Туннели ───────────────────────────────────────────────────── */
  ipcMain.handle(CH.vpnConnect, (_e, envId: string, otp?: string) => vpn.connect(envId, otp))
  ipcMain.handle(CH.vpnDisconnect, (_e, envId: string) => vpn.disconnect(envId))
  ipcMain.handle(CH.vpnConnectBoth, (_e, otps?: Record<string, string | undefined>) =>
    vpn.connectBoth(otps ?? {})
  )
  ipcMain.handle(CH.vpnVerifyAll, () => vpn.verifyAll())
  ipcMain.handle(CH.vpnDiscoverCheckpoint, () => vpn.discoverCheckpoint())
  ipcMain.handle(CH.vpnSnxAvailable, () => vpn.snxAvailable())
  ipcMain.handle(CH.vpnSnxLoginTypes, (_e, server: string, tls?: { allowInsecureTls?: boolean; caCertPath?: string | null }) =>
    vpn.snxLoginTypes(server, tls ?? {})
  )
  ipcMain.handle(CH.vpnSnxOpenInstaller, () => vpn.snxOpenInstaller())
  ipcMain.handle(CH.dnsCapture, () => captureDefaultDns())
  ipcMain.handle(CH.dnsApply, (_e, envId: string) => {
    const env = getConfig().envs.find((x) => x.id === envId)
    return env ? applySplitDns(env) : undefined
  })
  ipcMain.handle(CH.dnsClear, (_e, envId: string) => {
    const env = getConfig().envs.find((x) => x.id === envId)
    return env ? clearSplitDns(env) : undefined
  })

  /* ── Встроенные сервисы ────────────────────────────────────────── */
  ipcMain.handle(CH.viewShow, (_e, id: string, url?: string) => views()?.show(id, url) ?? false)
  ipcMain.handle(CH.viewHide, (_e, serviceId?: string) => {
    const closed = views()?.hide(serviceId) ?? null
    // Вышли из Mattermost/Jira — сразу пересчитать непрочитанное, не ждать полтора минуты.
    if (closed) void scheduler.syncService(closed)
    return closed
  })
  ipcMain.handle(CH.viewRestore, (_e, serviceIds: string[]) => {
    views()?.restore(serviceIds ?? [])
  })
  ipcMain.on(
    CH.viewBounds,
    (
      _e,
      b: {
        serviceId: string
        x: number
        y: number
        width: number
        height: number
        borderRadius?: number
      }
    ) => {
      if (!b?.serviceId) return
      views()?.setBounds(
        b.serviceId,
        {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height)
        },
        b.borderRadius
      )
    }
  )
  ipcMain.handle(CH.viewReload, (_e, id: string) => views()?.reload(id))
  ipcMain.handle(CH.viewBack, (_e, id: string) => views()?.goBack(id))
  ipcMain.handle(CH.viewHome, (_e, id: string) => views()?.goHome(id))
  ipcMain.handle(CH.viewUrl, (_e, id: string) => views()?.getUrl(id) ?? null)
  ipcMain.handle(CH.viewCapture, (_e, id: string) => views()?.capture(id) ?? null)
  ipcMain.handle(CH.viewFreeze, (_e, id: string) => views()?.freeze(id) ?? null)
  ipcMain.handle(CH.viewDevTools, (_e, id: string) => views()?.openDevTools(id))
  ipcMain.handle(CH.viewSuppress, (_e, on: boolean) => views()?.setSuppressed(Boolean(on)))

  /* ── Встроенный браузер ────────────────────────────────────────── */
  // Вкладки живут в том же менеджере, что и сервисы: показ, bounds и freeze
  // у них общие, а здесь — только то, чего у сервиса нет (список, навигация).
  ipcMain.handle(CH.browserState, () => views()?.browserState() ?? { tabs: [], activeId: null })
  ipcMain.handle(
    CH.browserNewTab,
    (_e, opts?: { envId?: string; url?: string; activate?: boolean; afterId?: string }) =>
      views()?.newTab(opts ?? {}) ?? null
  )
  ipcMain.handle(CH.browserCloseTab, (_e, id: string) => views()?.closeTab(id))
  ipcMain.handle(CH.browserActivateTab, (_e, id: string) => views()?.activateTab(id))
  ipcMain.handle(CH.browserMoveTab, (_e, id: string, to: number) => views()?.moveTab(id, to))
  ipcMain.handle(CH.browserNavigate, (_e, id: string, input: string) =>
    views()?.navigateTab(id, input)
  )
  ipcMain.handle(CH.browserBack, (_e, id: string) => views()?.goBack(id))
  ipcMain.handle(CH.browserForward, (_e, id: string) => views()?.tabForward(id))
  ipcMain.handle(CH.browserReload, (_e, id: string) => views()?.reload(id))
  ipcMain.handle(CH.browserStop, (_e, id: string) => views()?.tabStop(id))
  ipcMain.handle(CH.browserHome, (_e, id: string) => views()?.goHome(id))
  ipcMain.handle(CH.browserDevTools, (_e, id: string) => views()?.openDevTools(id))
  // Закладка прямо из браузера: заголовок и адрес берём у вкладки, а не у
  // рендерера — у него нет доступа к странице внутри нативного вебвью.
  ipcMain.handle(CH.browserBookmark, (_e, id: string) => {
    const info = views()?.tabInfo(id)
    if (!info) throw new Error('Вкладка не найдена')
    const saved = addBookmark({ url: info.url, title: info.title })
    emitBookmarksChanged()
    return saved
  })

  /* ── Элементы работы ───────────────────────────────────────────── */
  ipcMain.handle(CH.itemsQuery, (_e, q: ItemQuery) => queryItems(q ?? {}))
  ipcMain.handle(CH.itemsSearch, (_e, q: string) => searchItems(q))
  ipcMain.handle(CH.itemsMarkRead, (_e, ids: string | string[]) => {
    const list = Array.isArray(ids) ? ids : [ids]
    const n = markItemsRead(list)
    if (n > 0) emitItemsChanged()
    return n
  })
  ipcMain.handle(CH.mailGet, (_e, id: string) => getMail(id))
  ipcMain.handle(CH.mailSend, async (_e, payload: MailSendPayload) => {
    try {
      await sendMail(payload)
    } catch (e) {
      logError('mail', `отправка письма (${payload.serviceId}): ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    // Кому написали сами — первые кандидаты в подсказках «Кому» (как в Outlook).
    const envId = getConfig().services.find((s) => s.id === payload.serviceId)?.envId
    if (envId) rememberRecipients([payload.to, payload.cc].filter(Boolean).join(', '), envId)
  })
  ipcMain.handle(CH.mailMarkRead, (_e, id: string) => {
    markMailRead(id)
    emitItemsChanged()
  })
  ipcMain.handle(CH.mailListFolders, (_e, opts: { serviceId?: string; envId?: string } = {}) =>
    listMailFolders(opts)
  )
  ipcMain.handle(
    CH.mailListFoldersForRules,
    (_e, opts: { serviceId?: string; envId?: string } = {}) => listMailFoldersForRules(opts)
  )
  ipcMain.handle(
    CH.mailCreateFolder,
    (_e, opts: { serviceId: string; name: string; parentId?: string | null }) =>
      createMailFolder(opts)
  )
  ipcMain.handle(CH.mailMove, (_e, opts: { itemIds: string[]; folderId: string }) => moveMail(opts))
  ipcMain.handle(CH.mailListRules, (_e, opts: { serviceId?: string; envId?: string } = {}) =>
    listMailRules(opts)
  )
  ipcMain.handle(
    CH.mailUpsertRule,
    (_e, opts: { serviceId?: string; envId?: string; rule: MailRuleUpsert }) => upsertMailRule(opts)
  )
  ipcMain.handle(
    CH.mailDeleteRule,
    (_e, opts: { serviceId?: string; envId?: string; ruleId: string }) => deleteMailRule(opts)
  )
  ipcMain.handle(
    CH.mailSetRuleEnabled,
    (_e, opts: { serviceId?: string; envId?: string; ruleId: string; enabled: boolean }) =>
      setMailRuleEnabled(opts)
  )
  ipcMain.handle(CH.mailRulesSupported, (_e, serviceId: string) => mailRulesSupported(serviceId))
  ipcMain.handle(CH.calendarRespond, async (_e, id: string, response: MeetingResponseKind) => {
    const item = await respondToMeeting(id, response)
    emitItemsChanged()
    return item
  })
  ipcMain.handle(CH.calendarCreate, async (_e, payload: CalendarCreatePayload) => {
    let item: Awaited<ReturnType<typeof createMeeting>>
    try {
      item = await createMeeting(payload)
    } catch (e) {
      // Раньше ошибка уходила только в диалог — в логе не было ни следа.
      logError('calendar', `создание встречи (${payload.serviceId}): ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    emitItemsChanged()
    rememberRecipients(payload.attendees, item.envId)
    return item
  })
  ipcMain.handle(CH.calendarDetails, (_e, id: string) => getMeetingDetails(id))
  ipcMain.handle(CH.calendarUpdate, async (_e, payload: CalendarUpdatePayload) => {
    try {
      const item = await updateMeeting(payload)
      emitItemsChanged()
      return item
    } catch (e) {
      logError('calendar', `изменение встречи (${payload.itemId}): ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })
  ipcMain.handle(CH.calendarCancel, async (_e, payload: CalendarCancelPayload) => {
    try {
      await cancelMeeting(payload)
      emitItemsChanged()
    } catch (e) {
      logError('calendar', `отмена встречи (${payload.itemId}): ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })
  ipcMain.handle(CH.contactsSuggest, (_e, query: string, limit?: number) => suggestContacts(query, { limit }))
  ipcMain.handle(CH.calendarSuggestPeople, (_e, serviceId: string, query: string) =>
    suggestPeople(serviceId, query)
  )
  ipcMain.handle(CH.calendarSchedule, (_e, query: CalendarScheduleQuery) => getSchedule(query))
  ipcMain.handle(
    CH.tasksTransition,
    async (_e, id: string, target: { category?: string; statusName?: string }) => {
      const item = await transitionTask(id, target)
      emitItemsChanged()
      return item
    }
  )
  ipcMain.handle(CH.tasksBoard, (_e, serviceId?: string) => getTaskBoard(serviceId))
  ipcMain.handle(CH.todosList, () => listTodos())
  ipcMain.handle(CH.todosCreate, (_e, payload: TodoCreatePayload) => createTodo(payload))
  ipcMain.handle(CH.todosUpdate, (_e, payload: TodoUpdatePayload) => updateTodo(payload))
  ipcMain.handle(CH.todosRemove, (_e, id: string) => removeTodo(id))

  ipcMain.handle(CH.automationsList, () => listAutomationsView())
  ipcMain.handle(CH.automationsGet, (_e, id: string) => automationsGet(id))
  ipcMain.handle(CH.automationsUpsert, (_e, payload: AutomationUpsert) => automationsUpsert(payload))
  ipcMain.handle(CH.automationsDelete, (_e, id: string) => automationsDelete(id))
  ipcMain.handle(CH.automationsSetEnabled, (_e, id: string, enabled: boolean) =>
    automationsSetEnabled(id, enabled)
  )
  ipcMain.handle(CH.automationsRunNow, (_e, id: string) => automationsRunNow(id))
  ipcMain.handle(CH.automationsStepTypes, () => listStepTypes())

  ipcMain.handle(CH.syncNow, () => scheduler.tick())
  ipcMain.handle(CH.diagnose, (_e, serviceId: string) => diagnoseService(serviceId))

  // Забрать сессионный токен из куки уже открытой вкладки сервиса. Выручает,
  // когда персональные токены закрыты администратором: пользователь уже вошёл
  // во вкладке, и её сессия — валидный Bearer для API того же сервиса.
  ipcMain.handle(CH.logsRead, () => tailLog(400))
  ipcMain.handle(CH.logsReveal, () => shell.showItemInFolder(logFilePath()))

  ipcMain.handle(CH.faviconGet, (_e, serviceId: string, refresh?: boolean) =>
    getFavicon(serviceId, refresh)
  )

  /* ── Закладки ──────────────────────────────────────────────────── */
  ipcMain.handle(CH.bookmarksList, () => listAllBookmarks())
  ipcMain.handle(CH.bookmarksAdd, (_e, input: { url: string; title?: string }) => {
    const saved = addBookmark(input)
    emitBookmarksChanged()
    return saved
  })
  ipcMain.handle(CH.bookmarksAddFromService, (_e, serviceId: string) => {
    const url = views()?.getUrl(serviceId)
    if (!url) throw new Error('Текущий адрес вкладки недоступен')
    const title = views()?.getTitle(serviceId) ?? undefined
    const saved = addBookmark({ url, title, serviceId })
    emitBookmarksChanged()
    return saved
  })
  ipcMain.handle(CH.bookmarksRemove, (_e, id: string) => {
    deleteBookmark(id)
    emitBookmarksChanged()
  })

  ipcMain.handle(CH.mcpInfo, () => mcpInfo())
  ipcMain.handle(CH.mcpAgents, () => agentStates())
  ipcMain.handle(CH.mcpConnect, (_e, id: AgentId) => connectAgent(id))

  ipcMain.handle(CH.grabSessionToken, async (_e, serviceId: string) => {
    if (!getConfig().services.find((s) => s.id === serviceId)) throw new Error('Сервис не найден')
    const token = await grabSessionToken(serviceId)
    if (!token) {
      throw new Error('Сессия не найдена — откройте вкладку сервиса и войдите в неё, затем повторите')
    }
    return true
  })

  /* ── Заметки ───────────────────────────────────────────────────── */
  ipcMain.handle(CH.notesTree, () => notes.tree())
  ipcMain.handle(CH.notesRead, (_e, p: string) => notes.readNote(p))
  ipcMain.handle(CH.notesWrite, (_e, p: string, c: string) => notes.writeNote(p, c))
  ipcMain.handle(CH.notesCreate, (_e, p: string) => notes.createNote(p))
  ipcMain.handle(CH.notesCreateFolder, (_e, p: string) => notes.createFolder(p))
  ipcMain.handle(CH.notesRename, (_e, from: string, to: string) => notes.renameNote(from, to))
  ipcMain.handle(CH.notesDelete, (_e, p: string) => notes.deleteNote(p))
  ipcMain.handle(CH.notesSearch, (_e, q: string) => notes.searchNotes(q))
  ipcMain.handle(CH.notesBacklinks, (_e, p: string) => notes.backlinks(p))
  ipcMain.handle(CH.notesResolveLink, (_e, t: string) => notes.resolveLink(t))
  ipcMain.handle(CH.notesPickVault, async () => {
    const win = getWin()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Папка с заметками',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    patchConfig({ vaultPath: res.filePaths[0] })
    await notes.ensureVault()
    return res.filePaths[0]
  })
  ipcMain.handle(CH.notesRevealVault, async () => {
    await shell.openPath(await notes.ensureVault())
  })

  /* ── Файловый менеджер ─────────────────────────────────────────── */
  ipcMain.handle(CH.fsHome, () => files.homePath())
  ipcMain.handle(CH.fsFavorites, () => files.favorites())
  ipcMain.handle(CH.fsList, (_e, dir: string) => files.list(dir))
  ipcMain.handle(CH.fsOpen, (_e, p: string) => files.openPath(p))
  ipcMain.handle(CH.fsReveal, (_e, p: string) => {
    files.reveal(p)
  })
  ipcMain.handle(CH.fsMkdir, (_e, parent: string, name: string) => files.makeDir(parent, name))
  ipcMain.handle(CH.fsRename, (_e, from: string, name: string) => files.renamePath(from, name))
  ipcMain.handle(CH.fsTrash, (_e, p: string) => files.trash(p))
  ipcMain.handle(CH.fsPickFolder, async () => {
    const win = getWin()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Открыть папку',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  // Native OS drag — единственный способ дропнуть файл в WebContentsView.
  ipcMain.on(CH.fsDragStart, (event, paths: string | string[]) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p)
    )
    if (!list.length) return
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAnElEQVRYCe2WwQ2AIBAEt/9O7MQubMVOtBMr0Y5s4gUjHzgQ2J3kJZed2WwAgP8sADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADsAOwA7ADvgA+gA0qgE7n0AAAAASUVORK5CYII='
    )
    try {
      // Типы Electron требуют `file`; `files` — для multi-drag (если рантайм поддерживает).
      event.sender.startDrag({
        file: list[0]!,
        files: list,
        icon
      } as Electron.Item)
    } catch {
      /* drag отменён / невалидный путь */
    }
  })

  ipcMain.handle(CH.appGetVersion, () => app.getVersion())
  ipcMain.handle(CH.updateCheck, () => checkForUpdate())
  ipcMain.handle(CH.updateOpen, (_e, url?: string) => openUpdateDownload(url))

  /* ── Тема и прочее ─────────────────────────────────────────────── */
  ipcMain.handle(CH.themeSet, (_e, pref: ThemePref) => {
    nativeTheme.themeSource = pref
    patchConfig({ theme: pref })
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  })
  ipcMain.handle(CH.pickFile, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = getWin()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  // Обои: сразу отдаём data URL — рендерер не трогает файловую систему,
  // а CSP страницы разрешает только 'self' и data: для картинок.
  ipcMain.handle(CH.pickImage, async () => {
    const win = getWin()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Изображение для обоев',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    const path = res.canceled ? null : (res.filePaths[0] ?? null)
    if (!path) return null
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime =
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    const buf = await fs.readFile(path)
    // ~6MB исходника — с запасом под разумный десктопный wallpaper без раздувания config.json.
    if (buf.length > 6 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 6 МБ)')
    return `data:${mime};base64,${buf.toString('base64')}`
  })
  ipcMain.handle(CH.openExternal, (_e, url: string) => shell.openExternal(url))
  // Нативный клиент. Опциональный url — передать в приложение (macOS: open -a App url).
  ipcMain.handle(CH.openApp, async (_e, appPath: string, url?: string) => {
    if (url?.trim()) {
      try {
        await execFileAsync('open', ['-a', appPath, url.trim()])
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(msg || `Не удалось открыть ${appPath}`)
      }
    }
    const err = await shell.openPath(appPath)
    if (err) throw new Error(err)
  })
  ipcMain.handle(CH.notifyTest, () => notifyTest())

  ipcMain.handle(
    CH.terminalCreate,
    (_e, opts?: { cols?: number; rows?: number; cwd?: string }) => createPtySession(getWin, opts ?? {})
  )
  ipcMain.handle(CH.terminalWrite, (_e, id: string, data: string) => {
    writePty(id, data)
  })
  ipcMain.handle(CH.terminalResize, (_e, id: string, cols: number, rows: number) => {
    resizePty(id, cols, rows)
  })
  ipcMain.handle(CH.terminalKill, (_e, id: string) => {
    killPty(id)
  })

  ipcMain.handle(CH.keyboardLayoutGet, () => getKeyboardLayout())
}
