import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'

/**
 * Каталог закладок меняется и синхронно (добавил/удалил), и фоном (иконка
 * досталась чуть позже) — один канал на оба случая, renderer просто перечитывает список.
 */
let getWin: (() => BrowserWindow | null) | null = null

export function bindBookmarksChanged(getter: () => BrowserWindow | null): void {
  getWin = getter
}

export function emitBookmarksChanged(): void {
  getWin?.()?.webContents.send(CH.bookmarksChanged)
}
