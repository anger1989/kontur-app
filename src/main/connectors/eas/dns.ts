import { Resolver } from 'node:dns'
import { lookup as systemLookup } from 'node:dns'
import { isIP } from 'node:net'
import { logInfo, logWarn } from '../../log'

/**
 * DNS для EAS: сами резолвим в один IPv4.
 *
 * undici зовёт lookup с `{ all: true }` — нельзя просто прокидывать в dns.lookup
 * и считать, что address — строка. При VPN системный 10.x для owa — правильный;
 * публичный VIP часто даёт Headers Timeout.
 */
const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1']

function isPrivateV4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const a = +m[1]
  const b = +m[2]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 127) return true
  return false
}

const publicResolver = new Resolver()
publicResolver.setServers(PUBLIC_DNS)

const cache = new Map<string, { ip: string; at: number; via: 'system' | 'public' }>()
const TTL_MS = 30_000

function resolveSystemV4(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    systemLookup(hostname, { family: 4 }, (err, address) => {
      if (err || !address) reject(err ?? new Error('no A'))
      else resolve(address)
    })
  })
}

function resolvePublicV4(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    publicResolver.resolve4(hostname, (err, list) => {
      if (err) return reject(err)
      const ip = list.find((a) => !isPrivateV4(a)) ?? list[0]
      if (!ip) reject(new Error('empty'))
      else resolve(ip)
    })
  })
}

async function resolveEasHost(hostname: string): Promise<{ ip: string; via: 'system' | 'public' }> {
  const hit = cache.get(hostname)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  try {
    const ip = await resolveSystemV4(hostname)
    const row = { ip, at: Date.now(), via: 'system' as const }
    cache.set(hostname, row)
    return row
  } catch {
    const ip = await resolvePublicV4(hostname)
    const row = { ip, at: Date.now(), via: 'public' as const }
    cache.set(hostname, row)
    return row
  }
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void

export function easLookup(
  hostname: string,
  options: Parameters<typeof systemLookup>[1] | LookupCb,
  callback?: LookupCb
): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCb
  const opts = (typeof options === 'function' ? {} : options) ?? {}
  const all = typeof opts === 'object' && opts !== null && 'all' in opts && Boolean(opts.all)

  const finish = (ip: string): void => {
    if (all) cb(null, [{ address: ip, family: 4 }])
    else cb(null, ip, 4)
  }

  if (isIP(hostname)) {
    finish(hostname)
    return
  }

  void resolveEasHost(hostname)
    .then(({ ip, via }) => {
      logInfo('mail', `EAS DNS ${hostname} → ${ip} (${via === 'public' ? 'публичный' : 'системный'})`)
      finish(ip)
    })
    .catch((err: NodeJS.ErrnoException) => {
      logWarn('mail', `EAS DNS ${hostname}: ${err.message}`)
      cb(err, '', 4)
    })
}

export async function easDnsProbe(hostname: string): Promise<{
  system: string | null
  public: string | null
  systemPrivate: boolean
  preferred: 'system' | 'public'
}> {
  let system: string | null = null
  let pub: string | null = null
  try {
    system = await resolveSystemV4(hostname)
  } catch {
    system = null
  }
  try {
    pub = await resolvePublicV4(hostname)
  } catch {
    pub = null
  }
  return {
    system,
    public: pub,
    systemPrivate: system ? isPrivateV4(system) : false,
    preferred: system ? 'system' : 'public'
  }
}
