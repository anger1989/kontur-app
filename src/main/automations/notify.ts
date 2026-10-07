import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'

let getWin: (() => BrowserWindow | null) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function bindAutomationsChanged(getter: () => BrowserWindow | null): void {
  getWin = getter
}

export function emitAutomationsChanged(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    getWin?.()?.webContents.send(CH.automationsChanged)
  }, 48)
}
