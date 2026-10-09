import { EventEmitter } from 'node:events'
import { session } from 'electron'
import type { EnvStatus, TunnelState, VpnState } from '@shared/types'
import { getConfig } from '../config/store'
import { outboxCount } from '../db'
import { logInfo, logWarn } from '../log'
import { resetDispatcher } from './transport'
import { maybeAutoApplySplitDns, resetSplitDnsAutoFlag } from './dns'

const PROBE_INTERVAL_MS = 20_000
const PROBE_TIMEOUT_MS = 8_000
/** Сколько подряд неудач нужно, чтобы снять «up» — иначе единичный флап роняет статус. */
const DOWN_STREAK = 2

/**
 * Состояние туннеля. Проверка идёт через Chromium `net.fetch` (тот же стек,
 * что у вебвью) — undici часто таймаутит при живом VPN, а вкладка при этом
 * открывается нормально.
 */
class HealthMonitor extends EventEmitter {
  private statuses = new Map<string, EnvStatus>()
  private timer: NodeJS.Timeout | null = null
  private inflight = new Map<string, Promise<TunnelState>>()
  private failStreak = new Map<string, number>()

  start(): void {
    if (this.timer) return
    void this.probeAll()
    this.timer = setInterval(() => void this.probeAll(), PROBE_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  all(): EnvStatus[] {
    return getConfig().envs.map((env) => this.statuses.get(env.id) ?? this.blank(env.id))
  }

  private blank(envId: string): EnvStatus {
    return { envId, tunnel: 'unknown', vpn: 'unmanaged', lastSyncAt: null, lastError: null, pendingOutbox: 0 }
  }

  private set(envId: string, patch: Partial<EnvStatus>): void {
    const next: EnvStatus = { ...(this.statuses.get(envId) ?? this.blank(envId)), ...patch }
    next.pendingOutbox = outboxCount(envId)
    const prev = this.statuses.get(envId)
    this.statuses.set(envId, next)
    if (
      !prev ||
      prev.tunnel !== next.tunnel ||
      prev.vpn !== next.vpn ||
      prev.pendingOutbox !== next.pendingOutbox ||
      prev.lastError !== next.lastError
    ) {
      this.emit('change', next)
    }
  }

  setVpn(envId: string, vpn: VpnState): void {
    this.set(envId, { vpn })
  }

  setSynced(envId: string, at = Date.now()): void {
    this.set(envId, { lastSyncAt: at })
  }

  tunnelOf(envId: string): TunnelState {
    return this.statuses.get(envId)?.tunnel ?? 'unknown'
  }

  /**
   * Сбросить статус соседей. По умолчанию — только другие `checkpoint`:
   * официальный CP держит один сайт. CP+snx-rs / CP+OpenVPN соседа не роняют.
   */
  invalidateSiblings(
    exceptEnvId: string,
    opts: { onlyKinds?: Array<import('@shared/types').VpnKind> } = { onlyKinds: ['checkpoint'] }
  ): void {
    const filter = opts.onlyKinds
    for (const env of getConfig().envs.filter((e) => e.enabled && e.id !== exceptEnvId)) {
      if (env.vpn.kind === 'none') continue
      if (filter && !filter.includes(env.vpn.kind)) continue
      this.failStreak.set(env.id, 0)
      this.set(env.id, {
        tunnel: 'checking',
        vpn: 'disconnected',
        lastError: 'Перепроверяем после смены VPN'
      })
      resetDispatcher(env.id)
    }
  }

  /**
   * Фоновая проверка параллельно по контурам — иначе 2×timeout подряд
   * раздувает цикл до десятков секунд. UI «checking» тут не трогаем.
   */
  async probeAll(): Promise<void> {
    const envs = getConfig().envs.filter((e) => e.enabled && e.healthCheckUrl)
    await Promise.all(envs.map((env) => this.probe(env.id, { interactive: false })))
  }

  /**
   * @param interactive — ручная кнопка «Проверить»: только этот envId, UI → checking.
   *   Фоновый тик interactive=false: не трогает UI, пока нет смены up/down.
   */
  async probe(envId: string, opts: { interactive?: boolean } = {}): Promise<TunnelState> {
    const interactive = opts.interactive === true
    const existing = this.inflight.get(envId)
    if (existing) return existing

    const run = this.probeOnce(envId, interactive).finally(() => {
      if (this.inflight.get(envId) === run) this.inflight.delete(envId)
    })
    this.inflight.set(envId, run)
    return run
  }

  private async probeOnce(envId: string, interactive: boolean): Promise<TunnelState> {
    const env = getConfig().envs.find((e) => e.id === envId)
    if (!env?.healthCheckUrl) {
      this.set(envId, { tunnel: 'unknown', lastError: null })
      return 'unknown'
    }

    const prev = this.statuses.get(envId)?.tunnel
    // Checking только у того контура, который пользователь явно проверяет.
    if (interactive) {
      this.set(envId, { tunnel: 'checking', lastError: null })
    }

    const url = env.healthCheckUrl
    try {
      await this.hit(env, url)
      this.failStreak.set(envId, 0)
      this.markUp(envId)
      return 'up'
    } catch {
      try {
        await this.hit(env, url)
        this.failStreak.set(envId, 0)
        this.markUp(envId)
        return 'up'
      } catch (err2) {
        const detail = explainProbeError(err2)
        const streak = (this.failStreak.get(envId) ?? 0) + 1
        this.failStreak.set(envId, streak)
        logWarn('health', `${envId}: ${url} — ${detail} (${streak}/${DOWN_STREAK})`)
        // Уже был up — один фоновый сбой не роняет статус.
        if (!interactive && prev === 'up' && streak < DOWN_STREAK) {
          return 'up'
        }
        this.markDown(envId, detail)
        return 'down'
      }
    }
  }

  private markUp(envId: string): void {
    const prev = this.statuses.get(envId)
    this.set(envId, { tunnel: 'up', lastError: null, vpn: 'connected' })
    if (prev?.tunnel !== 'up') {
      const name = getConfig().envs.find((e) => e.id === envId)?.name ?? envId
      logInfo('health', `${envId}: контур «${name}» доступен`)
      // Ручной VPN / внешний клиент — Kontur connect не вызывался, split-DNS
      // всё равно закрепляем (один раз за цикл up, чтобы не спамить sudo).
      maybeAutoApplySplitDns(envId)
    }
  }

  private markDown(envId: string, detail: string): void {
    const prev = this.statuses.get(envId)
    const env = getConfig().envs.find((e) => e.id === envId)
    const vpn: VpnState =
      env?.vpn.kind === 'none' ? 'unmanaged' : prev?.vpn === 'connecting' ? 'connecting' : 'disconnected'
    this.set(envId, { tunnel: 'down', lastError: detail, vpn })
    if (prev?.tunnel === 'up') resetSplitDnsAutoFlag(envId)
  }

  /**
   * Chromium network через session партиции — как у вкладки сервиса
   * (allowInsecureTls / proxy уже навешаны на эту session).
   */
  private async hit(env: NonNullable<ReturnType<typeof getConfig>['envs'][number]>, url: string): Promise<void> {
    const ses = session.fromPartition(env.partition)
    // Как у WebContentsView: иначе проба падает на TLS, а вкладка (уже с proc) — нет.
    if (env.allowInsecureTls) {
      ses.setCertificateVerifyProc((_request, callback) => callback(0))
    } else {
      ses.setCertificateVerifyProc(null)
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await ses.fetch(url, {
        method: 'GET',
        signal: ac.signal,
        bypassCustomProtocolHandlers: true,
        headers: { 'user-agent': 'Kontur-health/1.0', accept: '*/*' }
      })
      // Тело не нужно — любой HTTP-ответ = сеть жива (в т.ч. 401/403).
      try {
        void res.body?.cancel()
      } catch {
        /* ignore */
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

function explainProbeError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const msg = err instanceof Error ? err.message : String(err)
  if (name === 'AbortError' || /aborted|timeout/i.test(msg))
    return 'Таймаут до адреса проверки — маршрут через VPN не доходит.'
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(msg))
    return 'DNS не резолвит адрес проверки. VPN/split-DNS ещё не готов.'
  if (/CERT_|UNABLE_TO_VERIFY|ERR_CERT|SELF_SIGNED/i.test(msg))
    return `TLS: ${msg.slice(0, 120)}. Включите «Доверять сертификатам контура».`
  if (/ERR_CONNECTION|ECONNREFUSED|ENETUNREACH/i.test(msg))
    return 'Нет маршрута до адреса проверки — туннель, похоже, не поднят.'
  return msg.slice(0, 160)
}

export const health = new HealthMonitor()
