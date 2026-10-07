/** Сайт, заведённый в клиенте Check Point. */
export interface CheckpointSite {
  site: string
  username: string | null
  authMethod: string | null
  status: string | null
}

/**
 * Разбор вывода `trac info`.
 *
 * Клиент сам знает свои сайты, логины и методы аутентификации — это надёжнее,
 * чем просить пользователя переписать их руками из чужого интерфейса.
 */
export function parseTracInfo(output: string): CheckpointSite[] {
  const sites: CheckpointSite[] = []
  let current: CheckpointSite | null = null

  for (const raw of output.split('\n')) {
    const line = raw.trim()

    const conn = /^Conn\s+(.+?):$/.exec(line)
    if (conn) {
      current = { site: conn[1], username: null, authMethod: null, status: null }
      sites.push(current)
      continue
    }
    if (!current) continue

    const status = /^status:\s*(.+)$/.exec(line)
    if (status) current.status = status[1].trim()

    const auth = /^authentication method:\s*(.+?)(?:\s+with username\s+(\S+))?$/.exec(line)
    if (auth) {
      current.authMethod = auth[1].trim()
      current.username = auth[2] ?? null
    }
  }

  return sites
}
