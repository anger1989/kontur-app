import type { AppConfig, ServiceConfig } from '@shared/types'

/**
 * Куда вести ссылку на чужой домен, открытую из вебвью.
 *
 * Чистое решение без побочных эффектов — его вызывает main и уже сам делает
 * то, что здесь написано. Вынесено из index.ts, чтобы правило «свой домен
 * остаётся, чужой уходит в отдельную вкладку» можно было проверить тестом.
 */
export type LinkTarget =
  /** Подключённый сервис-владелец адреса — у него уже есть вход и контур. */
  | { kind: 'service'; serviceId: string; url: string }
  /** Посторонний сайт — вкладка встроенного браузера в контуре источника. */
  | { kind: 'web'; envId: string; url: string }
  | { kind: 'system'; url: string }
  | { kind: 'ignore' }

function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function resolveExternalLink(
  cfg: AppConfig,
  sourceServiceId: string,
  url: string
): LinkTarget {
  const origin = originOf(url)
  if (!origin) return { kind: 'ignore' }

  // Подключённый сервис с этим адресом знает про свою авторизацию — ссылка
  // туда и должна идти, а не в безымянную вкладку.
  const owner: ServiceConfig | undefined = cfg.services.find(
    (s) => s.enabled && s.mode !== 'launcher' && originOf(s.baseUrl) === origin
  )
  if (owner) return { kind: 'service', serviceId: owner.id, url }

  if (cfg.linkOpen === 'system') return { kind: 'system', url }

  // Контур берём у источника: ссылка из банковского чата открывается в
  // банковской сессии и через его туннель — но уже вкладкой браузера, а не
  // отдельным псевдосервисом.
  const source = cfg.services.find((s) => s.id === sourceServiceId)
  return { kind: 'web', envId: source?.envId ?? 'shared', url }
}
