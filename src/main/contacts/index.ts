/**
 * Адресная книга — как автозаполнение получателей в Outlook.
 *
 * Источники, от самого ценного:
 *  - кому вы писали сами и кого звали на встречи (`sent`) — «кэш автозаполнения»;
 *  - участники и организаторы встреч (`meeting`);
 *  - отправители и получатели писем (`mail`);
 *  - GAL — общая адресная книга Exchange (`gal`), ищется на лету по всем ящикам.
 *
 * Локальная часть копится при синке (EAS отдаёт From/To/Cc и участников) и при
 * отправке писем/встреч из приложения. Найденное в GAL тоже оседает здесь —
 * в следующий раз человек найдётся мгновенно и без сети.
 */
import type { CalendarPerson, ServiceConfig } from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { searchContacts, type ContactSource } from '../db'
import { health } from '../net/health'
import { logInfo, logWarn } from '../log'
import { createEasClient } from '../connectors/eas'
import type { EasClient } from '../connectors/eas/client'
import { ownAddresses, rememberPeople, type SeenPerson } from './harvest'

export {
  harvestEvent,
  harvestMail,
  parseAddresses,
  rememberPeople,
  rememberRecipients,
  type Person,
  type SeenPerson
} from './harvest'

/* ── GAL ─────────────────────────────────────────────────────────────── */

const CLIENT_TTL_MS = 10 * 60_000
const GAL_TIMEOUT_MS = 2500

/**
 * Готовый (уже провиженный) клиент на ящик. createEasClient — это DNS-проба и
 * Provision, несколько запросов к Exchange: звать его на каждое нажатие клавиши
 * значило ждать секунды и получать ответ уже к устаревшему запросу.
 */
const clients = new Map<string, { client: Promise<EasClient>; at: number }>()
/** Ящики, по которым GAL уже отвечал в этом сеансе, — чтобы не писать в лог на каждый символ. */
const galConfirmed = new Set<string>()

function galServices(): ServiceConfig[] {
  return getConfig().services.filter(
    (s) =>
      s.kind === 'mail' &&
      s.enabled &&
      (s.options.protocol || 'eas') === 'eas' &&
      Boolean(s.baseUrl || s.options.easUrl)
  )
}

function clientFor(service: ServiceConfig): Promise<EasClient> {
  const hit = clients.get(service.id)
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit.client
  const env = getConfig().envs.find((e) => e.id === service.envId)
  if (!env) return Promise.reject(new Error('контур не найден'))
  const client = createEasClient({ env, service, secret: getSecret(`${service.id}.secret`), cursor: null })
  clients.set(service.id, { client, at: Date.now() })
  // Неудачный вход не кэшируем — следующий запрос попробует заново.
  client.catch(() => clients.delete(service.id))
  return client
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: нет ответа за ${ms} мс`)), ms))
  ])
}

async function searchGalEverywhere(query: string, limit: number): Promise<SeenPerson[]> {
  // Контур, чей туннель точно лежит, не ждём — запрос всё равно упрётся в таймаут.
  const services = galServices().filter((s) => health.tunnelOf(s.envId) !== 'down')
  const results = await Promise.all(
    services.map(async (s) => {
      try {
        const client = await withTimeout(clientFor(s), GAL_TIMEOUT_MS * 2, `${s.id} вход`)
        const found = await withTimeout(client.searchGal(query, limit), GAL_TIMEOUT_MS, `${s.id} GAL`)
        if (!galConfirmed.has(s.id)) {
          galConfirmed.add(s.id)
          logInfo('contacts', `GAL ${s.id}: отвечает (по «${query}» — ${found.length})`)
        }
        const people = found.map((p) => ({ ...p, source: 'gal' as const }))
        rememberPeople(people, s.envId)
        return people
      } catch (e) {
        logWarn('contacts', `GAL ${s.id}: ${e instanceof Error ? e.message : String(e)}`)
        return []
      }
    })
  )
  return results.flat()
}

/* ── Подсказки ───────────────────────────────────────────────────────── */

/**
 * Подсказки получателей. Сначала свои контакты (кому писали, с кем встречались,
 * свежие выше), затем GAL всех ящиков.
 */
export async function suggestContacts(
  query: string,
  opts: { limit?: number; gal?: boolean } = {}
): Promise<CalendarPerson[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const limit = opts.limit ?? 12
  const own = ownAddresses()

  const toPerson = (p: { email: string; name: string; source: ContactSource }): CalendarPerson => ({
    email: p.email,
    name: p.name || p.email.split('@')[0] || p.email,
    source: p.source === 'gal' ? 'gal' : 'local'
  })

  const local = searchContacts(q, limit * 2).filter((c) => !own.has(c.email))
  const out = new Map<string, CalendarPerson>()
  for (const c of local) if (out.size < limit) out.set(c.email, toPerson(c))

  // GAL — от двух символов, как в Outlook: по одной букве общая книга бессмысленна.
  if (opts.gal !== false && q.length >= 2 && out.size < limit) {
    for (const p of await searchGalEverywhere(q, limit)) {
      if (out.size >= limit) break
      if (own.has(p.email) || out.has(p.email)) continue
      out.set(p.email, toPerson(p))
    }
  }
  return [...out.values()]
}
