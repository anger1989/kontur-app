/**
 * Текущая раскладка клавиатуры (macOS Input Source).
 * Читаем HIToolbox.plist — без native addon и без сломанного Carbon/Swift CLI.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow, systemPreferences } from 'electron'
import { CH } from '@shared/ipc'
import { logWarn } from './log'

const execFileAsync = promisify(execFile)

export interface KeyboardLayout {
  /** com.apple.keylayout.Russian */
  id: string
  /** Короткий бейдж: RU / EN / … */
  short: string
  /** Человекочитаемое имя: Russian, ABC */
  name: string
}

const HITOLBOX = join(homedir(), 'Library/Preferences/com.apple.HIToolbox.plist')

/** Из id/имени → двухбуквенный код как в менюшке macOS. */
function shortOf(id: string, name: string): string {
  const raw = `${id} ${name}`.toLowerCase()
  if (/russian|ru\b|russianwin|russian\-phonetic/.test(raw)) return 'RU'
  if (/ukrainian|uk\b/.test(raw)) return 'UK'
  if (/belarus|by\b/.test(raw)) return 'BY'
  if (/kazakh/.test(raw)) return 'KK'
  if (/german|deutsch|austrian|swiss.?german/.test(raw)) return 'DE'
  if (/french|francais|canadian.?french|swiss.?french/.test(raw)) return 'FR'
  if (/spanish|espanol/.test(raw)) return 'ES'
  if (/italian/.test(raw)) return 'IT'
  if (/polish/.test(raw)) return 'PL'
  if (/czech/.test(raw)) return 'CS'
  if (/turkish/.test(raw)) return 'TR'
  if (/arabic/.test(raw)) return 'AR'
  if (/hebrew/.test(raw)) return 'HE'
  if (/chinese|pinyin|cangjie|zhuan/.test(raw)) return '中'
  if (/japanese|kana|romaji/.test(raw)) return 'あ'
  if (/korean|hangul|2set/.test(raw)) return '한'
  if (/\babc\b|us\b|british|australian|irish|english|dvorak|colemak|keylayout\.us/.test(raw))
    return 'EN'
  // Fallback: последние 2 символа id после точки, uppercase.
  const tail = id.split('.').pop() ?? name
  const letters = tail.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '')
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase()
  return (name || '?').slice(0, 2).toUpperCase()
}

function nameFromId(id: string): string {
  const m = id.match(/keylayout\.(.+)$/i)
  if (!m?.[1]) return id
  // Russian-Phonetic → Russian Phonetic; ABC stays ABC.
  return m[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ')
}

async function readDefaults(): Promise<KeyboardLayout> {
  try {
    const { stdout } = await execFileAsync('defaults', [
      'read',
      HITOLBOX,
      'AppleCurrentKeyboardLayoutInputSourceID'
    ])
    const id = stdout.trim().replace(/^"|"$/g, '')
    if (!id) throw new Error('empty id')
    const name = nameFromId(id)
    return { id, name, short: shortOf(id, name) }
  } catch {
    // Fallback: первый Keyboard Layout из AppleSelectedInputSources через plutil.
    try {
      const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', HITOLBOX])
      const json = JSON.parse(stdout) as {
        AppleCurrentKeyboardLayoutInputSourceID?: string
        AppleSelectedInputSources?: { 'KeyboardLayout Name'?: string; InputSourceKind?: string }[]
      }
      const id = json.AppleCurrentKeyboardLayoutInputSourceID ?? ''
      const selected = (json.AppleSelectedInputSources ?? []).find(
        (s) => s.InputSourceKind === 'Keyboard Layout' && s['KeyboardLayout Name']
      )
      const name = selected?.['KeyboardLayout Name'] ?? (nameFromId(id) || '—')
      const resolvedId = id || `name:${name}`
      return { id: resolvedId, name, short: shortOf(resolvedId, name) }
    } catch (e) {
      logWarn('keyboard', `не удалось прочитать раскладку: ${e instanceof Error ? e.message : String(e)}`)
      return { id: 'unknown', name: '—', short: '—' }
    }
  }
}

let cached: KeyboardLayout | null = null
let watcher: FSWatcher | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let unsubNotification: (() => void) | null = null
let getWin: (() => BrowserWindow | null) | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

function emit(layout: KeyboardLayout): void {
  const win = getWin?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send(CH.keyboardLayoutChanged, layout)
}

async function refresh(force = false): Promise<KeyboardLayout> {
  const next = await readDefaults()
  if (
    !force &&
    cached &&
    cached.id === next.id &&
    cached.short === next.short &&
    cached.name === next.name
  ) {
    return cached
  }
  cached = next
  emit(next)
  return next
}

function scheduleRefresh(): void {
  if (debounce) clearTimeout(debounce)
  // HIToolbox пишет plist с небольшой задержкой после Cmd+Space.
  debounce = setTimeout(() => {
    debounce = null
    void refresh()
  }, 80)
}

export async function getKeyboardLayout(): Promise<KeyboardLayout> {
  if (cached) return cached
  return refresh(true)
}

export function startKeyboardLayoutWatch(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow
  void refresh(true)

  // Системное уведомление о смене source — самый быстрый путь.
  try {
    const subId = systemPreferences.subscribeNotification(
      'AppleSelectedInputSourcesChangedNotification',
      () => scheduleRefresh()
    )
    unsubNotification = () => {
      try {
        systemPreferences.unsubscribeNotification(subId)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* старые Electron / не darwin */
  }

  // Плюс watch на plist — на случай если notification не пришёл.
  try {
    watcher?.close()
    watcher = watch(HITOLBOX, () => scheduleRefresh())
  } catch {
    /* файла может не быть до первой смены раскладки */
  }

  // Редкий poll — страховка, если watch проглотил событие (atomic replace).
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => void refresh(), 5000)
}

export function stopKeyboardLayoutWatch(): void {
  if (debounce) clearTimeout(debounce)
  debounce = null
  watcher?.close()
  watcher = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  try {
    unsubNotification?.()
  } catch {
    /* ignore */
  }
  unsubNotification = null
  getWin = null
}
