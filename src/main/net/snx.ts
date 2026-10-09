import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import type { VpnConfig } from '@shared/types'
import { logInfo, logWarn } from '../log'

const run = promisify(execFile)

export const SNX_TAG = 'v6.4.1'
const SNX_DMG_URL = `https://github.com/ancwrd1/snx-rs/releases/download/${SNX_TAG}/snx-rs-${SNX_TAG}-aarch64-apple-darwin.dmg`

export interface SnxTlsOpts {
  caCertPath?: string | null
  allowInsecureTls?: boolean
}

/** Каталог конфигов snx под управлением Kontur (не ~/.config/snx-rs). */
export function snxDir(): string {
  const dir = join(app.getPath('userData'), 'snx-rs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function snxConfPath(envId: string): string {
  return join(snxDir(), `${envId}.conf`)
}

function snxPidPath(envId: string): string {
  return join(snxDir(), `${envId}.pid`)
}

export interface SnxBins {
  snxRs: string | null
  snxctl: string | null
  /** Откуда взяли: bundled | system */
  source: 'bundled' | 'system' | 'missing'
}

export interface SnxAvailability {
  ok: boolean
  source: SnxBins['source']
  path: string | null
  /** LaunchDaemon / локальный сокет snxctl доступен (macOS: нужен .pkg). */
  service: boolean
}

const SERVICE_MISSING_RE =
  /error-no-service|Нет соединения со службой|No connection to service|No such file or directory|timed out while connecting to local socket/i

function isDarwin(): boolean {
  return process.platform === 'darwin'
}

function systemSnxPaths(): { snxctl: string | null; snxRs: string | null } {
  const ctlCandidates = [
    '/usr/local/bin/snxctl',
    '/opt/homebrew/bin/snxctl',
    join(process.env.HOME ?? '', '.local/bin/snxctl')
  ]
  const rsCandidates = [
    '/Library/Application Support/snx-rs/snx-rs',
    '/usr/local/bin/snx-rs',
    '/opt/homebrew/bin/snx-rs'
  ]
  return {
    snxctl: ctlCandidates.find((p) => existsSync(p)) ?? null,
    snxRs: rsCandidates.find((p) => existsSync(p)) ?? null
  }
}

/** Бинари: для connect на macOS важнее системный snxctl (говорит с LaunchDaemon). */
export function resolveSnxBins(): SnxBins {
  const system = systemSnxPaths()
  if (system.snxctl || system.snxRs) {
    return { snxctl: system.snxctl, snxRs: system.snxRs, source: 'system' }
  }

  const bundledDir = join(process.resourcesPath, 'snx-rs')
  const bundledCtl = join(bundledDir, 'snxctl')
  const bundledRs = join(bundledDir, 'snx-rs')
  if (existsSync(bundledCtl) || existsSync(bundledRs)) {
    return {
      snxctl: existsSync(bundledCtl) ? bundledCtl : null,
      snxRs: existsSync(bundledRs) ? bundledRs : null,
      source: 'bundled'
    }
  }

  return { snxctl: null, snxRs: null, source: 'missing' }
}

/** Бинарь для info/login-types: bundled snx-rs подходит (не нужен root). */
function resolveSnxInfoBin(): { exe: string; argsPrefix: string[] } | null {
  const bundledRs = join(process.resourcesPath, 'snx-rs', 'snx-rs')
  if (existsSync(bundledRs)) return { exe: bundledRs, argsPrefix: ['-m', 'info'] }
  const system = systemSnxPaths()
  if (system.snxRs) return { exe: system.snxRs, argsPrefix: ['-m', 'info'] }
  if (system.snxctl) return { exe: system.snxctl, argsPrefix: ['info'] }
  const bundledCtl = join(process.resourcesPath, 'snx-rs', 'snxctl')
  if (existsSync(bundledCtl)) return { exe: bundledCtl, argsPrefix: ['info'] }
  return null
}

async function snxServiceUp(snxctl: string): Promise<boolean> {
  try {
    await run(snxctl, ['status'], { timeout: 5_000 })
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return !SERVICE_MISSING_RE.test(msg)
  }
}

export async function snxAvailable(): Promise<SnxAvailability> {
  const b = resolveSnxBins()
  const path = b.snxctl ?? b.snxRs
  if (!path) return { ok: false, source: 'missing', path: null, service: false }
  let service = false
  if (b.snxctl) service = await snxServiceUp(b.snxctl)
  // LaunchDaemon может быть установлен, а snxctl ещё только bundled — проверим системный.
  if (!service) {
    const sys = systemSnxPaths().snxctl
    if (sys) service = await snxServiceUp(sys)
  }
  if (!service && isDarwin() && existsSync('/Library/LaunchDaemons/com.github.snx-rs.plist')) {
    service = true // plist есть; сокет может ещё подниматься
  }
  return { ok: true, source: b.source, path, service }
}

function installHint(): string {
  return (
    'На macOS snx-rs нуждается в root-службе (LaunchDaemon) из официального установщика. ' +
    `Поставьте SNX-RS.pkg (${SNX_TAG}): https://github.com/ancwrd1/snx-rs/releases/tag/${SNX_TAG} ` +
    '— затем снова «Подключить». Встроенные бинари Kontur умеют info/login-type, но туннель без службы не поднимают.'
  )
}

/** Открыть DMG установщика snx-rs (скачает во временный каталог при необходимости). */
export async function snxOpenInstaller(): Promise<void> {
  if (!isDarwin()) {
    throw new Error('Установщик .dmg только для macOS. На Linux: пакет из релизов snx-rs.')
  }
  const dest = join(app.getPath('temp'), `snx-rs-${SNX_TAG}.dmg`)
  if (!existsSync(dest)) {
    const { net } = await import('electron')
    await new Promise<void>((resolve, reject) => {
      const req = net.request(SNX_DMG_URL)
      const chunks: Buffer[] = []
      req.on('response', (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`Не скачать snx-rs DMG: HTTP ${res.statusCode}`))
          return
        }
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          try {
            writeFileSync(dest, Buffer.concat(chunks))
            resolve()
          } catch (e) {
            reject(e)
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }
  const err = await shell.openPath(dest)
  if (err) throw new Error(err)
}

/** Записать conf для env. Пароль — base64, как ждёт snx-rs. */
export function writeSnxConf(
  envId: string,
  vpn: VpnConfig,
  password: string | null,
  tls: SnxTlsOpts = {}
): string {
  if (!vpn.snxServer?.trim()) throw new Error('Не указан сервер snx-rs (snxServer)')
  if (!vpn.snxLoginType?.trim()) throw new Error('Не указан login-type snx-rs')

  const ca = tls.caCertPath?.trim()
  const lines = [
    `server-name=${vpn.snxServer.trim()}`,
    `login-type=${vpn.snxLoginType.trim()}`,
    vpn.username?.trim() ? `user-name=${vpn.username.trim()}` : null,
    password ? `password=${Buffer.from(password, 'utf8').toString('base64')}` : null,
    'default-route=false',
    'keychain=false',
    'no-dns=false',
    `log-level=info`,
    // Корпоративные gateway часто с внутренним/самоподписанным сертом.
    tls.allowInsecureTls ? 'ignore-server-cert=true' : null,
    ca && existsSync(ca) ? `ca-cert=${ca}` : null
  ].filter(Boolean) as string[]

  const path = snxConfPath(envId)
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
  return path
}

/** Список login-type с gateway (`snx-rs -m info -s host`). */
export async function snxLoginTypes(server: string, tls: SnxTlsOpts = {}): Promise<string[]> {
  const info = resolveSnxInfoBin()
  if (!info) {
    throw new Error(
      'snx-rs не найден. Переустановите Kontur (бинарь в комплекте) или поставьте SNX-RS.pkg.'
    )
  }
  const host = server.trim()
  if (!host) throw new Error('Укажите адрес сервера')

  const args = [...info.argsPrefix, '-s', host]
  if (tls.allowInsecureTls) args.push('-X', 'true')
  const ca = tls.caCertPath?.trim()
  if (ca && existsSync(ca)) args.push('-k', ca)

  try {
    const { stdout, stderr } = await run(info.exe, args, { timeout: 30_000 })
    const out = `${stdout}\n${stderr}`
    const types = new Set<string>()
    for (const m of out.matchAll(/\b(vpn_[\w-]+)\b/g)) types.add(m[1]!)
    for (const m of out.matchAll(/login[_-]type[=:\s]+(\S+)/gi)) {
      const v = m[1]!.replace(/[",']/g, '')
      if (v) types.add(v)
    }
    // Шорткат «vpn» без префикса тоже бывает.
    for (const m of out.matchAll(/\[([^\]]+)\]:\s*(vpn\w*)/g)) {
      if (m[2]) types.add(m[2])
    }
    return [...types]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/certificate was not trusted|certificate|CERT/i.test(msg)) {
      throw new Error(
        `Сертификат gateway не доверен. Включите «Доверять сертификатам контура» или укажите корпоративный CA. (${msg.slice(0, 200)})`
      )
    }
    throw new Error(`Не удалось получить login-type: ${msg}`)
  }
}

function pickSnxctl(): string | null {
  const system = systemSnxPaths().snxctl
  if (system) return system
  const bundled = join(process.resourcesPath, 'snx-rs', 'snxctl')
  return existsSync(bundled) ? bundled : null
}

export async function snxConnect(
  envId: string,
  vpn: VpnConfig,
  password: string | null,
  tls: SnxTlsOpts = {}
): Promise<void> {
  const conf = writeSnxConf(envId, vpn, password, tls)
  const snxctl = pickSnxctl()
  if (!snxctl) {
    throw new Error(installHint())
  }

  logInfo(
    'vpn',
    `snx-rs connect ${envId} via ${snxctl}` +
      (tls.allowInsecureTls ? ' (ignore-server-cert)' : '') +
      (tls.caCertPath ? ` ca=${tls.caCertPath}` : '')
  )

  try {
    const { stdout, stderr } = await run(snxctl, ['-c', conf, 'connect'], {
      timeout: Math.max(vpn.waitSeconds, 30) * 1000
    })
    const out = `${stdout}${stderr}`
    if (/error|failed|denied/i.test(out) && !/already connected/i.test(out)) {
      throw new Error(out.trim().slice(0, 400) || 'snxctl connect failed')
    }
    return
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/certificate was not trusted/i.test(msg) && !tls.allowInsecureTls && !tls.caCertPath) {
      throw new Error(
        'Сертификат vpn-gateway не доверен (The certificate was not trusted). ' +
          'В настройках контура включите «Доверять сертификатам контура без проверки» ' +
          'или укажите корпоративный CA — затем подключитесь снова.'
      )
    }
    if (SERVICE_MISSING_RE.test(msg) || /Эта программа должна быть запущена с правами root/i.test(msg)) {
      throw new Error(installHint())
    }
    throw new Error(msg.slice(0, 500))
  }
}

export async function snxDisconnect(envId: string): Promise<void> {
  const snxctl = pickSnxctl()
  const conf = snxConfPath(envId)

  if (snxctl && existsSync(conf)) {
    try {
      await run(snxctl, ['-c', conf, 'disconnect'], { timeout: 30_000 })
    } catch (e) {
      logWarn('vpn', `snxctl disconnect: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const pidFile = snxPidPath(envId)
  if (existsSync(pidFile)) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 0) process.kill(pid, 'SIGTERM')
    } catch {
      /* уже мёртв */
    }
    try {
      unlinkSync(pidFile)
    } catch {
      /* ignore */
    }
  }
}
