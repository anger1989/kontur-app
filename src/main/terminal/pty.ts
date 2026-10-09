/**
 * Сессии псевдотерминала для встроенного терминала и ассистента.
 * Живут только в main: renderer шлёт ввод/resize и слушает data/exit.
 */
import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { CH } from '@shared/ipc'
import { logError, logInfo } from '../log'

const require = createRequire(import.meta.url)

const MAX_SCROLLBACK = 256 * 1024

export type PtyCreateOpts = {
  cols?: number
  rows?: number
  cwd?: string
  /**
   * Именованная сессия: повторный create с тем же key возвращает живой PTY
   * и накопленный scrollback (виджет ↔ окно ассистента).
   */
  key?: string
  /** `agent` — Cursor Agent CLI; иначе login-shell. */
  profile?: 'shell' | 'agent'
}

interface Session {
  id: string
  key?: string
  proc: IPty
  /** Сырой вывод для replay при повторном attach. */
  scrollback: string
  label: string
}

const sessions = new Map<string, Session>()
/** key → session id */
const byKey = new Map<string, string>()
let seq = 0

/** node-pty 1.1+ иногда кладёт spawn-helper без +x — без этого posix_spawnp падает. */
function ensureSpawnHelperExecutable(): void {
  try {
    const ptyPath = require.resolve('node-pty')
    const root = dirname(ptyPath)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates = [
      join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
      // asar.unpacked в бандле
      ptyPath.includes('app.asar')
        ? join(root.replace('app.asar', 'app.asar.unpacked'), 'prebuilds', `darwin-${arch}`, 'spawn-helper')
        : null
    ].filter((p): p is string => Boolean(p))

    for (const helper of candidates) {
      if (!existsSync(helper)) continue
      try {
        chmodSync(helper, 0o755)
      } catch {
        /* read-only install — best-effort */
      }
    }
  } catch {
    /* ignore */
  }
}

function shellPath(): string {
  const fromEnv = process.env.SHELL?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  return '/bin/bash'
}

function defaultCwd(): string {
  const home = homedir()
  return home && existsSync(home) ? home : process.cwd()
}

function canExec(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Абсолютный путь к `agent` / `cursor-agent` — из Dock PATH часто без ~/.local/bin. */
export function resolveAgentBinary(): string | null {
  const home = homedir()
  const candidates = [
    process.env.CURSOR_AGENT_PATH?.trim(),
    join(home, '.local/bin/agent'),
    join(home, '.local/bin/cursor-agent'),
    '/usr/local/bin/agent',
    '/opt/homebrew/bin/agent'
  ].filter((p): p is string => Boolean(p))

  for (const p of candidates) {
    if (existsSync(p) && canExec(p)) return p
  }

  // Последний шанс — имя из PATH текущего процесса.
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue
    for (const name of ['agent', 'cursor-agent']) {
      const p = join(dir, name)
      if (existsSync(p) && canExec(p)) return p
    }
  }
  return null
}

function appendScrollback(s: Session, chunk: string): void {
  s.scrollback += chunk
  if (s.scrollback.length > MAX_SCROLLBACK) {
    s.scrollback = s.scrollback.slice(s.scrollback.length - MAX_SCROLLBACK)
  }
}

function send(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

export type PtyCreateResult = {
  id: string
  shell: string
  scrollback: string
  reused: boolean
}

export function createPtySession(
  getWin: () => BrowserWindow | null,
  opts: PtyCreateOpts = {}
): PtyCreateResult {
  ensureSpawnHelperExecutable()

  const key = opts.key?.trim() || undefined
  if (key) {
    const existingId = byKey.get(key)
    const existing = existingId ? sessions.get(existingId) : undefined
    if (existing) {
      return {
        id: existing.id,
        shell: existing.label,
        scrollback: existing.scrollback,
        reused: true
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : defaultCwd()
  // Виджет ассистента ~12–16 рядов: clamp 8 завышал PTY → TUI + курсор «ниже» ввода.
  const cols = Math.max(2, opts.cols ?? 80)
  const rows = Math.max(2, opts.rows ?? 24)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Electron из Dock часто без ~/.local/bin — дописываем, если ещё нет.
  const localBin = join(homedir(), '.local/bin')
  if (existsSync(localBin) && !(env.PATH ?? '').split(':').includes(localBin)) {
    env.PATH = `${localBin}:${env.PATH ?? '/usr/bin:/bin'}`
  }

  const profile = opts.profile ?? (key === 'assistant' ? 'agent' : 'shell')
  let file: string
  let args: string[]
  let label: string

  if (profile === 'agent') {
    const agent = resolveAgentBinary()
    if (!agent) {
      throw new Error(
        'Не найден Cursor Agent CLI (`agent`). Установите cursor-agent или задайте CURSOR_AGENT_PATH.'
      )
    }
    file = agent
    // Интерактивный TUI; workspace = cwd сессии.
    args = ['--workspace', cwd]
    label = 'agent'
  } else {
    file = shellPath()
    args = ['-l']
    label = file
  }

  const id = `pty_${Date.now().toString(36)}_${(++seq).toString(36)}`
  let proc: IPty
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('terminal', `не удалось запустить ${file}: ${msg}`)
    throw new Error(`Не удалось запустить ${label}: ${msg}`)
  }

  const session: Session = { id, key, proc, scrollback: '', label }
  sessions.set(id, session)
  if (key) byKey.set(key, id)
  logInfo('terminal', `сессия ${id}${key ? ` [${key}]` : ''} → ${file} cwd=${cwd} ${cols}x${rows}`)

  proc.onData((data) => {
    appendScrollback(session, data)
    send(getWin(), CH.terminalData, id, data)
  })
  proc.onExit(({ exitCode, signal }) => {
    sessions.delete(id)
    if (key && byKey.get(key) === id) byKey.delete(key)
    logInfo('terminal', `сессия ${id} завершилась code=${exitCode} signal=${signal ?? ''}`)
    send(getWin(), CH.terminalExit, id, { exitCode, signal: signal ?? null })
  })

  return { id, shell: label, scrollback: '', reused: false }
}

export function writePty(id: string, data: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    /* уже закрыт */
  }
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (s.key && byKey.get(s.key) === id) byKey.delete(s.key)
  try {
    s.proc.kill()
  } catch {
    /* already dead */
  }
}

export function killAllPtys(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
