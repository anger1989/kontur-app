import {
  Tray,
  Menu,
  Notification,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  nativeImage
} from 'electron'
import type { EnvConfig, Item, NavTarget, TunnelState } from '@shared/types'
import { computeAttention } from '@shared/attention'
import { CH } from '@shared/ipc'
import { getConfig } from '../config/store'
import { queryItems } from '../db'
import { health } from '../net/health'
import * as vpn from '../net/vpn'
import { checkForUpdate, openUpdateDownload } from '../update/check'
import { TRAY_ICON_16, TRAY_ICON_32 } from './icon'
import { extractMeetingUrl } from '../notify/meetingLink'

export type { NavTarget }

let tray: Tray | null = null
let trayMenu: Menu | null = null
let getWin: (() => BrowserWindow | null) | null = null

function icon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_16}`)
  img.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${TRAY_ICON_32}`
  })
  // macOS: цветная иконка (не template) — подсолнух должен читаться в меню.
  img.setTemplateImage(false)
  return img
}

function showApp(): void {
  const win = getWin?.()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body, silent: false }).show()
}

/** Нужен ли OTP-диалог в renderer (Indeed на checkpoint — без диалога). */
function needsOtpUi(env: EnvConfig): boolean {
  return env.vpn.requiresOtp && env.vpn.kind !== 'checkpoint'
}

function tunnelEnvs(): EnvConfig[] {
  return getConfig().envs.filter(
    (e) => e.enabled && e.id !== 'shared' && (e.vpn.kind !== 'none' || e.healthCheckUrl)
  )
}

function tunnelLabel(t: TunnelState): string {
  if (t === 'up') return 'онлайн'
  if (t === 'checking') return 'проверка…'
  if (t === 'down') return 'офлайн'
  return 'не настроено'
}

async function trayConnect(env: EnvConfig): Promise<void> {
  if (needsOtpUi(env)) {
    showApp()
    getWin?.()?.webContents.send(CH.envTrayAction, { kind: 'connect', envId: env.id })
    return
  }
  try {
    await vpn.connect(env.id)
    await vpn.verifyAll()
    notify('Kontur', `«${env.name}» поднят`)
  } catch (e) {
    notify('Kontur', e instanceof Error ? e.message : String(e))
  }
  rebuildTrayMenu()
}

async function trayDisconnect(env: EnvConfig): Promise<void> {
  try {
    await vpn.disconnect(env.id)
    notify('Kontur', `«${env.name}» отключён`)
  } catch (e) {
    notify('Kontur', e instanceof Error ? e.message : String(e))
  }
  rebuildTrayMenu()
}

async function trayProbe(env: EnvConfig): Promise<void> {
  if (!env.healthCheckUrl) {
    notify('Kontur', `У «${env.name}» не задан адрес проверки`)
    return
  }
  try {
    const state = await health.probe(env.id)
    if (state === 'up') notify('Kontur', `«${env.name}» доступен`)
    else if (state === 'down') {
      const err = health.all().find((s) => s.envId === env.id)?.lastError
      notify('Kontur', err ? `«${env.name}»: ${err}` : `«${env.name}» недоступен`)
    } else notify('Kontur', `«${env.name}»: ${tunnelLabel(state)}`)
  } catch (e) {
    notify('Kontur', e instanceof Error ? e.message : String(e))
  }
  rebuildTrayMenu()
}

async function trayConnectBoth(): Promise<void> {
  const managed = tunnelEnvs().filter((e) => e.vpn.kind !== 'none')
  if (managed.some(needsOtpUi)) {
    showApp()
    getWin?.()?.webContents.send(CH.envTrayAction, { kind: 'connectBoth' })
    return
  }
  try {
    const verdict = await vpn.connectBoth({})
    const up = verdict.filter((v) => v.up)
    const down = verdict.filter((v) => !v.up)
    if (!down.length) notify('Kontur', 'Все контуры подняты')
    else if (up.length) {
      const names = (list: typeof verdict): string =>
        list
          .map((v) => getConfig().envs.find((e) => e.id === v.envId)?.name ?? v.envId)
          .join(', ')
      notify('Kontur', `Доступны: ${names(up)}. Не поднялись: ${names(down)}.`)
    } else notify('Kontur', 'Ни один контур не доступен')
  } catch (e) {
    notify('Kontur', e instanceof Error ? e.message : String(e))
  }
  rebuildTrayMenu()
}

function envSubmenu(env: EnvConfig): MenuItemConstructorOptions[] {
  const st = health.all().find((s) => s.envId === env.id)
  const tunnel = st?.tunnel ?? 'unknown'
  const up = tunnel === 'up'
  const canVpn = env.vpn.kind !== 'none'
  const items: MenuItemConstructorOptions[] = [
    { label: tunnelLabel(tunnel), enabled: false }
  ]
  if (canVpn && up) {
    items.push({
      label: 'Отключить',
      click: () => void trayDisconnect(env)
    })
  }
  if (canVpn && !up) {
    items.push({
      label: 'Подключить',
      click: () => void trayConnect(env)
    })
  }
  items.push({
    label: 'Проверить',
    enabled: Boolean(env.healthCheckUrl),
    click: () => void trayProbe(env)
  })
  return items
}

export function rebuildTrayMenu(): void {
  if (!tray) return
  const envs = tunnelEnvs()
  const managed = envs.filter((e) => e.vpn.kind !== 'none')
  const envItems: MenuItemConstructorOptions[] = envs.map((env) => {
    const tunnel = health.all().find((s) => s.envId === env.id)?.tunnel ?? 'unknown'
    const mark = tunnel === 'up' ? '●' : tunnel === 'checking' ? '…' : '○'
    return {
      label: `${mark} ${env.name}`,
      submenu: envSubmenu(env)
    }
  })

  const template: MenuItemConstructorOptions[] = [
    { label: 'Открыть Kontur', click: showApp },
    { type: 'separator' }
  ]
  if (envItems.length) {
    template.push(...envItems)
    if (managed.length > 1) {
      template.push({
        label: 'Поднять оба',
        click: () => void trayConnectBoth()
      })
    }
    template.push({ type: 'separator' })
  }
  template.push({
    label: 'Проверить обновления…',
    click: () => {
      void (async () => {
        try {
          const info = await checkForUpdate()
          if (!info.available) {
            notify('Kontur', `У вас актуальная версия ${info.currentVersion}`)
            return
          }
          notify(
            'Kontur',
            `Доступна ${info.latestVersion} (сейчас ${info.currentVersion}). Открываю страницу загрузки…`
          )
          await openUpdateDownload(info.downloadUrl)
        } catch (e) {
          notify('Kontur', e instanceof Error ? e.message : String(e))
        }
      })()
    }
  })
  template.push({ type: 'separator' })
  template.push({ label: 'Выйти', role: 'quit' })
  // Не setContextMenu: на macOS левый клик тоже открывал бы меню.
  // Меню только по правому — через popUpContextMenu в right-click.
  trayMenu = Menu.buildFromTemplate(template)
}

export function initTray(getWindow: () => BrowserWindow | null): void {
  if (tray) return
  getWin = getWindow
  tray = new Tray(icon())
  tray.setToolTip('Kontur')
  // ЛКМ — показать окно; ПКМ — меню (setContextMenu на macOS ломает это).
  tray.on('click', showApp)
  tray.on('right-click', () => {
    if (trayMenu) tray?.popUpContextMenu(trayMenu)
  })
  rebuildTrayMenu()
  // Статус контуров меняется — обновляем подписи в меню.
  health.on('change', () => rebuildTrayMenu())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  trayMenu = null
  getWin = null
}

/** Бейдж внимания рядом с иконкой. */
export function setTrayBadge(count: number): void {
  tray?.setToolTip(count > 0 ? `Kontur — ${count} требует внимания` : 'Kontur')
  tray?.setTitle(count > 0 ? String(count) : '')
}

/** Пересчитать бейдж по кэшу — непрочитанное/открытое, не «все items». */
export function refreshTrayBadge(): void {
  setTrayBadge(computeAttention(queryItems({ limit: 2000 })).todayActive)
}

/** Как назвать уведомление для каждого вида элемента. */
const KIND_TITLE: Record<string, string> = {
  mail: 'Новое письмо',
  message: 'Новое сообщение',
  task: 'Новая задача',
  review: 'Ревью',
  event: 'Событие',
  page: 'Страница'
}

/** Во множественном числе — для сводки. */
function plural(kind: string, n: number): string {
  const forms: Record<string, [string, string, string]> = {
    mail: ['письмо', 'письма', 'писем'],
    message: ['сообщение', 'сообщения', 'сообщений'],
    task: ['задача', 'задачи', 'задач'],
    review: ['ревью', 'ревью', 'ревью'],
    event: ['событие', 'события', 'событий'],
    page: ['страница', 'страницы', 'страниц']
  }
  const f = forms[kind] ?? ['элемент', 'элемента', 'элементов']
  const mod10 = n % 10
  const mod100 = n % 100
  const word =
    mod10 === 1 && mod100 !== 11
      ? f[0]
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
        ? f[1]
        : f[2]
  return `${n} ${word}`
}

/** Куда вести по клику на баннер. */
export function targetFor(it: Item): NavTarget {
  const svc = getConfig().services.find((s) => s.id === it.serviceId)
  const embed =
    svc && (svc.mode === 'embed' || svc.mode === 'both') && Boolean(svc.baseUrl)

  if (it.kind === 'mail') return { kind: 'page', page: 'mail', itemId: it.id }
  if (it.kind === 'event') return { kind: 'page', page: 'calendar', itemId: it.id }

  if (embed && (it.kind === 'message' || it.kind === 'task' || it.kind === 'review' || it.kind === 'page')) {
    return { kind: 'service', serviceId: svc!.id, url: it.url || undefined }
  }

  if (it.kind === 'task' || it.kind === 'review') {
    return { kind: 'page', page: 'tasks', itemId: it.id }
  }
  return { kind: 'page', page: 'today', itemId: it.id }
}

function snippet(text: string | null | undefined, max = 140): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Ключ «одинаковости» для схлопывания баннеров.
 * MM realtime шлёт каждый пост отдельно — без ключа Notification Center
 * копится стопкой из одного канала. Встречи из двух контуров — один слот.
 */
function notifyCollapseKey(it: Item): string {
  if (it.kind === 'message') {
    const id = it.id
    const chIdx = id.indexOf(':channel:')
    if (chIdx >= 0) return `message:${it.serviceId}:${id.slice(chIdx)}`
    const postIdx = id.indexOf(':post:')
    // Посты одного канала: «Имя в #канал» / «Имя в @dm» — хвост после « в ».
    const room = it.title.match(/\sв\s(.+)$/)?.[1]?.trim()
    if (room) return `message:${it.serviceId}:room:${room}`
    if (postIdx >= 0) return `message:${it.serviceId}:${id.slice(0, postIdx)}`
    return `message:${it.serviceId}:${it.title}`
  }
  if (it.kind === 'event' && it.startsAt != null) {
    return `event:${it.startsAt}:${it.endsAt ?? ''}`
  }
  return `${it.kind}:${it.id}`
}

type NotifyHandlers = {
  onOpen: (target: NavTarget) => void
  onJoin: (url: string) => void
}

let notifyBuf: Item[] = []
let notifyHandlers: NotifyHandlers | null = null
let notifyFlushTimer: ReturnType<typeof setTimeout> | null = null

/** Склеить шквал realtime/sync в один тик — иначе каждый пост = свой баннер. */
const NOTIFY_DEBOUNCE_MS = 1200

/**
 * Системные уведомления о новом в подключённых сервисах.
 *
 * Одно событие — кто и что; пачку и одинаковые (канал MM, слот встречи)
 * сворачиваем. Клик открывает сервис/раздел (Mattermost — permalink).
 */
export function notifyNew(
  all: Item[],
  onOpen: (target: NavTarget) => void,
  onJoin: (url: string) => void
): void {
  if (!all.length || !Notification.isSupported()) return
  if (!getConfig().notifications) return

  notifyBuf.push(...all)
  notifyHandlers = { onOpen, onJoin }
  if (notifyFlushTimer) clearTimeout(notifyFlushTimer)
  notifyFlushTimer = setTimeout(flushNotifyNew, NOTIFY_DEBOUNCE_MS)
}

function flushNotifyNew(): void {
  notifyFlushTimer = null
  const handlers = notifyHandlers
  const raw = notifyBuf
  notifyBuf = []
  notifyHandlers = null
  if (!handlers || !raw.length || !Notification.isSupported()) return
  const cfg = getConfig()
  if (!cfg.notifications) return

  // «Отправленные» и «Черновики» — то, что написали мы сами. Сервер кладёт
  // туда и служебные ответы: приняв встречу, вы получали баннер «Новое письмо —
  // Принято: …», а в «Входящих» его, естественно, не было.
  const filtered = raw.filter((it) => {
    const folder = it.folder ?? 'inbox'
    return !(it.kind === 'mail' && (folder === 'sent' || folder === 'drafts'))
  })
  if (!filtered.length) return

  // Одинаковые → одна группа (свежий head + count).
  const groups = new Map<string, Item[]>()
  for (const it of filtered) {
    const key = notifyCollapseKey(it)
    const arr = groups.get(key) ?? []
    arr.push(it)
    groups.set(key, arr)
  }
  const collapsed = [...groups.entries()].map(([key, list]) => {
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return { key, head: list[0]!, count: list.length }
  })

  const envName = (id: string): string => cfg.envs.find((e) => e.id === id)?.name ?? ''
  const serviceName = (id: string): string => cfg.services.find((s) => s.id === id)?.name ?? ''

  if (collapsed.length === 1) {
    const { key, head: it, count } = collapsed[0]!
    const where = [serviceName(it.serviceId), envName(it.envId)].filter(Boolean).join(' · ')
    const isEvent = it.kind === 'event'
    const isMessage = it.kind === 'message'
    const when =
      isEvent && it.startsAt != null
        ? (() => {
            const d = new Date(it.startsAt)
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          })()
        : null
    const title = isEvent
      ? `Новая встреча${where ? ` — ${where}` : ''}`
      : `${KIND_TITLE[it.kind] ?? 'Обновление'}${where ? ` — ${where}` : ''}`
    let body = isEvent
      ? when
        ? `${when} · ${it.title}`
        : it.title
      : isMessage
        ? snippet(it.body) || it.title
        : it.author
          ? `${it.author}: ${it.title}`
          : it.title
    if (count > 1) {
      body = isMessage
        ? `${count} в этом канале · ${body}`
        : isEvent
          ? body
          : `${count}: ${body}`
    }
    const joinUrl = isEvent ? extractMeetingUrl(it) : null
    // id стабильный — macOS заменяет прошлый баннер той же группы, а не копит.
    const n = new Notification({
      id: `kontur:${key}`,
      groupId: key,
      title,
      body,
      silent: false,
      actions: joinUrl ? [{ type: 'button', text: 'Подключиться' }] : undefined
    })
    n.on('click', () => handlers.onOpen(targetFor(it)))
    if (joinUrl) n.on('action', () => handlers.onJoin(joinUrl))
    n.show()
    return
  }

  // Несколько разных групп: сводка по видам (уже после схлопывания дублей).
  const byKind = new Map<string, number>()
  for (const { head, count } of collapsed) {
    byKind.set(head.kind, (byKind.get(head.kind) ?? 0) + count)
  }
  const parts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => plural(kind, n))

  const dominant = collapsed.slice().sort((a, b) => {
    const ca = byKind.get(a.head.kind) ?? 0
    const cb = byKind.get(b.head.kind) ?? 0
    return cb - ca
  })[0]!.head

  const n = new Notification({
    id: 'kontur:batch',
    groupId: 'kontur:batch',
    title: 'Kontur — новые события',
    body: parts.join(', ')
  })
  n.on('click', () => handlers.onOpen(targetFor(dominant)))
  n.show()
}

/** Ручная проверка баннера из настроек. */
export function notifyTest(): { ok: boolean; message: string } {
  if (!Notification.isSupported()) {
    return { ok: false, message: 'Система не поддерживает уведомления' }
  }
  const n = new Notification({
    title: 'Kontur',
    body: 'Тестовое уведомление. Если видишь баннер — разрешено.',
    silent: false
  })
  n.show()
  // После первого show() приложение должно появиться в списке Уведомлений.
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
  )
  return {
    ok: true,
    message:
      'Баннер отправлен. Если Kontur не в списке — полностью закрой приложение (Cmd+Q) и открой снова из /Applications, затем повтори.'
  }
}
