import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Resolver } from 'node:dns/promises'
import type { EnvConfig } from '@shared/types'
import { domainsFromServices } from '@shared/dnsDomains'
import { getConfig, upsertEnv } from '../config/store'
import { logInfo, logError } from '../log'

const run = promisify(execFile)

/** Сколько ждём ответа сервера имён, когда проверяем, живой ли он. */
const DNS_PROBE_TIMEOUT_MS = 2000

/**
 * Split-DNS через /etc/resolver.
 *
 * Когда подняты два туннеля сразу, второй клиент делает свой DNS основным, и
 * внутренние имена первого контура перестают резолвиться (маршруты при этом
 * целы). Мы закрепляем домены контура за его DNS-сервером отдельными файлами
 * /etc/resolver/<домен> — такие запросы идут мимо основного резолвера, и оба
 * контура работают одновременно.
 *
 * Запись в /etc/resolver требует прав root — делаем это одним системным
 * запросом прав на контур.
 */

/** Текущие nameserver'ы основного резолвера — чтобы «определить DNS» контура. */
export async function captureDefaultDns(): Promise<string[]> {
  try {
    const { stdout } = await run('scutil', ['--dns'])
    // Только основная секция: ниже идут scoped-копии по интерфейсам, и при
    // поднятом туннеле первая из них — не тот резолвер, которым ходит система.
    const main = stdout.split(/DNS configuration \(for scoped queries\)/)[0]
    // Первый блок с nameserver'ами (у mdns-блоков их нет) — основной резолвер.
    const block = main
      .split(/resolver #/)
      .slice(1)
      .find((b) => /nameserver\[/.test(b))
    if (!block) return []
    const servers = [...block.matchAll(/nameserver\[\d+\]\s*:\s*([0-9.]+)/g)].map((m) => m[1])
    return [...new Set(servers)]
  } catch {
    return []
  }
}

function buildApplyScript(domains: string[], servers: string[]): string {
  const ns = servers.map((s) => `nameserver ${s}`).join('\\n')
  const parts = ['mkdir -p /etc/resolver']
  for (const d of domains) {
    // Имя файла — домен; содержимое — nameserver'ы контура.
    parts.push(`printf '${ns}\\n' > '/etc/resolver/${d.replace(/[^a-z0-9.-]/gi, '')}'`)
  }
  return parts.join(' && ')
}

function buildClearScript(domains: string[]): string {
  return domains
    .map((d) => `rm -f '/etc/resolver/${d.replace(/[^a-z0-9.-]/gi, '')}'`)
    .join(' ; ')
}

async function sudoShell(script: string): Promise<void> {
  // Один системный диалог прав на всю операцию.
  await run('osascript', [
    '-e',
    `do shell script ${JSON.stringify(script)} with administrator privileges`
  ])
}

/** Домены контура: ручные или выведенные из сервисов / health-check. */
export function effectiveDomains(env: EnvConfig): string[] {
  if (env.dnsDomains?.filter(Boolean)?.length) {
    return env.dnsDomains.filter(Boolean)
  }
  return domainsFromServices(getConfig().services, env.id, env.healthCheckUrl)
}

/** Внутреннее имя контура: снаружи его нет, поэтому по нему виден «свой» DNS. */
function probeHost(env: EnvConfig): string | null {
  if (!env.healthCheckUrl) return null
  try {
    return new URL(env.healthCheckUrl).hostname || null
  } catch {
    return null
  }
}

/** Отвечает ли хоть один из серверов на внутреннее имя контура. */
async function serversResolve(servers: string[], host: string): Promise<boolean> {
  for (const server of servers) {
    const resolver = new Resolver({ timeout: DNS_PROBE_TIMEOUT_MS, tries: 1 })
    try {
      resolver.setServers([server])
      if ((await resolver.resolve4(host)).length) return true
    } catch {
      /* мёртвый или чужой сервер — пробуем следующий */
    }
  }
  return false
}

/**
 * Серверы имён контура.
 *
 * Заданное руками в приоритете, но если прежний набор больше не отвечает на
 * внутреннее имя контура — у контура сменился VPN, а с ним и DNS. Тогда
 * перечитываем текущий основной резолвер: иначе /etc/resolver навсегда
 * показывает на адреса, до которых уже нет маршрута, и внутренние имена не
 * резолвятся вовсе. Заменяем только на набор, который сам отвечает на это имя,
 * — домашний или чужой резолвер контур не починит.
 */
async function pickServers(env: EnvConfig): Promise<{ servers: string[]; changed: boolean }> {
  const saved = env.dnsServers?.filter(Boolean) ?? []
  if (!saved.length) return { servers: await captureDefaultDns(), changed: true }

  const host = probeHost(env)
  if (!host) return { servers: saved, changed: false }
  if (await serversResolve(saved, host)) return { servers: saved, changed: false }

  const captured = await captureDefaultDns()
  const isOther = captured.some((s) => !saved.includes(s))
  if (!isOther || !(await serversResolve(captured, host))) {
    // Замены нет — оставляем прежние: скорее всего туннель просто не поднят.
    return { servers: saved, changed: false }
  }
  logInfo('dns', `DNS контура «${env.name}» сменился: ${saved.join(', ')} → ${captured.join(', ')}`)
  return { servers: captured, changed: true }
}

async function writeSplitDns(env: EnvConfig, domains: string[], servers: string[]): Promise<void> {
  await sudoShell(buildApplyScript(domains, servers))
  // Запоминаем фактический набор — UI показывает его, clear снимает те же файлы.
  upsertEnv({ ...env, dnsDomains: domains, dnsServers: servers })
  logInfo('dns', `split-DNS для «${env.name}»: ${domains.join(', ')} → ${servers.join(', ')}`)
}

/**
 * Закрепить домены контура за его серверами имён.
 *
 * Всё, что можно, выясняем сами: домены — из адресов сервисов, серверы — из
 * текущего основного резолвера сразу после подъёма туннеля (в этот момент
 * система уже использует DNS этого контура). Заданные вручную значения
 * в приоритете, пока отвечают.
 */
export async function applySplitDns(env: EnvConfig): Promise<void> {
  if (env.splitDns === false) return

  const domains = effectiveDomains(env)
  const { servers } = await pickServers(env)

  if (!domains.length || !servers.length) {
    const why = !domains.length
      ? 'нет доменов (заполните URL сервисов или укажите домены вручную)'
      : 'нет DNS-серверов (поднимите VPN и нажмите «Считать», либо укажите IP вручную)'
    throw new Error(`Split-DNS не применён: ${why}`)
  }

  try {
    await writeSplitDns(env, domains, servers)
  } catch (err) {
    logError(
      'dns',
      `не удалось применить split-DNS для «${env.name}»: ${err instanceof Error ? err.message : String(err)}`
    )
    throw err
  }
}

/** Снять закрепление доменов контура. */
export async function clearSplitDns(env: EnvConfig): Promise<void> {
  const domains = effectiveDomains(env)
  resetSplitDnsAutoFlag(env.id)
  repaired.delete(env.id)
  if (!domains.length) return
  try {
    await sudoShell(buildClearScript(domains))
    logInfo('dns', `split-DNS снят для «${env.name}»`)
  } catch {
    // Снятие не критично: при выключении контура можно и промолчать.
  }
}

/** Env'ы, для которых в этой сессии уже писали /etc/resolver после markUp. */
const autoApplied = new Set<string>()

/** Сбросить флаг авто-apply (после down или ручного clear). */
export function resetSplitDnsAutoFlag(envId: string): void {
  autoApplied.delete(envId)
}

/**
 * Если туннель стал up снаружи (ручной VPN) — один раз попытаться закрепить DNS.
 * Повторные probe не дёргают sudo.
 */
export function maybeAutoApplySplitDns(envId: string): void {
  if (autoApplied.has(envId)) return
  const env = getConfig().envs.find((e) => e.id === envId)
  if (!env || env.splitDns === false) return
  autoApplied.add(envId)
  void applySplitDns(env).catch((err) => {
    autoApplied.delete(envId)
    logError(
      'dns',
      `авто split-DNS для «${env.name}»: ${err instanceof Error ? err.message : String(err)}`
    )
  })
}

/** Контуры, которым в этой сессии уже переписывали серверы: ключ — набор IP. */
const repaired = new Map<string, string>()
const repairing = new Set<string>()
const lastRepairCheck = new Map<string, number>()

/** Проверка серверов стоит пары секунд — не чаще раза в минуту на контур. */
const REPAIR_CHECK_EVERY_MS = 60_000

/**
 * Проба контура не прошла — возможно, у него сменился VPN, а с ним и DNS.
 *
 * Зовём на любой неудачной пробе, не только на «имя не резолвится»: мёртвый
 * nameserver не отвечает вообще, и проба обрывается по таймауту раньше, чем
 * система отдаст ERR_NAME_NOT_RESOLVED — по тексту ошибки эти случаи не
 * различить. Если туннель на самом деле поднят, а в /etc/resolver остались
 * серверы прежнего VPN, контур уже никогда не станет up — значит и авто-apply
 * из markUp не случится. Переписываем файлы сами, но только когда нашли
 * другой, реально отвечающий набор: иначе ни одного запроса прав (при просто
 * не поднятом туннеле замены не найдётся, и мы промолчим). Один раз на набор,
 * чтобы отменённый диалог не возвращался каждую пробу — после отмены помогает
 * «Применить» в настройках контура.
 */
export function maybeRepairSplitDns(envId: string): void {
  if (repairing.has(envId)) return
  const env = getConfig().envs.find((e) => e.id === envId)
  if (!env || env.splitDns === false) return

  const now = Date.now()
  if (now - (lastRepairCheck.get(envId) ?? 0) < REPAIR_CHECK_EVERY_MS) return
  lastRepairCheck.set(envId, now)

  repairing.add(envId)
  void (async () => {
    try {
      const { servers, changed } = await pickServers(env)
      if (!changed || !servers.length) return
      const key = servers.join(',')
      if (repaired.get(envId) === key) return
      const domains = effectiveDomains(env)
      if (!domains.length) return
      repaired.set(envId, key)
      await writeSplitDns(env, domains, servers)
      autoApplied.add(envId)
    } catch (err) {
      logError(
        'dns',
        `не удалось переписать split-DNS для «${env.name}»: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      repairing.delete(envId)
    }
  })()
}
