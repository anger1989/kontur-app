import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import { refreshTrayBadge } from '../tray'

/**
 * Склеивает шквал `itemsChanged` от синка/realtime/markRead в один тик:
 * иначе renderer делает N× queryItems почти одновременно.
 */
let timer: ReturnType<typeof setTimeout> | null = null
let getWin: (() => BrowserWindow | null) | null = null

export function bindItemsChanged(getter: () => BrowserWindow | null): void {
  getWin = getter
}

export function emitItemsChanged(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const win = getWin?.() ?? null
    win?.webContents.send(CH.itemsChanged)
    refreshTrayBadge()
  }, 48)
}
