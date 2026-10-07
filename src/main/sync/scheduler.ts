import { EventEmitter } from 'node:events'
import type { Item, ServiceConfig } from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import {
  bumpOutbox,
  dropOutbox,
  getCursor,
  outboxFor,
  pruneItems,
  setCursor,
  settleUnread,
  upsertItems
} from '../db'
import { health } from '../net/health'
import { connectorFor } from '../connectors/registry'
import { grabSessionToken, prefersSessionCookie } from '../connectors/sessionToken'
import type { SyncContext, SyncResult } from '../connectors/types'
import { logInfo, logError } from '../log'

// Живые упоминания — по WS; полный опрос чаще, чтобы счётчики после прочтения не висели.
const POLL_INTERVAL_MS = 90_000

/**
 * Планировщик синхронизации.
 *
 * Два правила, из которых следует всё остальное: коннектор не вызывается,
 * пока контур лежит, и живая подписка поднимается ровно тогда, когда
 * туннель доступен. Это избавляет от шторма ретраев при обрыве VPN —
 * главной болячки наивных агрегаторов.
 */
class Scheduler extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null
  private healthDebounce: ReturnType<typeof setTimeout> | null = null
  private realtime = new Map<string, () => void>()
  private running = false
  private pendingServiceSync = new Set<string>()
  // Первый проход только наполняет базу — уведомлять о «новом» на нём нельзя,
  // иначе при старте посыпятся десятки уведомлений о давно существующем.
  private seeded = false

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
    // Туннель up/down — пересобрать подписки; debounce, чтобы флап VPN не гонял полный tick.
    health.on('change', () => {
      if (this.healthDebounce) clearTimeout(this.healthDebounce)
      this.healthDebounce = setTimeout(() => {
        this.healthDebounce = null
        void this.tick()
      }, 400)
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.healthDebounce) clearTimeout(this.healthDebounce)
    this.healthDebounce = null
    for (const stop of this.realtime.values()) stop()
    this.realtime.clear()
  }

  private contextFor(service: ServiceConfig, secret?: string | null): SyncContext | null {
    const env = getConfig().envs.find((e) => e.id === service.envId)
    if (!env) return null
    return {
      env,
      service,
      secret: secret ?? getSecret(`${service.id}.secret`),
      cursor: getCursor(service.id).cursor
    }
  }

  /**
   * Для cookie-auth (Mattermost во вкладке и т.п.) токен в keychain быстро
   * протухает — перед API подтягиваем свежий MMAUTHTOKEN из партиции.
   */
  private async resolveSecret(service: ServiceConfig): Promise<string | null> {
    if (prefersSessionCookie(service)) {
      const fresh = await grabSessionToken(service.id)
      if (fresh) return fresh
    }
    return getSecret(`${service.id}.secret`)
  }

  /** Сервисы, которые вообще умеют ходить по API и сейчас доступны. */
  private activeServices(): ServiceConfig[] {
    const cfg = getConfig()
    return cfg.services.filter((s) => {
      if (!s.enabled || !s.baseUrl) return false
      // Чистый embed без cookie-сессии API не трогаем; cookie = вкладка кормит sync/WS.
      if (s.mode === 'embed' && !prefersSessionCookie(s)) return false
      if (!connectorFor(s.kind)) return false
      const env = cfg.envs.find((e) => e.id === s.envId)
      if (!env?.enabled) return false
      // Блокируем только контур, явно признанный упавшим. «unknown» (адрес
      // проверки не задан) синхронизацию не запрещает — просто пробуем, а сбой
      // ловится per-service. Иначе без healthCheckUrl ничего бы не читалось.
      return health.tunnelOf(s.envId) !== 'down'
    })
  }

  private attachRealtime(service: ServiceConfig, ctx: SyncContext): void {
    const connector = connectorFor(service.kind)
    if (!connector?.startRealtime || this.realtime.has(service.id)) return
    void connector
      .startRealtime(ctx, (items) => {
        const fresh = upsertItems(items)
        if (fresh.length && this.seeded) this.emit('new-items', fresh)
        this.emit('items')
      })
      .then((stop) => {
        this.realtime.set(service.id, stop)
      })
      .catch((err) => {
        this.emit('error', { serviceId: service.id, error: errText(err) })
      })
  }

  /**
   * Записать выдачу коннектора: upsert, «осевшие» непрочитанные, чистка
   * пропавшего и курсор. Один метод на все три места, где раньше это было
   * скопировано (быстрый синк, общий проход и его повтор после релогина).
   */
  private applySync(service: ServiceConfig, result: SyncResult, freshAll: Item[]): boolean {
    const { items, cursor, prune } = result
    let changed = false

    if (items.length) {
      const fresh = upsertItems(items)
      if (fresh.length) freshAll.push(...fresh)
      changed = true
    }
    // Сообщения/страницы, которых больше нет в выдаче — считаем прочитанными.
    if (service.kind === 'mattermost' || service.kind === 'confluence') {
      const kind = service.kind === 'mattermost' ? 'message' : 'page'
      if (settleUnread(service.id, kind, items.map((i) => i.id)) > 0) changed = true
    }
    // Исчезнувшее с сервера убираем из локальной копии — но только там, где
    // коннектор поручился за полноту выдачи (см. PruneWindow).
    for (const w of prune ?? []) {
      const keep = items.filter((i) => i.kind === w.kind).map((i) => i.id)
      const removed = pruneItems(service.id, w.kind, w.from, w.to, keep)
      if (removed > 0) {
        changed = true
        logInfo('sync', `${service.id}: убрано исчезнувших (${w.kind}): ${removed}`)
      }
    }

    if (cursor) setCursor(service.id, cursor)
    health.setSynced(service.envId)
    return changed
  }

  private dropRealtime(serviceId: string): void {
    const stop = this.realtime.get(serviceId)
    if (!stop) return
    stop()
    this.realtime.delete(serviceId)
  }

  /** Быстрый синк одного сервиса — после выхода из вкладки или ручного обновления. */
  async syncService(serviceId: string): Promise<void> {
    const service = this.activeServices().find((s) => s.id === serviceId)
    if (!service) return
    // Полный tick уже идёт — не лезем параллельно в те же коннекторы.
    if (this.running) {
      // Отложим до конца текущего прохода.
      this.pendingServiceSync.add(serviceId)
      return
    }
    this.running = true
    try {
      const changed = await this.syncOne(service)
      if (changed) this.emit('items')
    } finally {
      this.running = false
      const pending = [...this.pendingServiceSync]
      this.pendingServiceSync.clear()
      for (const id of pending) {
        if (id !== serviceId) void this.syncService(id)
      }
    }
  }

  private async syncOne(service: ServiceConfig): Promise<boolean> {
    const secret = await this.resolveSecret(service)
    let ctx = this.contextFor(service, secret)
    if (!ctx?.secret) return false
    const connector = connectorFor(service.kind)!
    let changed = false
    const freshAll: import('@shared/types').Item[] = []

    const applyResult = (result: SyncResult): void => {
      if (this.applySync(service, result, freshAll)) changed = true
    }

    try {
      const result = await connector.sync(ctx)
      applyResult(result)
      logInfo('sync', `${service.id}: получено ${result.items.length}`)
    } catch (err) {
      if (isAuthError(err) && prefersSessionCookie(service)) {
        const refreshed = await grabSessionToken(service.id)
        if (refreshed && refreshed !== ctx.secret) {
          this.dropRealtime(service.id)
          ctx = this.contextFor(service, refreshed)!
          try {
            const result = await connector.sync(ctx)
            applyResult(result)
            logInfo('sync', `${service.id}: получено ${result.items.length} (после обновления сессии)`)
          } catch (retryErr) {
            logError('sync', `${service.id}: ${errText(retryErr)}`)
            this.emit('error', { serviceId: service.id, error: errText(retryErr) })
            return changed
          }
        } else {
          logError('sync', `${service.id}: ${errText(err)}`)
          this.emit('error', { serviceId: service.id, error: errText(err) })
          return changed
        }
      } else {
        logError('sync', `${service.id}: ${errText(err)}`)
        this.emit('error', { serviceId: service.id, error: errText(err) })
        return changed
      }
    }

    this.attachRealtime(service, ctx)
    if (await this.flushOutbox(service)) changed = true
    if (freshAll.length && this.seeded) this.emit('new-items', freshAll)
    return changed
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const active = this.activeServices()
      const activeIds = new Set(active.map((s) => s.id))

      // Контур лёг или сервис выключили — подписку снимаем.
      for (const [id, stop] of this.realtime) {
        if (!activeIds.has(id)) {
          stop()
          this.realtime.delete(id)
        }
      }

      let changed = false
      const freshAll: import('@shared/types').Item[] = []
      for (const service of active) {
        // syncOne эмитит new-items сам — соберём через временный флаг иначе дубли.
        // Проще: инлайн как раньше, но с settleUnread.
        const secret = await this.resolveSecret(service)
        let ctx = this.contextFor(service, secret)
        if (!ctx?.secret) continue
        const connector = connectorFor(service.kind)!

        try {
          const result = await connector.sync(ctx)
          if (this.applySync(service, result, freshAll)) changed = true
          logInfo('sync', `${service.id}: получено ${result.items.length}`)
        } catch (err) {
          if (isAuthError(err) && prefersSessionCookie(service)) {
            const refreshed = await grabSessionToken(service.id)
            if (refreshed && refreshed !== ctx.secret) {
              this.dropRealtime(service.id)
              ctx = this.contextFor(service, refreshed)!
              try {
                const result = await connector.sync(ctx)
                if (this.applySync(service, result, freshAll)) changed = true
                logInfo(
                  'sync',
                  `${service.id}: получено ${result.items.length} (после обновления сессии)`
                )
              } catch (retryErr) {
                logError('sync', `${service.id}: ${errText(retryErr)}`)
                this.emit('error', { serviceId: service.id, error: errText(retryErr) })
              }
            } else {
              logError('sync', `${service.id}: ${errText(err)}`)
              this.emit('error', { serviceId: service.id, error: errText(err) })
            }
          } else {
            logError('sync', `${service.id}: ${errText(err)}`)
            this.emit('error', { serviceId: service.id, error: errText(err) })
          }
        }

        this.attachRealtime(service, ctx)

        if (await this.flushOutbox(service)) changed = true
      }

      if (freshAll.length && this.seeded) this.emit('new-items', freshAll)
      this.seeded = true
      if (changed) this.emit('items')
    } finally {
      this.running = false
      const pending = [...this.pendingServiceSync]
      this.pendingServiceSync.clear()
      for (const id of pending) void this.syncService(id)
    }
  }

  /** Отложенные действия уходят, как только их контур снова доступен. */
  private async flushOutbox(service: ServiceConfig): Promise<boolean> {
    const pending = outboxFor(service.envId).filter((e) => e.serviceId === service.id)
    if (!pending.length) return false
    const connector = connectorFor(service.kind)
    const ctx = this.contextFor(service)
    if (!connector?.perform || !ctx) return false

    let sent = false
    for (const entry of pending) {
      try {
        await connector.perform(ctx, entry.action, entry.payload)
        dropOutbox(entry.id)
        sent = true
      } catch (err) {
        bumpOutbox(entry.id, errText(err))
      }
    }
    return sent
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const isAuthError = (err: unknown): boolean => {
  const msg = errText(err)
  return /\b401\b/.test(msg) || /токен отклон/i.test(msg) || /unauthorized/i.test(msg)
}

export const scheduler = new Scheduler()
