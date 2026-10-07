import { Agent, ProxyAgent, type Dispatcher } from 'undici'
import { readFileSync, existsSync } from 'node:fs'
import type { EnvConfig } from '@shared/types'

/**
 * Шов, за которым прячется вся разница между контурами.
 *
 * Сейчас оба туннеля подняты штатными клиентами на самом хосте и работают
 * в split-режиме, поэтому обычно это просто прямой Agent. Но если контур
 * однажды уедет за SOCKS (отдельный netns, агент в VM, третья среда) —
 * меняется только эта функция, коннекторы не трогаются.
 */
const cache = new Map<string, { key: string; dispatcher: Dispatcher }>()

function cacheKey(env: EnvConfig): string {
  return `${env.proxy ?? ''}|${env.caCertPath ?? ''}|${env.allowInsecureTls ? 'insecure' : ''}`
}

function buildDispatcher(env: EnvConfig): Dispatcher {
  // Корпоративный CA: в контуре с TLS-инспекцией без него Node падает
  // на UNABLE_TO_VERIFY_LEAF_SIGNATURE, хотя вебвью открывает тот же хост нормально.
  const ca =
    env.caCertPath && existsSync(env.caCertPath) ? readFileSync(env.caCertPath, 'utf8') : undefined

  // Пользователь явно разрешил доверять внутренним сертификатам контура —
  // отключаем проверку TLS только для его запросов.
  const connect = env.allowInsecureTls ? { ca, rejectUnauthorized: false } : { ca }

  return env.proxy
    ? new ProxyAgent({ uri: env.proxy, connect, connectTimeout: 10_000 })
    : new Agent({ connect, connectTimeout: 10_000 })
}

export function dispatcherFor(env: EnvConfig): Dispatcher {
  const key = cacheKey(env)
  const hit = cache.get(env.id)
  if (hit && hit.key === key) return hit.dispatcher

  const dispatcher = buildDispatcher(env)
  cache.get(env.id)?.dispatcher.close().catch(() => {})
  cache.set(env.id, { key, dispatcher })
  return dispatcher
}

/** Сбросить пул сокетов контура — после подъёма VPN старые коннекты часто «висят». */
export function resetDispatcher(envId: string): void {
  const hit = cache.get(envId)
  if (!hit) return
  cache.delete(envId)
  void hit.dispatcher.close().catch(() => {})
}

/** Жёстко рвём пулы при выходе — `close()` ждёт in-flight и может зависнуть. */
export async function closeTransports(): Promise<void> {
  const pending = [...cache.values()].map((v) =>
    Promise.resolve(v.dispatcher.destroy()).catch(() => {})
  )
  cache.clear()
  await Promise.all(pending)
}
