import { app } from 'electron'
import { appendFile, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Простой файловый лог. Пишем и в консоль (видно в dev), и в файл в userData —
 * чтобы в собранном приложении можно было понять, что произошло, без Xcode.
 */
export type LogLevel = 'info' | 'warn' | 'error'

let logPath: string | null = null
const MAX_LOG_BYTES = 2 * 1024 * 1024
const LOG_CHECK_EVERY = 50
let writesSinceSizeCheck = LOG_CHECK_EVERY
let writeQueue: Promise<void> = Promise.resolve()
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
  // Сериализуем запись, чтобы параллельные append/rotation не перетирали друг
  // друга. Очередь не ожидается вызывающим кодом и никогда не выбрасывает.
  writeQueue = writeQueue
    .then(async () => {
      writesSinceSizeCheck += 1
      if (writesSinceSizeCheck >= LOG_CHECK_EVERY) {
        writesSinceSizeCheck = 0
        try {
          const info = await stat(path())
          if (info.size >= MAX_LOG_BYTES) {
            await rename(path(), `${path()}.old`).catch(() => {})
          }
        } catch {
          // Файла ещё нет — append создаст его ниже.
        }
      }
      await appendFile(path(), line + '\n')
    })
    .catch(() => {})
}

export const logInfo = (scope: string, m: string): void => log('info', scope, m)
export const logWarn = (scope: string, m: string): void => log('warn', scope, m)
export const logError = (scope: string, m: string): void => log('error', scope, m)

/** Последние строки лога для просмотра в интерфейсе. */
export async function tailLog(lines = 300): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path(), 'r')
    const info = await handle.stat()
    const length = Math.min(info.size, MAX_LOG_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, info.size - length))
    const text = buffer.toString('utf8')
    const all = text.split('\n')
    return all.slice(-lines).join('\n')
  } catch {
    return 'Лог пока пуст.'
  } finally {
    await handle?.close().catch(() => {})
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
