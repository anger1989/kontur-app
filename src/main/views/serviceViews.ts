import { WebContentsView, session, shell, type BaseWindow, type Rectangle, type Session, type WebContents } from 'electron'
import type { BrowserState, BrowserTabState, EnvConfig, ServiceConfig } from '@shared/types'
import { hostLabel, resolveBrowserInput } from '@shared/browserUrl'
import { getConfig, getEnv } from '../config/store'
import { getSecret } from '../config/secrets'
import { rememberFaviconUrl } from '../services/favicon'
import { logInfo } from '../log'

/**
 * Встроенные сервисы живут в настоящих WebContentsView, а не в iframe.
 *
 * Это и есть главный выигрыш нативного приложения: ничего не нужно делать
 * с X-Frame-Options и CSP, сайт вообще не знает, что он встроен. А партиция
 * на контур даёт две независимые банки кук — можно одновременно быть
 * залогиненным в двух разных Jira без вторых профилей браузера.
 *
 * Несколько окон сервисов могут быть видны одновременно: у каждого свой
 * WebContentsView и свои bounds. z-порядок среди нативных view — через
 * addChildView (последний добавленный сверху). Поверх любого DOM они всё
 * равно рисуются — поэтому React-страница сверху обязана спрятать все view.
 *
 * Здесь же живут вкладки встроенного браузера (`tab:…`). Они не сервисы и
 * их нет в конфиге, но весь нативный слой у них общий с сервисами: те же
 * bounds, тот же freeze под чужим окном, тот же запрет показа на блокировке.
 * Разводить это на два менеджера значило бы дублировать всю эту механику.
 */
/** Совпадает с `rounded-xl` у DOM-окна. */
const WINDOW_CORNER_RADIUS = 12
/** Иконка сайта крупнее — почти наверняка не иконка. */
const FAVICON_MAX_BYTES = 512 * 1024

/** Вкладка браузера: состояние рядом со своим WebContentsView. */
interface Tab {
  id: string
  envId: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
}

/**
 * Встроенному Толку нельзя самому запускать десктопное приложение.
 *
 * Страница встречи Толка сразу дёргает `ktalk://…`, а Electron по умолчанию
 * разрешает такие переходы — открывались и вебвью, и десктопный клиент той же
 * встречи разом. Раз сервис настроен на вебвью, встреча идёт в вебвью; кто хочет
 * десктоп — выбирает режим «Отдельное приложение» (там openLink запускает .app).
 */
function blocksExternalApps(service: ServiceConfig | undefined): boolean {
  return service?.kind === 'ktalk' && service.mode !== 'launcher'
}

/** Ссылка ведёт на тот же сайт, что и сам сервис. */
function sameOrigin(url: string, baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(url).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

interface ViewChrome {
  bounds: Rectangle
  borderRadius: number
}

export class ServiceViewManager {
  private views = new Map<string, WebContentsView>()
  private visible = new Set<string>()
  private chrome = new Map<string, ViewChrome>()
  /** Последний freeze-кадр (data URL), пока view спрятан под другим окном. */
  private snapshots = new Map<string, string>()
  /** Сессии, на которые уже повешен обработчик разрешений (он один на сессию). */
  private guardedSessions = new WeakSet<Session>()
  /** Во вкладке печатали руками — автологин туда больше не лезет. */
  private typedIn = new Set<string>()
  /** Автоотправка формы — не больше одного раза на вкладку. */
  private autoSubmitted = new Set<string>()
  /**
   * Экран заблокирован или идёт заставка. Нативный WebContentsView рисуется
   * поверх любого DOM, поэтому запрет живёт здесь, а не в рендерере: иначе
   * любой ре-рендер ServiceHost возвращал вебвью на экран — и рабочий чат
   * оказывался поверх окна блокировки.
   */
  private suppressed = false
  /** Что было видно до блокировки — вернём в том же z-порядке. */
  private suppressedVisible: string[] = []

  /** Вкладки браузера по id; порядок — отдельно, его двигает пользователь. */
  private tabs = new Map<string, Tab>()
  private tabOrder: string[] = []
  private activeTab: string | null = null
  private tabSeq = 0
  /**
   * Геометрия области контента окна браузера — одна на все вкладки.
   * Своего `chrome` у вкладки нет: переключение не меняет размеров, а новая
   * вкладка обязана встать ровно туда, где была предыдущая, ещё до того как
   * рендерер успеет прислать bounds.
   */
  private browserChrome: ViewChrome | null = null
  /** Состояние браузера изменилось — рендереру пора перерисовать хром. */
  onBrowserChange: ((state: BrowserState) => void) | null = null
  private browserEmitTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Ссылка на чужой домен из вебвью. Решение, куда её вести, принимает main
   * (index.ts): сюда не затаскиваем ни конфиг сервисов, ни окно рендерера.
   */
  onExternalLink: ((sourceServiceId: string, url: string) => void) | null = null

  constructor(private win: BaseWindow) {}

  private applyChrome(serviceId: string, view: WebContentsView): void {
    const c = this.chrome.get(serviceId) ?? (this.tabs.has(serviceId) ? this.browserChrome : null)
    if (!c) return
    view.setBounds(c.bounds)
    view.setBorderRadius(c.borderRadius)
  }

  private serviceIdOf(wc: WebContents): string | null {
    for (const [id, view] of this.views) if (view.webContents === wc) return id
    return null
  }

  /**
   * Переходы на `ktalk://` и подобные Electron пропускает через разрешение
   * `openExternal` (по умолчанию — да). Сессия общая на контур, поэтому решаем
   * по вкладке: отказываем только сервисам, которым это запрещено. Остальные
   * разрешения (камера, микрофон для звонков и т.д.) — как и были, разрешены.
   */
  private guardExternalApps(ses: Session): void {
    if (this.guardedSessions.has(ses)) return
    this.guardedSessions.add(ses)
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'openExternal') {
        const id = this.serviceIdOf(wc)
        const svc = id ? getConfig().services.find((x) => x.id === id) : undefined
        if (blocksExternalApps(svc)) {
          const scheme = ('externalURL' in details && details.externalURL ? details.externalURL : '').split(':')[0]
          logInfo('views', `${id}: запуск внешнего приложения заблокирован (${scheme}:)`)
          callback(false)
          return
        }
      }
      callback(true)
    })
  }

  /**
   * Сессия контура: прокси, политика сертификатов, разрешения. Одна на
   * партицию — вызывать можно сколько угодно, настройки просто переписываются.
   */
  private prepareSession(env: EnvConfig): Session {
    const ses = session.fromPartition(env.partition)
    if (env.proxy) {
      void ses.setProxy({ proxyRules: env.proxy })
    } else {
      void ses.setProxy({ mode: 'direct' })
    }
    if (env.caCertPath || env.allowInsecureTls) {
      ses.setCertificateVerifyProc((_request, callback) => callback(0))
    }
    this.guardExternalApps(ses)
    return ses
  }

  /** Вебвью по id: вкладка браузера или встроенный сервис. */
  private ensureAny(id: string): WebContentsView | null {
    const tab = this.tabs.get(id)
    if (tab) return this.views.get(id) ?? this.createTabView(tab)
    const service = getConfig().services.find((s) => s.id === id)
    return service ? this.ensure(service) : null
  }

  private ensure(service: ServiceConfig): WebContentsView | null {
    const existing = this.views.get(service.id)
    if (existing) return existing
    if (!service.baseUrl) return null

    const env = getEnv(service.envId)
    if (!env) return null

    const partition = env.partition
    this.prepareSession(env)

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true
      }
    })

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        // Свой домен — остаётся в этой же вкладке. Чужой заменять нельзя:
        // ссылка из чата затирала собой Mattermost, и «назад» было некуда.
        if (sameOrigin(url, service.baseUrl)) {
          void view.webContents.loadURL(url)
        } else {
          this.onExternalLink?.(service.id, url)
        }
      } else if (blocksExternalApps(getConfig().services.find((x) => x.id === service.id))) {
        logInfo('views', `${service.id}: запуск внешнего приложения заблокирован (${url.split(':')[0]}:)`)
      } else {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    const wc = view.webContents

    wc.on('certificate-error', (event, _url, error, _cert, callback) => {
      if (env.caCertPath || env.allowInsecureTls) {
        event.preventDefault()
        callback(true)
      } else {
        callback(false)
        this.showErrorPage(view, `Сервис «${service.name}» не открылся`, {
          code: 'CERT',
          desc: `Сертификат сайта не доверенный (${error}). Включите «Доверять сертификатам контура» в настройках контура «${env.name}».`
        })
      }
    })

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.showErrorPage(view, `Сервис «${service.name}» не открылся`, {
        code: String(errorCode),
        desc: errorDescription,
        url: validatedURL
      })
    })

    wc.on('render-process-gone', (_e, details) => {
      this.showErrorPage(view, `Сервис «${service.name}» не открылся`, {
        code: 'CRASH',
        desc: `Процесс вкладки завершился: ${details.reason}`
      })
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons[0]) rememberFaviconUrl(service.id, favicons[0])
    })

    // Первое же нажатие клавиши во вкладке — знак, что человек вошёл сам.
    // Дальше автологин молчит: он подставлял пароль в пустое поле и нажимал
    // «войти» прямо посреди набора логина, из-за чего форма уходила на сервер
    // и Jira гасила поля. Плюс это защита от серии неверных попыток и
    // блокировки доменной учётки.
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown') this.typedIn.add(service.id)
    })

    wc.on('did-finish-load', () => {
      const current = getConfig().services.find((s) => s.id === service.id)
      if (!current?.autoLogin.enabled) return
      if (this.typedIn.has(service.id)) return
      const url = wc.getURL()
      if (!url.startsWith('http')) return
      const password = getSecret(`${current.id}.secret`)
      const username = current.auth.username
      if (!username && !password) return
      void this.injectLogin(service.id, view, current.autoLogin, username, password)
    })

    view.setVisible(false)
    this.win.contentView.addChildView(view)
    void wc.loadURL(service.baseUrl)
    this.views.set(service.id, view)
    return view
  }

  private async injectLogin(
    serviceId: string,
    view: WebContentsView,
    cfg: { userSelector: string; passSelector: string; submitSelector: string },
    username: string | null,
    password: string | null
  ): Promise<void> {
    const script = `(() => {
      const setVal = (sel, val) => {
        const el = document.querySelector(sel)
        if (!el) return { filled: false, value: '' }
        // Строго поле ввода: на форме Jira кнопка отправки — это input
        // name="login", и писать в неё значение нельзя.
        const type = (el.type || 'text').toLowerCase()
        if (!['text', 'email', 'tel', 'password'].includes(type)) {
          return { filled: false, value: '' }
        }
        // В поле уже что-то есть или в нём стоит курсор — не трогаем:
        // человек вводит сам, и подстановка ему только мешает.
        if (!val || el.value || el === document.activeElement) {
          return { filled: false, value: el.value || '' }
        }
        const proto = Object.getPrototypeOf(el)
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        setter ? setter.call(el, val) : (el.value = val)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { filled: true, value: val }
      }
      const u = setVal(${JSON.stringify(cfg.userSelector)}, ${JSON.stringify(username ?? '')})
      const p = setVal(${JSON.stringify(cfg.passSelector)}, ${JSON.stringify(password ?? '')})
      return { filled: u.filled || p.filled, complete: Boolean(u.value && p.value) }
    })()`
    try {
      const res = (await view.webContents.executeJavaScript(script, true)) as {
        filled: boolean
        complete: boolean
      }
      // Отправляем, только если форма заполнена целиком и это наша работа:
      // половинная отправка — это гарантированно неверная попытка входа.
      if (!res.filled || !res.complete || !cfg.submitSelector) return
      if (this.typedIn.has(serviceId) || this.autoSubmitted.has(serviceId)) return
      this.autoSubmitted.add(serviceId)
      await view.webContents.executeJavaScript(
        `(() => { const b = document.querySelector(${JSON.stringify(cfg.submitSelector)}); if (b) b.click(); })()`,
        true
      )
    } catch {
      /* форма не нашлась */
    }
  }

  /** Страница ошибки вместо пустого вебвью — и у сервиса, и у вкладки браузера. */
  private showErrorPage(
    view: WebContentsView,
    heading: string,
    err: { code: string; desc: string; url?: string }
  ): void {
    const esc = (t: string): string =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{color-scheme:light dark}
      body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.6 -apple-system,system-ui,sans-serif;
        background:#f7f8fa;color:#0f172a}
      @media(prefers-color-scheme:dark){body{background:#13161c;color:#e8edf5}}
      .box{max-width:460px;padding:0 24px;text-align:center}
      h1{font-size:17px;margin:0 0 8px}
      p{color:#64748b;margin:0 0 6px}
      @media(prefers-color-scheme:dark){p{color:#8b94a3}}
      code{font-family:ui-monospace,Menlo,monospace;font-size:12px;opacity:.7}
      button{margin-top:18px;height:34px;padding:0 16px;border:0;border-radius:6px;
        background:#f09a05;color:#0a0a0c;font:inherit;cursor:pointer}
    </style></head><body><div class="box">
      <h1>${esc(heading)}</h1>
      <p>${esc(err.desc)}</p>
      ${err.url ? `<p><code>${esc(err.url)}</code></p>` : ''}
      <p><code>${esc(err.code)}</code></p>
      <button onclick="location.reload()">Повторить</button>
    </div></body></html>`
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  }

  /**
   * Bounds конкретного сервиса. Пока view скрыт — запоминаем; при show применится.
   */
  setBounds(serviceId: string, bounds: Rectangle, borderRadius = WINDOW_CORNER_RADIUS): void {
    this.chrome.set(serviceId, { bounds, borderRadius })
    if (this.tabs.has(serviceId)) this.browserChrome = { bounds, borderRadius }
    const view = this.views.get(serviceId)
    if (view && this.visible.has(serviceId)) this.applyChrome(serviceId, view)
  }

  /**
   * Показать сервис. Другие видимые view не трогаем — фоновые окна остаются живыми.
   * addChildView поднимает этот view наверх среди нативных слоёв.
   */
  show(serviceId: string, url?: string): boolean {
    if (this.suppressed) return false
    const view = this.ensureAny(serviceId)
    if (!view) return false

    const wasHidden = !this.visible.has(serviceId)
    this.applyChrome(serviceId, view)
    view.setVisible(true)
    this.win.contentView.addChildView(view)
    this.visible.add(serviceId)

    // Вкладку браузера показ никуда не ведёт: её адрес задаёт только адресная
    // строка, а не окно, которое вкладку показывает.
    const service = this.tabs.has(serviceId)
      ? undefined
      : getConfig().services.find((s) => s.id === serviceId)
    const target = service ? safeServiceUrl(service, url) : null
    if (target && view.webContents.getURL() !== target) {
      void view.webContents.loadURL(target)
    }
    // Свежий кадр для следующего freeze — не стираем старый, пока новый не готов
    // (иначе при драге DOM-окна поверх будет пустой placeholder).
    if (wasHidden) this.scheduleSnapshot(serviceId)
    return true
  }

  /**
   * Спрятать один сервис или все (попапы / lock / поверх React-страница).
   * Возвращает id последнего спрятанного — для sync непрочитанного.
   */
  hide(serviceId?: string): string | null {
    if (serviceId) {
      const view = this.views.get(serviceId)
      if (!view || !this.visible.has(serviceId)) return null
      view.setVisible(false)
      this.visible.delete(serviceId)
      this.cancelSnapshot(serviceId)
      return serviceId
    }
    let last: string | null = null
    for (const id of [...this.visible]) {
      this.views.get(id)?.setVisible(false)
      this.cancelSnapshot(id)
      last = id
    }
    this.visible.clear()
    return last
  }

  /**
   * Заблокировать показ вебвью целиком (lock / заставка) и вернуть как было.
   * Пара вызовов идемпотентна: повторный suspend не затирает запомненный список.
   */
  setSuppressed(on: boolean): void {
    if (on === this.suppressed) return
    this.suppressed = on
    if (on) {
      this.suppressedVisible = [...this.visible]
      this.hide()
      return
    }
    const back = this.suppressedVisible
    this.suppressedVisible = []
    this.restore(back)
  }

  /** Снова показать все перечисленные (после попапа), в порядке снизу вверх. */
  restore(serviceIds: string[]): void {
    if (this.suppressed) return
    for (const id of serviceIds) {
      const view = this.views.get(id)
      if (!view) continue
      const wasHidden = !this.visible.has(id)
      this.applyChrome(id, view)
      view.setVisible(true)
      this.win.contentView.addChildView(view)
      this.visible.add(id)
      if (wasHidden) this.scheduleSnapshot(id)
    }
  }

  /** Снимок вкладки (data URL) — без hide. */
  async capture(serviceId: string): Promise<string | null> {
    const view = this.views.get(serviceId)
    if (!view || view.webContents.isDestroyed()) return null
    try {
      const img = await view.webContents.capturePage()
      if (img.isEmpty()) return null
      return img.toDataURL()
    } catch {
      return null
    }
  }

  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private cancelSnapshot(serviceId: string): void {
    const t = this.snapshotTimers.get(serviceId)
    if (t) clearTimeout(t)
    this.snapshotTimers.delete(serviceId)
  }

  /** Отложенный кадр, пока view живой — для мгновенного freeze без capturePage. */
  private scheduleSnapshot(serviceId: string): void {
    this.cancelSnapshot(serviceId)
    this.snapshotTimers.set(
      serviceId,
      setTimeout(() => {
        this.snapshotTimers.delete(serviceId)
        void this.captureIntoCache(serviceId)
      }, 300)
    )
  }

  private async captureIntoCache(serviceId: string): Promise<void> {
    if (!this.visible.has(serviceId)) return
    const view = this.views.get(serviceId)
    if (!view || view.webContents.isDestroyed()) return
    try {
      const img = await view.webContents.capturePage()
      if (!img.isEmpty() && this.visible.has(serviceId)) {
        this.snapshots.set(serviceId, img.toDataURL())
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Freeze: спрятать сразу, кадр из кэша.
   * Раньше ждали capturePage (~100–400ms) и только потом hide — DOM-окно
   * «тормозило» поверх вебвью. Теперь hide синхронный, снимок заранее.
   */
  async freeze(serviceId: string): Promise<string | null> {
    const view = this.views.get(serviceId)
    if (!view || view.webContents.isDestroyed()) {
      return this.snapshots.get(serviceId) ?? null
    }
    if (this.visible.has(serviceId)) {
      this.cancelSnapshot(serviceId)
      view.setVisible(false)
      this.visible.delete(serviceId)
    }
    return this.snapshots.get(serviceId) ?? null
  }

  reload(serviceId: string): void {
    const view = this.views.get(serviceId)
    if (!view) return
    if (this.tabs.has(serviceId)) {
      view.webContents.reload()
      return
    }
    const service = getConfig().services.find((s) => s.id === serviceId)
    if (service?.baseUrl) void view.webContents.loadURL(service.baseUrl)
  }

  goBack(serviceId: string): void {
    const wc = this.views.get(serviceId)?.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goHome(serviceId: string): void {
    const view = this.views.get(serviceId)
    if (!view) return
    if (this.tabs.has(serviceId)) {
      this.navigateTab(serviceId, getConfig().browser.homeUrl)
      return
    }
    const service = getConfig().services.find((s) => s.id === serviceId)
    if (service?.baseUrl) void view.webContents.loadURL(service.baseUrl)
  }

  getUrl(serviceId: string): string | null {
    const url = this.views.get(serviceId)?.webContents.getURL() ?? ''
    if (!url || url.startsWith('data:') || url.startsWith('about:')) return null
    return url
  }

  /** Заголовок открытой страницы — для закладки, добавленной прямо из вебвью. */
  getTitle(serviceId: string): string | null {
    const title = this.views.get(serviceId)?.webContents.getTitle()?.trim()
    return title || null
  }

  openDevTools(serviceId: string): void {
    this.views.get(serviceId)?.webContents.openDevTools({ mode: 'detach' })
  }

  async clearEnvSession(envId: string): Promise<void> {
    const env = getEnv(envId)
    if (!env) return
    await session.fromPartition(env.partition).clearStorageData()
    for (const [id, view] of this.views) {
      const svc = getConfig().services.find((s) => s.id === id)
      if (svc?.envId === envId) view.webContents.reload()
    }
  }

  /* ── Встроенный браузер ──────────────────────────────────────────── */

  /** Снимок для рендерера: вкладки по порядку + какая активна. */
  browserState(): BrowserState {
    const tabs = this.tabOrder.flatMap<BrowserTabState>((id) => {
      const tab = this.tabs.get(id)
      if (!tab) return []
      const wc = this.views.get(id)?.webContents
      const alive = wc != null && !wc.isDestroyed()
      return [
        {
          id: tab.id,
          envId: tab.envId,
          url: tab.url,
          title: tab.title || hostLabel(tab.url),
          favicon: tab.favicon,
          loading: tab.loading,
          canGoBack: alive ? wc.navigationHistory.canGoBack() : false,
          canGoForward: alive ? wc.navigationHistory.canGoForward() : false
        }
      ]
    })
    return { tabs, activeId: this.activeTab }
  }

  /**
   * Пнуть рендерер. События навигации приходят пачкой (did-navigate → title →
   * favicon → did-stop-loading), поэтому склеиваем их в один кадр: иначе на
   * каждый переход летит четыре перерисовки хрома.
   */
  private emitBrowser(): void {
    if (this.browserEmitTimer) return
    this.browserEmitTimer = setTimeout(() => {
      this.browserEmitTimer = null
      this.onBrowserChange?.(this.browserState())
    }, 30)
  }

  /**
   * Новая вкладка. `afterId` — вставить сразу за этой (так ведут себя ссылки,
   * открытые со страницы). Контур задаёт партицию и туннель, и сменить его у
   * готовой вкладки нельзя: для другого контура открывается своя вкладка.
   */
  newTab(
    opts: { envId?: string; url?: string; activate?: boolean; afterId?: string } = {}
  ): BrowserTabState | null {
    const cfg = getConfig()
    const env = getEnv(opts.envId ?? cfg.browser.defaultEnvId) ?? cfg.envs.find((e) => e.enabled)
    if (!env) return null

    const url = (opts.url ?? cfg.browser.homeUrl).trim() || 'about:blank'
    this.tabSeq += 1
    const tab: Tab = {
      id: `tab:${env.id}:${this.tabSeq}`,
      envId: env.id,
      url,
      title: hostLabel(url),
      favicon: null,
      loading: true
    }
    this.tabs.set(tab.id, tab)
    const at = opts.afterId ? this.tabOrder.indexOf(opts.afterId) : -1
    if (at >= 0) this.tabOrder.splice(at + 1, 0, tab.id)
    else this.tabOrder.push(tab.id)

    const view = this.createTabView(tab)
    if (!view) {
      this.tabs.delete(tab.id)
      this.tabOrder = this.tabOrder.filter((x) => x !== tab.id)
      return null
    }
    void view.webContents.loadURL(url)

    if (opts.activate === false) this.emitBrowser()
    else this.activateTab(tab.id)

    return this.browserState().tabs.find((t) => t.id === tab.id) ?? null
  }

  /**
   * Переключить активную вкладку: предыдущая прячется, новая встаёт на её
   * место и показывается, только если показывалась предыдущая (окно браузера
   * может быть и перекрыто, и свёрнуто — тогда ничего показывать не нужно).
   */
  activateTab(id: string): void {
    if (!this.tabs.has(id) || this.activeTab === id) return
    const prev = this.activeTab
    const wasVisible = prev != null && this.visible.has(prev)
    if (prev) this.hide(prev)
    this.activeTab = id
    if (wasVisible) this.show(id)
    this.emitBrowser()
  }

  /** Закрыть вкладку. Активной становится соседняя справа, иначе слева. */
  closeTab(id: string): void {
    if (!this.tabs.has(id)) return
    const idx = this.tabOrder.indexOf(id)
    this.dispose(id)
    this.tabs.delete(id)
    this.tabOrder = this.tabOrder.filter((x) => x !== id)
    if (this.activeTab === id) {
      this.activeTab = null
      const next = this.tabOrder[Math.min(Math.max(idx, 0), this.tabOrder.length - 1)]
      if (next) this.activateTab(next)
    }
    this.emitBrowser()
  }

  /** Переставить вкладку (drag по полосе вкладок). */
  moveTab(id: string, toIndex: number): void {
    const from = this.tabOrder.indexOf(id)
    if (from < 0) return
    const to = Math.min(Math.max(toIndex, 0), this.tabOrder.length - 1)
    if (from === to) return
    this.tabOrder.splice(from, 1)
    this.tabOrder.splice(to, 0, id)
    this.emitBrowser()
  }

  /** Перейти по тому, что набрали в адресной строке (или по готовой ссылке). */
  navigateTab(id: string, input: string): void {
    const tab = this.tabs.get(id)
    const view = this.views.get(id)
    if (!tab || !view) return
    const target = resolveBrowserInput(input, getConfig().browser.searchUrl)
    tab.url = target
    tab.loading = true
    tab.favicon = null
    this.emitBrowser()
    void view.webContents.loadURL(target)
  }

  tabForward(id: string): void {
    const wc = this.views.get(id)?.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  tabStop(id: string): void {
    this.views.get(id)?.webContents.stop()
  }

  /** Заголовок и адрес активной вкладки — для закладки из браузера. */
  tabInfo(id: string): { url: string; title: string } | null {
    const tab = this.tabs.get(id)
    if (!tab) return null
    return { url: tab.url, title: tab.title || hostLabel(tab.url) }
  }

  private createTabView(tab: Tab): WebContentsView | null {
    const env = getEnv(tab.envId)
    if (!env) return null
    this.prepareSession(env)

    const view = new WebContentsView({
      webPreferences: {
        partition: env.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true
      }
    })
    const wc = view.webContents

    // Своих окон у вебвью быть не должно: target=_blank и window.open
    // становятся новой вкладкой рядом с этой — как в любом браузере.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//i.test(url)) {
        this.newTab({
          envId: tab.envId,
          url,
          afterId: tab.id,
          activate: disposition !== 'background-tab'
        })
      } else {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    /**
     * Горячие клавиши браузера, пока фокус внутри страницы: рендерер своих
     * keydown там не видит. Действие откладываем на следующий тик — закрывать
     * вкладку изнутри её же обработчика нельзя.
     */
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt) return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (!mod) return
      const act = (fn: () => void): void => {
        event.preventDefault()
        setTimeout(fn, 0)
      }
      switch (input.key.toLowerCase()) {
        case 't':
          act(() => this.newTab({ envId: tab.envId, afterId: tab.id }))
          break
        case 'w':
          act(() => this.closeTab(tab.id))
          break
        case 'r':
          act(() => this.reload(tab.id))
          break
        case '[':
          act(() => this.goBack(tab.id))
          break
        case ']':
          act(() => this.tabForward(tab.id))
          break
      }
    })

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title.trim()
      this.emitBrowser()
    })
    wc.on('page-favicon-updated', (_e, icons) => {
      void this.loadTabFavicon(tab, icons[0])
    })
    wc.on('did-start-loading', () => {
      tab.loading = true
      this.emitBrowser()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.readTabUrl(tab, wc)
      this.emitBrowser()
    })
    wc.on('did-navigate', () => {
      // Другой сайт — прежняя иконка больше не его.
      tab.favicon = null
      this.readTabUrl(tab, wc)
      this.emitBrowser()
    })
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (!isMainFrame) return
      this.readTabUrl(tab, wc)
      this.emitBrowser()
    })
    wc.on('certificate-error', (event, _url, error, _cert, callback) => {
      if (env.caCertPath || env.allowInsecureTls) {
        event.preventDefault()
        callback(true)
      } else {
        callback(false)
        this.showErrorPage(view, `${hostLabel(tab.url)} не открылся`, {
          code: 'CERT',
          desc: `Сертификат сайта не доверенный (${error}). Включите «Доверять сертификатам контура» в настройках контура «${env.name}».`
        })
      }
    })
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      this.showErrorPage(view, `${hostLabel(validatedURL || tab.url)} не открылся`, {
        code: String(errorCode),
        desc: errorDescription,
        url: validatedURL
      })
    })
    wc.on('render-process-gone', (_e, details) => {
      this.showErrorPage(view, `${hostLabel(tab.url)} не открылся`, {
        code: 'CRASH',
        desc: `Процесс вкладки завершился: ${details.reason}`
      })
    })

    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.views.set(tab.id, view)
    return view
  }

  /** Адрес из вебвью. Страницу ошибки (`data:`) в адресную строку не пускаем. */
  private readTabUrl(tab: Tab, wc: WebContents): void {
    const url = wc.getURL()
    if (!url || url.startsWith('data:')) return
    tab.url = url
  }

  /**
   * Иконка вкладки. Забираем её сессией самой вкладки: у контура свой прокси и
   * свои сертификаты, а рендерер по внутреннему адресу вообще не достучится.
   * Отдаём рендереру data URL — у него нет доступа к партиции контура.
   */
  private async loadTabFavicon(tab: Tab, iconUrl: string | undefined): Promise<void> {
    if (!iconUrl) return
    const env = getEnv(tab.envId)
    if (!env) return
    try {
      const res = await session.fromPartition(env.partition).fetch(iconUrl)
      if (!res.ok) return
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
      if (/text\/html/i.test(mime)) return
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > FAVICON_MAX_BYTES) return
      // Вкладку могли закрыть, пока иконка летела.
      if (!this.tabs.has(tab.id)) return
      tab.favicon = `data:${mime};base64,${buf.toString('base64')}`
      this.emitBrowser()
    } catch {
      /* иконка не обязательна */
    }
  }

  dispose(serviceId: string): void {
    const view = this.views.get(serviceId)
    if (!view) return
    this.visible.delete(serviceId)
    this.chrome.delete(serviceId)
    this.snapshots.delete(serviceId)
    this.views.delete(serviceId)
    // Вкладку закрыли — следующая откроется с чистого листа, и автологин
    // снова сможет сработать (например, после истечения сессии).
    this.typedIn.delete(serviceId)
    this.autoSubmitted.delete(serviceId)

    try {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    } catch {
      /* already detached */
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      /* already closed */
    }
  }

  disposeAll(): void {
    for (const id of [...this.views.keys()]) this.dispose(id)
    this.tabs.clear()
    this.tabOrder = []
    this.activeTab = null
    this.browserChrome = null
  }
}

function isKtalkHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'ktalk.ru' || h.endsWith('.ktalk.ru')
}

function safeServiceUrl(service: ServiceConfig, url?: string): string | null {
  if (!url || !service.baseUrl) return null
  try {
    const target = new URL(url)
    const base = new URL(service.baseUrl)
    if (target.origin === base.origin) return target.toString()
    // Встречи Толк часто на company.ktalk.ru при baseUrl = app.ktalk.ru.
    if (service.kind === 'ktalk' && isKtalkHost(target.hostname)) return target.toString()
    return null
  } catch {
    return null
  }
}
