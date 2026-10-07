import type { ServiceConfig } from '@shared/types'
import { useStore } from '@/store'

/** Хосты Контур.Толк: app.ktalk.ru, space.ktalk.ru, … */
export function isKtalkUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'ktalk.ru' || host.endsWith('.ktalk.ru')
  } catch {
    return false
  }
}

/** Сервис-владелец адреса: его вкладка уже залогинена и сидит в нужном контуре. */
function serviceForUrl(url: string, services: ServiceConfig[]): ServiceConfig | null {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  const open = services.filter((s) => s.enabled && s.mode !== 'launcher' && s.baseUrl)
  // Точное совпадение origin важнее: у Jira и Confluence бывает общий домен,
  // и ссылка на /browse/ABC-1 должна уйти именно в Jira.
  const sorted = [...open].sort((a, b) => (b.baseUrl?.length ?? 0) - (a.baseUrl?.length ?? 0))
  for (const s of sorted) {
    try {
      const base = new URL(s.baseUrl!)
      if (base.origin !== target.origin) continue
      // Базовый путь (например /confluence) — ссылка должна лежать внутри него.
      const prefix = base.pathname.replace(/\/+$/, '')
      if (prefix && prefix !== '' && !target.pathname.startsWith(prefix)) continue
      return s
    } catch {
      continue
    }
  }
  return null
}

/**
 * Открыть URL по настройке «Веб-ссылки» (Настройки → Общее).
 *
 * `app` — отдать ссылку вкладке Kontur, если адрес принадлежит подключённому
 * сервису (там уже есть вход и контур), иначе встроенному браузеру: у него
 * вкладки со своими контурами, так что посторонний сайт больше не обязан
 * уезжать в системный браузер. `system` — всегда наружу.
 *
 * Толк в режиме «Отдельное приложение» — исключение из обоих режимов: это не
 * веб-ссылка, а запуск .app, и настройка ссылок его не касается.
 */
export function openLink(url: string): void {
  const href = url.trim()
  if (!href) return

  const state = useStore.getState()
  const services = state.config?.services ?? []

  if (isKtalkUrl(href)) {
    const ktalk = services.find((s) => s.kind === 'ktalk' && s.enabled)
    if (ktalk?.mode === 'launcher') {
      const appPath = ktalk.options.appPath?.trim()
      if (appPath) {
        void window.kontur.app.openApp(appPath, href).catch(() => {
          void window.kontur.app.openExternal(href)
        })
        return
      }
    }
  }

  if ((state.config?.linkOpen ?? 'app') === 'app') {
    // Встречи Толка живут на company.ktalk.ru при baseUrl = app.ktalk.ru,
    // по origin они не совпадут — отдаём по домену, как это делает main.
    const owner =
      (isKtalkUrl(href)
        ? services.find((s) => s.kind === 'ktalk' && s.enabled && s.mode !== 'launcher')
        : null) ?? serviceForUrl(href, services)
    if (owner) {
      state.openWindow({ kind: 'service', serviceId: owner.id, url: href })
      return
    }
    // Хозяина у адреса нет — забирает браузер. Контур по умолчанию задан в
    // настройках: у постороннего сайта своего контура нет.
    void window.kontur.browser.newTab({ url: href })
    state.openWindow({ kind: 'page', page: 'browser' })
    return
  }

  void window.kontur.app.openExternal(href)
}
