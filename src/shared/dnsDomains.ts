/**
 * Домены для split-DNS: 2-й уровень из URL сервисов / health-check контура.
 * Общий хелпер — main и renderer считают одинаково.
 */

export type DnsDomainSource = {
  envId: string
  baseUrl?: string | null
  options?: {
    easUrl?: string | null
    jmapUrl?: string | null
    caldavUrl?: string | null
  }
}

function addHost(out: Set<string>, raw: string | null | undefined): void {
  if (!raw) return
  try {
    const host = new URL(raw).hostname
    if (!host || /^[\d.]+$/.test(host)) return
    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 2) out.add(parts.slice(-2).join('.').toLowerCase())
  } catch {
    /* некорректный URL */
  }
}

export function domainsFromServices(
  services: DnsDomainSource[],
  envId: string,
  healthCheckUrl?: string | null
): string[] {
  const out = new Set<string>()
  addHost(out, healthCheckUrl)
  for (const s of services) {
    if (s.envId !== envId) continue
    addHost(out, s.baseUrl)
    addHost(out, s.options?.easUrl)
    addHost(out, s.options?.jmapUrl)
    addHost(out, s.options?.caldavUrl)
  }
  return [...out].sort()
}

/** Разбор строки из UI: домены или IP через пробел / запятую. */
export function parseDnsList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
}
