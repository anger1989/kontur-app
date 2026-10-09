import { shell } from 'electron'
import { isAbsolute, normalize } from 'node:path'

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const APP_PROTOCOLS = new Set(['ktalk:'])
const MAX_EXTERNAL_URL_LENGTH = 8192

/** Проверка на границе main-процесса: renderer и содержимое вебвью недоверенные. */
export function safeExternalUrl(raw: unknown, allowAppProtocol = false): string {
  if (typeof raw !== 'string') throw new Error('Некорректная внешняя ссылка')
  const value = raw.trim()
  if (!value || value.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Некорректная внешняя ссылка')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Некорректная внешняя ссылка')
  }
  const allowed = WEB_PROTOCOLS.has(parsed.protocol) || (allowAppProtocol && APP_PROTOCOLS.has(parsed.protocol))
  if (!allowed) throw new Error(`Схема ${parsed.protocol} запрещена`)
  return parsed.toString()
}

export async function openSafeExternal(raw: unknown, allowAppProtocol = false): Promise<void> {
  await shell.openExternal(safeExternalUrl(raw, allowAppProtocol))
}

/** openPath/open -a разрешены только для явно выбранных macOS-приложений. */
export function safeAppPath(raw: unknown): string {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Некорректный путь к приложению')
  }
  const value = normalize(raw.trim())
  if (!isAbsolute(value) || !value.toLowerCase().endsWith('.app')) {
    throw new Error('Выберите приложение с расширением .app')
  }
  return value
}
