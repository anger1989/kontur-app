import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EnvConfig } from '@shared/types'
import { domainsFromServices } from '@shared/dnsDomains'
import { getConfig, upsertEnv } from '../config/store'
import { logInfo, logError } from '../log'

const run = promisify(execFile)

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
    // Берём первый блок resolver #1 (основной) и его nameserver'ы.
    const firstBlock = stdout.split(/resolver #/).find((b) => /if_index/.test(b)) ?? stdout
    const servers = [...firstBlock.matchAll(/nameserver\[\d+\]\s*:\s*([0-9.]+)/g)].map((m) => m[1])
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

/**
 * Закрепить домены контура за его серверами имён.
 *
 * Всё, что можно, выясняем сами: домены — из адресов сервисов, серверы — из
 * текущего основного резолвера сразу после подъёма туннеля (в этот момент
 * система уже использует DNS этого контура). Заданные вручную значения
 * всегда в приоритете.
 */
export async function applySplitDns(env: EnvConfig): Promise<void> {
  if (env.splitDns === false) return

  const domains = effectiveDomains(env)

  let servers = env.dnsServers?.filter(Boolean) ?? []
  if (!servers.length) {
    servers = await captureDefaultDns()
  }

  if (!domains.length || !servers.length) {
    const why = !domains.length
      ? 'нет доменов (заполните URL сервисов или укажите домены вручную)'
      : 'нет DNS-серверов (поднимите VPN и нажмите «Считать», либо укажите IP вручную)'
    throw new Error(`Split-DNS не применён: ${why}`)
  }

  try {
    await sudoShell(buildApplyScript(domains, servers))
    // Запоминаем фактический набор — UI показывает его, clear снимает те же файлы.
    upsertEnv({ ...env, dnsDomains: domains, dnsServers: servers })
    logInfo('dns', `split-DNS для «${env.name}»: ${domains.join(', ')} → ${servers.join(', ')}`)
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
