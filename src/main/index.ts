import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { getConfig } from './config/store'
import { closeDb, initDb } from './db'
import { health } from './net/health'
import { closeTransports } from './net/transport'
import { autoConnectOnLaunch } from './net/vpn'
import { scheduler } from './sync/scheduler'
import { startMcp, stopMcp } from './ai/mcpServer'
import { closeEasAgents } from './connectors/eas/http'
import { destroyTray, initTray, notifyNew, refreshTrayBadge } from './tray'
import { emitItemsChanged } from './notify/itemsChanged'
import { startMeetingReminders, stopMeetingReminders } from './notify/reminders'
import { onNewAttentionItems, startAutomations, stopAutomations } from './automations'
import { ensureVault } from './notes/vault'
import { registerIpc } from './ipc'
import { disposeAllPtys } from './terminal/pty'
import { startKeyboardLayoutWatch, stopKeyboardLayoutWatch } from './keyboardLayout'
import { ServiceViewManager } from './views/serviceViews'
import { resolveExternalLink } from './views/externalLink'
import { openSafeExternal } from './security/externalOpen'

let win: BrowserWindow | null = null
let views: ServiceViewManager | null = null
let shuttingDown = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Светлый и тёмный фон окна до первой отрисовки, чтобы не моргало белым.
    // BrowserWindow.icon влияет на Linux/Windows; на macOS в Dock — из .icns в бандле.
    icon: join(__dirname, '../../build/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#13161c' : '#f7f8fa',
    titleBarStyle: 'hiddenInset',
    // Шапка h-10 (40px), светофор ~12px → y = (40-12)/2 = 14.
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  views = new ServiceViewManager(win)

  /**
   * Ссылка на чужой домен, открытая из вебвью (в чате кинули ссылку).
   * Решение — в resolveExternalLink, здесь только исполнение.
   */
  views.onExternalLink = (sourceServiceId, url) => {
    const target = resolveExternalLink(getConfig(), sourceServiceId, url)
    if (target.kind === 'ignore') return
    if (target.kind === 'system') {
      void openSafeExternal(target.url)
      return
    }
    // Посторонний сайт забирает встроенный браузер — в контуре источника,
    // чтобы ссылка из банковского чата шла банковской сессией и туннелем.
    if (target.kind === 'web') {
      if (views?.newTab({ envId: target.envId, url: target.url })) {
        win?.webContents.send(CH.openRoute, { kind: 'page', page: 'browser' })
      }
      return
    }
    win?.webContents.send(CH.openRoute, {
      kind: 'service',
      serviceId: target.serviceId,
      url: target.url
    })
  }

  /** Хром браузера рисует рендерер — состояние вкладок живёт в main. */
  views.onBrowserChange = (state) => win?.webContents.send(CH.browserChanged, state)
  views.onLoadingChange = (id, loading) =>
    win?.webContents.send(CH.viewLoadingChanged, { id, loading })
  views.onCycleWindow = (dir) => win?.webContents.send(CH.deskCycleWindow, dir)
  views.onConfirmCycleWindow = () => win?.webContents.send(CH.deskConfirmCycleWindow)

  // Светофор скрывается только в fullscreen; при zoom/maximize остаётся.
  // Шапка рендерера знает об этом из события — и дополнительно спрашивает
  // состояние сама при монтировании: заставка держит её 5 секунд, так что
  // ранний сигнал из ready-to-show она просто не успевает услышать.
  const emitFullScreen = (): void => {
    if (!win || win.isDestroyed()) return
    win.webContents.send(CH.windowMaximizedChanged, win.isFullScreen())
  }
  win.on('ready-to-show', () => {
    win?.show()
    emitFullScreen()
  })
  win.on('enter-full-screen', emitFullScreen)
  win.on('leave-full-screen', emitFullScreen)
  win.on('show', emitFullScreen)
  // Перезагрузка рендерера (dev-HMR, возврат из блокировки) начинается с
  // чистого состояния — шлём ей текущий fullscreen сразу после загрузки.
  win.webContents.on('did-finish-load', emitFullScreen)
  // Закрытие окна = выход из приложения. Раньше окно пряталось в трей и
  // Kontur продолжал работать невидимым — так его закрывали, а он оставался
  // висеть в фоне. Полный выход теперь даёт и крестик, и Cmd+Q.
  win.on('close', () => {
    // Пока окно ещё живо — снять WebContentsView, иначе на `closed` будет
    // "Object has been destroyed".
    views?.disposeAll()
    views = null
  })
  win.on('closed', () => {
    views?.disposeAll()
    views = null
    win = null
  })

  // Сам UI никуда не навигирует: внешние ссылки уходят в системный браузер.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openSafeExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  // Фокус в хроме — ⌥⌘I / Ctrl+Shift+I гасят DevTools. Esc не трогаем.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    const isDt =
      mod &&
      (input.alt || input.shift) &&
      (input.key.toLowerCase() === 'i' || input.code === 'KeyI')
    if (!isDt) return
    if (views?.closeAnyDevTools()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  initDb()
  const cfg = getConfig()
  nativeTheme.themeSource = cfg.theme
  await ensureVault()

  registerIpc(
    () => win,
    () => views
  )

  nativeTheme.on('updated', () => {
    win?.webContents.send(CH.themeChanged, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })

  health.on('change', (status) => {
    win?.webContents.send(CH.envChanged, status)
    // Статус контуров в строке меню macOS (рядом с иконкой трея).
    refreshTrayBadge()
  })
  health.start()

  const showWindow = (): void => {
    if (!win) createWindow()
    else {
      win.show()
      win.focus()
    }
  }

  scheduler.on('items', () => {
    emitItemsChanged()
  })
  scheduler.on('new-items', (items) => {
    notifyNew(
      items,
      (target) => {
        showWindow()
        win?.webContents.send(CH.openRoute, target)
      },
      (url) => {
        showWindow()
        win?.webContents.send(CH.joinMeeting, url)
      }
    )
  })
  // Автоматизации по событиям — отдельным потоком: они должны отработать и на
  // первом синке после запуска (что пришло, пока приложение было закрыто).
  scheduler.on('fresh-items', (items) => {
    onNewAttentionItems(items)
  })
  scheduler.on('error', ({ serviceId, error }) => console.warn(`[sync] ${serviceId}: ${error}`))
  scheduler.start()
  startAutomations()
  startKeyboardLayoutWatch(() => win)

  createWindow()
  initTray(() => win)
  startMeetingReminders(
    (target) => {
      showWindow()
      win?.webContents.send(CH.openRoute, target)
    },
    (url) => {
      showWindow()
      win?.webContents.send(CH.joinMeeting, url)
    }
  )
  // Текущее число «требует внимания» сразу при старте.
  refreshTrayBadge()

  // Контуры, помеченные «поднимать при старте» — в фоне, окно не ждёт.
  void autoConnectOnLaunch()

  // Обновления через GitHub Releases (без Developer ID — только предложение скачать DMG).
  void import('./update/check').then(({ silentCheckForUpdate }) =>
    silentCheckForUpdate().then((info) => {
      if (info) win?.webContents.send(CH.updateAvailable, info)
    })
  )

  // Локальный MCP-сервер для подключения агентов (Cursor, Codex, Claude).
  void startMcp().catch((e) => console.warn('[mcp]', e))

  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
})

app.on('window-all-closed', () => {
  // Закрыли окно — закрыли Kontur, на любой платформе.
  app.quit()
})

app.on('before-quit', (e) => {
  // Повторный before-quit после нашего app.exit не нужен.
  if (shuttingDown) return
  e.preventDefault()
  shuttingDown = true

  // Hang/crash: FreeEnvironment → CleanupHandles. node-pty TSFN на живых
  // сессиях → ThrowAsJavaScriptException → SIGABRT (node-pty#904). Сначала
  // await dispose PTY, потом рвём MCP/undici handles.
  void (async () => {
    scheduler.stop()
    stopAutomations()
    stopMeetingReminders()
    health.stop()
    destroyTray()
    views?.disposeAll()
    views = null
    stopKeyboardLayoutWatch()
    await Promise.race([
      Promise.all([
        disposeAllPtys(1500),
        stopMcp(),
        closeTransports(),
        closeEasAgents()
      ]),
      new Promise<void>((r) => setTimeout(r, 2500))
    ])
    closeDb()
    app.exit(0)
  })()
})
