/**
 * Сессии псевдотерминала (zsh) для встроенного терминала.
 * Живут только в main: renderer шлёт ввод/resize и слушает data/exit.
 */
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { CH } from '@shared/ipc'
import { logError, logInfo } from '../log'

const require = createRequire(import.meta.url)

interface Session {
  id: string
  proc: IPty
}

const sessions = new Map<string, Session>()
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

function send(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

export function createPtySession(
  getWin: () => BrowserWindow | null,
  opts: { cols?: number; rows?: number; cwd?: string } = {}
): { id: string; shell: string } {
  ensureSpawnHelperExecutable()

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')
  const shell = shellPath()
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : defaultCwd()
  const cols = Math.max(20, opts.cols ?? 80)
  const rows = Math.max(8, opts.rows ?? 24)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Обычный login-shell: echo/raw mode оставляем шелу и TUI (vim, agent…).
  const args = ['-l']

  const id = `pty_${Date.now().toString(36)}_${(++seq).toString(36)}`
  let proc: IPty
  try {
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('terminal', `не удалось запустить ${shell}: ${msg}`)
    throw new Error(`Не удалось запустить оболочку: ${msg}`)
  }

  const session: Session = { id, proc }
  sessions.set(id, session)
  logInfo('terminal', `сессия ${id} → ${shell} cwd=${cwd} ${cols}x${rows}`)

  proc.onData((data) => send(getWin(), CH.terminalData, id, data))
  proc.onExit(({ exitCode, signal }) => {
    sessions.delete(id)
    logInfo('terminal', `сессия ${id} завершилась code=${exitCode} signal=${signal ?? ''}`)
    send(getWin(), CH.terminalExit, id, { exitCode, signal: signal ?? null })
  })

  return { id, shell }
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
    s.proc.resize(Math.max(20, cols), Math.max(8, rows))
  } catch {
    /* уже закрыт */
  }
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.proc.kill()
  } catch {
    /* already dead */
  }
}

export function killAllPtys(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
