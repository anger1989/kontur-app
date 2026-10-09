import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppConfig, EnvConfig, ServiceConfig } from '@shared/types'
import {
  CONFIG_VERSION,
  DEFAULT_ENVS,
  DEFAULT_LOGIN_SELECTORS,
  LEGACY_LOGIN_SELECTORS,
  SHARED_ENV_ID,
  SHARED_KINDS,
  defaultBaseUrl,
  defaultBrowser,
  defaultConfig,
  defaultProfile,
  defaultServicesFor,
  isForeignVcs,
  normalizeVpn
} from '@shared/defaults'
import { WIDGET_IDS } from '@shared/types'
import { configFile, defaultVaultPath } from './paths'
import { moveSecret } from './secrets'
import { logError } from '../log'

let cache: AppConfig | null = null

function mergeEnv(saved: EnvConfig | undefined, base: EnvConfig): EnvConfig {
  if (!saved) return { ...base, vpn: normalizeVpn(base.vpn) }
  return {
    ...base,
    ...saved,
    splitDns: saved.splitDns ?? base.splitDns,
    dnsDomains: saved.dnsDomains ?? base.dnsDomains ?? [],
    dnsServers: saved.dnsServers ?? base.dnsServers ?? [],
    vpn: normalizeVpn({ ...base.vpn, ...saved.vpn })
  }
}

/** Собрать общие сервисы: Mattermost/Толк/А-Чат из старых контуров → shared. */
function migrateSharedServices(
  savedServices: ServiceConfig[],
  removed: Set<string>
): ServiceConfig[] {
  const defaults = defaultServicesFor(SHARED_ENV_ID)
  const out: ServiceConfig[] = []

  for (const def of defaults) {
    if (removed.has(def.id)) continue
    const candidates = savedServices.filter((s) => s.kind === def.kind)
    const best = [...candidates].sort((a, b) => {
      const score = (s: ServiceConfig): number =>
        (s.enabled ? 4 : 0) + (s.baseUrl?.trim() ? 2 : 0) + (s.envId === SHARED_ENV_ID ? 1 : 0)
      return score(b) - score(a)
    })[0]

    if (best) {
      const next: ServiceConfig = {
        ...def,
        ...best,
        id: def.id,
        envId: SHARED_ENV_ID,
        options: { ...def.options, ...best.options }
      }
      if (!next.baseUrl?.trim() && def.baseUrl) next.baseUrl = def.baseUrl
      if (best.id !== def.id) {
        moveSecret(`${best.id}.secret`, `${def.id}.secret`, `${next.name}`)
      }
      out.push(next)
    } else {
      out.push(def)
    }
  }
  return out
}

function normalizeService(s: ServiceConfig): ServiceConfig {
  // Селекторы входа, оставшиеся с прежних дефолтов, подменяем на новые: старые
  // не попадали в форму Jira/Confluence (`os_username`). Если человек правил
  // их руками — значение не совпадёт со старым дефолтом и останется как есть.
  for (const key of ['userSelector', 'passSelector', 'submitSelector'] as const) {
    if (s.autoLogin?.[key] === LEGACY_LOGIN_SELECTORS[key]) {
      s.autoLogin = { ...s.autoLogin, [key]: DEFAULT_LOGIN_SELECTORS[key] }
    }
  }
  if (!s.baseUrl?.trim()) {
    const fallback = defaultBaseUrl(s.envId, s.kind)
    if (fallback) s.baseUrl = fallback
  }
  if (s.kind === 'achat') {
    if (!s.baseUrl?.trim()) s.baseUrl = 'https://achat.best'
    const raw = s.options.appPath?.trim() ?? ''
    if (!raw || /^\/Application\/А-?[Чч]ат\.app$/i.test(raw) || /^\/Applications\/А-чат\.app$/i.test(raw)) {
      s.options = { ...s.options, appPath: '/Applications/А-Чат.app' }
    }
    if (!s.options.ctsUrl?.trim()) {
      s.options = { ...s.options, ctsUrl: 'cts1.achat.best' }
    }
  }
  if (s.kind === 'ktalk') {
    if (!s.baseUrl?.trim()) s.baseUrl = 'https://app.ktalk.ru'
    if (!s.options.appPath?.trim()) {
      s.options = { ...s.options, appPath: '/Applications/Толк.app' }
    }
  }
  return s
}

/**
 * Склейка сохранённого конфига с дефолтами: новые поля и новые сервисы
 * появляются у существующих установок без ручной миграции.
 */
function merge(saved: Partial<AppConfig>): AppConfig {
  const base = defaultConfig()
  const removed = new Set(saved.removedServiceIds ?? [])
  const savedServices = saved.services ?? []

  // Контуры из сейва + недостающие дефолтные (в т.ч. shared).
  const byId = new Map<string, EnvConfig>()
  for (const e of saved.envs?.length ? saved.envs : base.envs) {
    const b = base.envs.find((x) => x.id === e.id) ?? DEFAULT_ENVS.find((x) => x.id === e.id)
    byId.set(e.id, mergeEnv(e, b ?? e))
  }
  for (const b of base.envs) {
    if (!byId.has(b.id)) byId.set(b.id, { ...b })
  }
  // Порядок: bank, ecom, остальные, shared в конце.
  const envs = [...byId.values()].sort((a, b) => {
    const rank = (id: string): number =>
      id === 'bank' ? 0 : id === 'ecom' ? 1 : id === SHARED_ENV_ID ? 100 : 50
    return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name, 'ru')
  })

  const sharedServices = migrateSharedServices(savedServices, removed).map(normalizeService)

  const contourServices = envs
    .filter((e) => e.id !== SHARED_ENV_ID)
    .flatMap((env) => {
      const defaults = defaultServicesFor(env.id).filter((d) => !removed.has(d.id))
      // Старые mattermost/achat/ktalk из контура больше не живут здесь.
      // GitLab — только ecom, Bitbucket — только bank.
      const existing = savedServices.filter(
        (s) =>
          s.envId === env.id &&
          !SHARED_KINDS.has(s.kind) &&
          !isForeignVcs(env.id, s.kind)
      )
      const merged = defaults.map((d) => {
        const prev = existing.find((s) => s.id === d.id)
        if (!prev) return d
        const next = { ...d, ...prev, options: { ...d.options, ...prev.options } }
        if (!next.baseUrl?.trim() && d.baseUrl) next.baseUrl = d.baseUrl
        return normalizeService(next)
      })
      const custom = existing
        .filter((s) => !merged.some((m) => m.id === s.id) && !isForeignVcs(env.id, s.kind))
        .map((s) => normalizeService({ ...s }))
      const all = [...merged, ...custom]
      return all
        .map((s, i) => {
          const prev = existing.find((x) => x.id === s.id)
          const fallback = prev ? existing.indexOf(prev) : 1000 + i
          return { ...s, order: prev?.order ?? s.order ?? fallback }
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
    })

  // Кастомные приложения, уже лежавшие в shared.
  const sharedCustom = savedServices
    .filter(
      (s) =>
        s.envId === SHARED_ENV_ID &&
        !SHARED_KINDS.has(s.kind) &&
        !sharedServices.some((m) => m.id === s.id)
    )
    .map((s) => normalizeService({ ...s }))

  const sharedAll = [...sharedServices, ...sharedCustom]
    .map((s, i) => ({ ...s, order: s.order ?? i }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))

  return {
    version: CONFIG_VERSION,
    theme: saved.theme ?? base.theme,
    wallpaper:
      !saved.wallpaper ||
      (saved.wallpaper.kind === 'gradient' && saved.wallpaper.value === 'graphite') ||
      (saved.wallpaper.kind === 'image' &&
        (saved.wallpaper.value === 'penguin' ||
          saved.wallpaper.value === 'aurora' ||
          saved.wallpaper.value === 'dusk' ||
          saved.wallpaper.value === 'orbit' ||
          saved.wallpaper.value === 'meadow' ||
          saved.wallpaper.value === 'oak' ||
          saved.wallpaper.value === 'neon' ||
          saved.wallpaper.value === 'ridges' ||
          saved.wallpaper.value === 'fibers'))
        ? base.wallpaper
        : saved.wallpaper,
    vaultPath: saved.vaultPath ?? defaultVaultPath(),
    unifyMail: saved.unifyMail ?? base.unifyMail,
    unifyCalendar: saved.unifyCalendar ?? base.unifyCalendar,
    notifications: saved.notifications ?? base.notifications,
    linkOpen: saved.linkOpen === 'system' ? 'system' : base.linkOpen,
    // Новый виджет у существующей установки должен появиться видимым, а не
    // пропасть из-за того, что в сохранённой раскладке его нет.
    widgets: Object.fromEntries(
      WIDGET_IDS.map((id) => {
        const w = saved.widgets?.[id]
        return [
          id,
          {
            visible: typeof w?.visible === 'boolean' ? w.visible : true,
            x: typeof w?.x === 'number' ? w.x : null,
            y: typeof w?.y === 'number' ? w.y : null
          }
        ]
      })
    ) as AppConfig['widgets'],
    browser: { ...defaultBrowser(), ...saved.browser },
    // Явный флаг; старый сейв без поля → уже настроен; пустой merge({}) → мастер.
    onboardingCompleted:
      typeof saved.onboardingCompleted === 'boolean'
        ? saved.onboardingCompleted
        : Array.isArray(saved.services) || Array.isArray(saved.envs),
    profile: { ...defaultProfile(), ...saved.profile },
    removedServiceIds: saved.removedServiceIds ?? [],
    envs,
    services: [...contourServices, ...sharedAll]
  }
}

export function getConfig(): AppConfig {
  if (cache) return cache
  const file = configFile()
  if (!existsSync(file)) {
    cache = merge({})
    saveConfig(cache)
    return cache
  }
  try {
    cache = merge(JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>)
  } catch {
    cache = merge({})
  }
  // Склейка с дефолтами и миграции должны оседать на диске, иначе они
  // выполняются заново при каждом запуске и не видны снаружи.
  saveConfig(cache)
  return cache
}

export function saveConfig(next: AppConfig): AppConfig {
  const file = configFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  } catch (e) {
    // Без этого лога неудачная запись на диск выглядит как «настройка просто
    // не сохранилась» без единой зацепки — а cache ниже всё равно обновится,
    // так что в текущем сеансе всё будет выглядеть нормально до перезапуска.
    logError('config', `не удалось сохранить config.json: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
  cache = next
  return next
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  return saveConfig({ ...getConfig(), ...patch })
}

export function upsertService(service: ServiceConfig): AppConfig {
  const cfg = getConfig()
  const withOrder: ServiceConfig =
    service.order != null
      ? service
      : {
          ...service,
          order:
            Math.max(
              -1,
              ...cfg.services.filter((s) => s.envId === service.envId).map((s) => s.order ?? 0)
            ) + 1
        }
  const services = cfg.services.some((s) => s.id === withOrder.id)
    ? cfg.services.map((s) => (s.id === withOrder.id ? withOrder : s))
    : [...cfg.services, withOrder]
  return saveConfig({ ...cfg, services })
}

/** Переставить сервисы контура: orderedIds — полный список id сверху вниз. */
export function reorderServices(envId: string, orderedIds: string[]): AppConfig {
  const cfg = getConfig()
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  const services = cfg.services.map((s) =>
    s.envId === envId && rank.has(s.id) ? { ...s, order: rank.get(s.id)! } : s
  )
  return saveConfig({ ...cfg, services })
}

export function removeService(id: string): AppConfig {
  const cfg = getConfig()
  // Дефолтный сервис помечаем удалённым, чтобы merge его не вернул; кастомный
  // (есть префикс .custom.) просто убираем.
  const removedServiceIds = cfg.removedServiceIds.includes(id)
    ? cfg.removedServiceIds
    : [...cfg.removedServiceIds, id]
  return saveConfig({
    ...cfg,
    services: cfg.services.filter((s) => s.id !== id),
    removedServiceIds
  })
}

export function upsertEnv(env: EnvConfig): AppConfig {
  const cfg = getConfig()
  const envs = cfg.envs.some((e) => e.id === env.id)
    ? cfg.envs.map((e) => (e.id === env.id ? env : e))
    : [...cfg.envs, env]
  return saveConfig({ ...cfg, envs })
}

export function getEnv(id: string): EnvConfig | undefined {
  return getConfig().envs.find((e) => e.id === id)
}
