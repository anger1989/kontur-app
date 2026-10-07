import { session } from 'electron'
import type { ServiceConfig } from '@shared/types'
import { getConfig } from '../config/store'
import { setSecret } from '../config/secrets'

/** Имена сессионных кук, которые можно использовать как Bearer для API. */
const COOKIE_NAMES: Record<string, string[]> = {
  mattermost: ['MMAUTHTOKEN'],
  gitlab: ['_gitlab_session'],
  jira: ['JSESSIONID'],
  confluence: ['JSESSIONID'],
  bitbucket: ['BITBUCKETSESSIONID', 'JSESSIONID']
}

/**
 * Забрать актуальный сессионный токен из куки партиции контура.
 * Нужен, когда PAT закрыты админом, а пользователь уже вошёл во вкладке.
 * Возвращает значение или null, если сессии ещё нет.
 */
export async function grabSessionToken(serviceId: string): Promise<string | null> {
  const cfg = getConfig()
  const svc = cfg.services.find((s) => s.id === serviceId)
  const env = svc && cfg.envs.find((e) => e.id === svc.envId)
  if (!svc || !env || !svc.baseUrl) return null

  const names = COOKIE_NAMES[svc.kind]
  if (!names?.length) return null

  const cookies = await session.fromPartition(env.partition).cookies.get({ url: svc.baseUrl })
  const hit = cookies.find((c) => names.includes(c.name))
  if (!hit?.value) return null

  setSecret(`${svc.id}.secret`, hit.value, `${env.name} · ${svc.name} (сессия)`)
  return hit.value
}

/** Cookie-auth сервисы: перед API всегда предпочитаем свежую куку из вкладки. */
export function prefersSessionCookie(service: ServiceConfig): boolean {
  return service.auth.kind === 'cookie' && Boolean(COOKIE_NAMES[service.kind])
}
