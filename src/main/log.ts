import { app } from 'electron'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Простой файловый лог. Пишем и в консоль (видно в dev), и в файл в userData —
 * чтобы в собранном приложении можно было понять, что произошло, без Xcode.
 */
export type LogLevel = 'info' | 'warn' | 'error'

let logPath: string | null = null
function path(): string {
  if (!logPath) logPath = join(app.getPath('userData'), 'kontur.log')
  return logPath
}

export function logFilePath(): string {
  return path()
}

export function log(level: LogLevel, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  // Пишем без ожидания: лог не должен тормозить работу и не должен падать.
  appendFile(path(), line + '\n').catch(() => {})
}

export const logInfo = (scope: string, m: string): void => log('info', scope, m)
export const logWarn = (scope: string, m: string): void => log('warn', scope, m)
export const logError = (scope: string, m: string): void => log('error', scope, m)

/** Последние строки лога для просмотра в интерфейсе. */
export async function tailLog(lines = 300): Promise<string> {
  try {
    const text = await readFile(path(), 'utf8')
    const all = text.split('\n')
    return all.slice(-lines).join('\n')
  } catch {
    return 'Лог пока пуст.'
  }
}

/** Общий помощник: не дать операции висеть дольше ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Таймаут: ${label} не ответил за ${Math.round(ms / 1000)} с`)), ms)
    )
  ])
}
