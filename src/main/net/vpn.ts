import { execFile } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { join, basename } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { EnvConfig, VpnState } from '@shared/types'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { health } from './health'
import { logInfo, logError } from '../log'
import { applySplitDns } from './dns'
import { parseTracInfo, type CheckpointSite } from './tracInfo'
import { snxAvailable, snxConnect, snxDisconnect, snxLoginTypes, snxOpenInstaller } from './snx'

const run = promisify(execFile)

/** Штатное место GUI-клиента Endpoint Security на macOS. */
const DEFAULT_CHECKPOINT_APP = '/Applications/Endpoint Security VPN.app'

/**
 * Запуск trac с закрытым stdin.
 *
 * Если клиенту не хватает данных (например, не передан код), он пытается
 * спросить их интерактивно. Через execFile это означало бы зависание до
 * таймаута: мы закрываем stdin, и клиент сразу получает EOF и внятно падает,
 * а не висит полторы минуты «в подключении».
 */
function runCli(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed)
      if (err && !timedOut && typeof (err as { code?: unknown }).code !== 'number') {
        reject(err)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), timedOut })
    })
    // Говорим клиенту, что интерактивного ввода не будет.
    child.stdin?.end()
  })
}

/**
 * Поднять GUI-клиент Endpoint Security, если он выключен.
 *
 * Демон-служба обычно работает всегда, но подключение к сайту с кодом Indeed
 * идёт через клиент: пока он не запущен, trac connect некому обслуживать.
 * open -a идемпотентен — если клиент уже открыт, просто выведет его вперёд.
 */
async function ensureClientRunning(appPath: string | null, waitSeconds: number): Promise<void> {
  const app = appPath || DEFAULT_CHECKPOINT_APP
  if (!existsSync(app)) {
    throw new Error(
      `Клиент Check Point не найден по пути ${app}. Укажите его в настройках контура.`
    )
  }

  // Уже запущен?
  if (await isRunning('Endpoint_Security_VPN')) return

  await run('open', ['-a', app]).catch((err: unknown) => {
    throw new Error(`Не удалось запустить клиент: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Клиенту нужно время на старт. Без этого первое же connect уйдёт впустую.
  const deadline = Date.now() + Math.min(waitSeconds, 20) * 1000
  while (Date.now() < deadline) {
    if (await isRunning('Endpoint_Security_VPN')) {
      // Небольшая пауза, чтобы клиент успел поднять свои сервисы.
      await new Promise((r) => setTimeout(r, 2000))
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Клиент Check Point не запустился за отведённое время — откройте его вручную и повторите')
}

async function isRunning(processName: string): Promise<boolean> {
  try {
    await run('pgrep', ['-x', processName])
    return true
  } catch {
    return false
  }
}

/**
 * Управление туннелями контуров.
 *
 * Важная граница: мы запускаем штатные клиенты и системные профили, а не
 * заменяем их. Multi-factor (Indeed, токен, push) пользователь подтверждает
 * сам — приложение лишь ждёт, пока сеть контура появится. Обход проверок
 * соответствия устройства здесь не делается и делаться не должен.
 */

const PROBE_EVERY_MS = 2000

/** Где лежит пароль контура в keychain. */
export const vpnSecretRef = (envId: string): string => `env.${envId}.vpn`

/**
 * Собираем argv из шаблона. Пара «флаг + значение» выбрасывается целиком,
 * если подставлять нечего: тогда клиент спросит недостающее сам, а не упадёт
 * на пустой строке.
 */
function buildArgs(template: string[], values: Record<string, string | null>): string[] {
  const out: string[] = []
  for (let i = 0; i < template.length; i++) {
    const arg = template[i]
    const key = /^\{(\w+)\}$/.exec(arg)?.[1]
    if (key && !values[key]) {
      // Значения нет — убираем и предшествующий флаг.
      if (out.length && out[out.length - 1].startsWith('-')) out.pop()
      continue
    }
    out.push(arg.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? ''))
  }
  return out
}

/** Состояние системного VPN-профиля macOS. Для остальных типов его не узнать. */
async function scutilState(profile: string): Promise<VpnState> {
  try {
    const { stdout } = await run('scutil', ['--nc', 'status', profile])
    const first = stdout.split('\n')[0]?.trim() ?? ''
    if (first.startsWith('Connected')) return 'connected'
    if (first.startsWith('Connecting')) return 'connecting'
    return 'disconnected'
  } catch {
    return 'disconnected'
  }
}

export async function vpnState(env: EnvConfig): Promise<VpnState> {
  if (env.vpn.kind === 'scutil' && env.vpn.profile) return scutilState(env.vpn.profile)
  if (env.vpn.kind === 'none') return 'unmanaged'
  // Для command и app состояние туннеля достоверно показывает только проба сети.
  const status = health.all().find((s) => s.envId === env.id)
  return status?.tunnel === 'up' ? 'connected' : 'disconnected'
}

/** Ждём, пока сеть контура ответит: при MFA это десятки секунд. */
async function waitForTunnel(env: EnvConfig, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if ((await health.probe(env.id)) === 'up') return true
    await new Promise((r) => setTimeout(r, PROBE_EVERY_MS))
  }
  return false
}

export async function connect(envId: string, otp?: string): Promise<VpnState> {
  const env = getConfig().envs.find((e) => e.id === envId)
  if (!env) throw new Error(`Контур ${envId} не найден`)

  const { vpn } = env
  if (vpn.kind === 'none') return 'unmanaged'
  if ((await vpnState(env)) === 'connected' && (await health.probe(envId)) === 'up') {
    return 'connected'
  }

  logInfo('vpn', `подключение ${envId} (${vpn.kind})`)
  health.setVpn(envId, 'connecting')
  // Официальный Check Point держит один сайт — гасим только соседние checkpoint.
  // snx-rs / OpenVPN живут параллельно и соседа не роняют.
  if (vpn.kind === 'checkpoint') {
    health.invalidateSiblings(envId, { onlyKinds: ['checkpoint'] })
  }

  try {
    switch (vpn.kind) {
      case 'scutil':
        if (!vpn.profile) throw new Error('Не указан профиль VPN')
        await run('scutil', ['--nc', 'start', vpn.profile])
        break

      case 'command':
        if (!vpn.command) throw new Error('Не указана команда подключения')
        // Без shell: аргументы передаются массивом, подстановки не происходит.
        await run(vpn.command, vpn.args, { timeout: vpn.waitSeconds * 1000 })
        break

      case 'app': {
        if (!vpn.appPath) throw new Error('Не указан путь к клиенту')
        await run('open', ['-a', vpn.appPath])
        if (vpn.appleScript) {
          // Даём клиенту отрисовать окно, прежде чем нажимать «Connect».
          await new Promise((r) => setTimeout(r, 1500))
          await run('osascript', ['-e', vpn.appleScript])
        }
        break
      }

      case 'openvpn': {
        // Предпочитаем Tunnelblick: у него есть привилегированный помощник, и
        // пароль не спрашивается каждый раз. Иначе — openvpn напрямую с разовым
        // запросом прав администратора (tun-устройство и маршруты требуют root).
        if (vpn.profile) {
          await run('osascript', [
            '-e',
            `tell application "Tunnelblick" to connect "${vpn.profile.replace(/"/g, '')}"`
          ])
        } else if (vpn.ovpnPath) {
          if (!existsSync(vpn.ovpnPath)) throw new Error(`Профиль не найден: ${vpn.ovpnPath}`)
          const bin = existsSync('/opt/homebrew/sbin/openvpn')
            ? '/opt/homebrew/sbin/openvpn'
            : '/usr/local/sbin/openvpn'
          if (!existsSync(bin)) {
            throw new Error('openvpn не найден. Установите его (brew install openvpn) или используйте Tunnelblick.')
          }

          // macOS (TCC) не даёт root-процессу читать ~/Desktop, ~/Documents и
          // ~/Downloads, поэтому запуск openvpn от root падал с «Error opening
          // configuration file». Копируем профиль в служебную папку приложения
          // (вне TCC) — сертификаты в .ovpn inline, так что копия самодостаточна.
          const dir = join(app.getPath('userData'), 'vpn')
          mkdirSync(dir, { recursive: true })
          const safe = join(dir, `${envId}-${basename(vpn.ovpnPath)}`)
          try {
            copyFileSync(vpn.ovpnPath, safe)
            chmodSync(safe, 0o600)
          } catch (err) {
            throw new Error(
              `Не удалось прочитать профиль: ${err instanceof Error ? err.message : String(err)}. ` +
                'Если файл на Рабочем столе — macOS мог запросить доступ: разрешите и повторите, ' +
                'либо переложите .ovpn в другую папку или подключите через Tunnelblick.'
            )
          }

          // Запуск в фоне под root через системный диалог прав; логи в /tmp.
          const cmd = `${bin} --config ${JSON.stringify(safe)} --cd ${JSON.stringify(dir)} --daemon --log /tmp/kontur-openvpn-${envId}.log`
          await run('osascript', [
            '-e',
            `do shell script ${JSON.stringify(cmd)} with administrator privileges`
          ])
        } else {
          throw new Error('Укажите имя конфигурации Tunnelblick или путь к .ovpn в настройках контура')
        }
        break
      }

      case 'checkpoint': {
        if (!vpn.site) throw new Error('Не указано имя сайта')
        if (vpn.cliPath) {
          // Сначала поднимаем клиент, если он выключен, — иначе connect зависнет.
          await ensureClientRunning(vpn.appPath, vpn.waitSeconds)

          // Штатный CLI клиента: trac connect -s <site> -u <user> -p <password>.
          // Пароль берём из keychain в момент вызова и нигде не держим.
          // Код живёт только внутри этого вызова: ни в конфиге, ни в keychain,
          // ни в логах его нет и быть не должно.
          const args = buildArgs(vpn.cliArgs, {
            site: vpn.site,
            user: vpn.username,
            password: getSecret(vpnSecretRef(envId)),
            code: otp ?? null
          })
          const { stdout, stderr, timedOut } = await runCli(
            vpn.cliPath,
            args,
            vpn.waitSeconds * 1000
          )
          if (timedOut) {
            throw new Error(
              'Клиент не ответил вовремя. ' +
                (vpn.requiresOtp
                  ? 'Подтвердите Indeed/MFA в клиенте или на телефоне — Kontur ждёт сеть.'
                  : 'Проверьте, запущен ли клиент Check Point.')
            )
          }
          const out = `${stdout}${stderr}`
          // trac сообщает об отказе текстом, а не кодом возврата.
          if (/failed|error|wrong|invalid|denied/i.test(out)) {
            throw new Error(out.trim().split('\n').slice(0, 3).join(' ').slice(0, 300))
          }
        } else {
          await ensureClientRunning(vpn.appPath, vpn.waitSeconds)
          if (!vpn.appleScript) {
            throw new Error(
              'Для сайта Check Point нужен либо CLI клиента, либо AppleScript: ' +
                'найдите клиент кнопкой «Прочитать сайты из клиента» в настройках контура'
            )
          }
          await run('osascript', ['-e', vpn.appleScript.replaceAll('{site}', vpn.site)])
        }
        break
      }

      case 'snx-rs': {
        await snxConnect(envId, vpn, getSecret(vpnSecretRef(envId)), {
          caCertPath: env.caCertPath,
          allowInsecureTls: env.allowInsecureTls
        })
        break
      }
    }
  } catch (err) {
    health.setVpn(envId, 'disconnected')
    throw new Error(
      `Не удалось запустить подключение: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const up = await waitForTunnel(env, vpn.waitSeconds)
  const state: VpnState = up ? 'connected' : 'disconnected'
  health.setVpn(envId, state)
  if (up) logInfo('vpn', `${envId} поднят`)
  else logError('vpn', `${envId} не поднялся за ${vpn.waitSeconds} с`)
  if (!up) {
    throw new Error(
      `Контур «${env.name}» не поднялся за ${vpn.waitSeconds} с. ` +
        'Если клиент ждёт подтверждения многофакторной аутентификации — подтвердите и повторите.'
    )
  }

  // Контур поднят — закрепляем его домены за его серверами имён, чтобы при
  // двух поднятых туннелях они резолвились независимо от основного резолвера.
  await applySplitDns(env).catch((err) =>
    logError('vpn', `split-DNS для ${envId} не применён: ${err instanceof Error ? err.message : String(err)}`)
  )

  // Перепроверить остальные: иначе соседний контур ещё минуту висит «доступен».
  await health.probeAll()
  return state
}

export async function disconnect(envId: string): Promise<VpnState> {
  const env = getConfig().envs.find((e) => e.id === envId)
  if (!env) throw new Error(`Контур ${envId} не найден`)

  const { vpn } = env
  if (vpn.kind === 'scutil' && vpn.profile) {
    await run('scutil', ['--nc', 'stop', vpn.profile])
  } else if (vpn.kind === 'openvpn') {
    if (vpn.profile) {
      await run('osascript', [
        '-e',
        `tell application "Tunnelblick" to disconnect "${vpn.profile.replace(/"/g, '')}"`
      ])
    } else {
      // Прямой openvpn: гасим по лог-имени процесса конфига.
      await run('pkill', ['-f', `kontur-openvpn-${envId}`]).catch(() => undefined)
    }
  } else if (vpn.kind === 'snx-rs') {
    await snxDisconnect(envId)
  } else if (vpn.kind === 'checkpoint') {
    const cli = vpn.cliPath
    if (!cli) throw new Error('Нет пути к trac — отключите сайт в клиенте Check Point')
    const args = vpn.site
      ? ['disconnect', '-s', vpn.site]
      : ['disconnect']
    const { stdout, stderr } = await runCli(cli, args, 30_000)
    const out = `${stdout}${stderr}`
    if (/failed|error|denied/i.test(out) && !/not connected|already/i.test(out)) {
      throw new Error(out.trim().slice(0, 300) || 'trac disconnect failed')
    }
  } else if (vpn.kind === 'none') {
    return 'unmanaged'
  } else {
    throw new Error('Этот тип VPN пока отключается во внешнем клиенте')
  }

  health.setVpn(envId, 'disconnected')
  await health.probe(envId, { interactive: false }).catch(() => undefined)
  return 'disconnected'
}

/**
 * Поднять все включённые VPN-контуры по порядку (bank → остальные).
 * OTP передаётся map'ой envId → code; для Indeed push код не нужен.
 */
export async function connectBoth(
  otps: Record<string, string | undefined> = {}
): Promise<EnvVerification[]> {
  const envs = getConfig().envs.filter((e) => e.enabled && e.vpn.kind !== 'none')
  const checkpointCount = envs.filter((e) => e.vpn.kind === 'checkpoint').length
  if (checkpointCount > 1) {
    throw new Error(
      'Два контура с официальным Check Point параллельно не работают. ' +
        'Для второго выберите VPN «snx-rs» (встроенный) или Tunnelblick.'
    )
  }
  // bank первым — Indeed; потом snx/openvpn.
  const ordered = [...envs].sort((a, b) => {
    const rank = (id: string): number => (id === 'bank' ? 0 : id === 'ecom' ? 1 : 2)
    return rank(a.id) - rank(b.id)
  })

  for (const env of ordered) {
    await connect(env.id, otps[env.id])
  }
  return verifyAll()
}

/**
 * Поднять оба контура. Строго последовательно: если обоим нужен
 * многофакторный вход, два запроса подтверждения одновременно — верный способ
 * подтвердить не тот.
 */
export interface EnvVerification {
  envId: string
  up: boolean
}

/**
 * Перепроверка всех контуров после подъёма.
 *
 * Check Point держит один сайт за раз, и подключение второго может уронить
 * первый. Пользователь должен узнать об этом прямо, а не обнаружить сам.
 */
export async function verifyAll(): Promise<EnvVerification[]> {
  const envs = getConfig().envs.filter((e) => e.enabled && e.vpn.kind !== 'none')
  const out: EnvVerification[] = []
  for (const env of envs) {
    // По одному, без параллельного шторма — и без UI-checking на соседях.
    const up = (await health.probe(env.id, { interactive: false })) === 'up'
    if (!up) health.setVpn(env.id, 'disconnected')
    out.push({ envId: env.id, up })
  }
  return out
}

/* ── Поиск клиента Check Point ───────────────────────────────────── */

const APP_CANDIDATES = [
  '/Applications/Endpoint Security VPN.app',
  '/Applications/Check Point Endpoint Security VPN.app',
  '/Applications/CheckPoint/Endpoint Security VPN.app'
]

const CLI_CANDIDATES = [
  // Штатное место CLI клиента Endpoint Security на macOS.
  '/Library/Application Support/Checkpoint/Endpoint Connect/trac',
  '/usr/local/bin/trac',
  '/usr/bin/trac',
  '/opt/checkpoint/bin/trac'
]

export interface CheckpointDiscovery {
  apps: string[]
  /** Исполняемые файлы, похожие на CLI: внутри бандла и в системных путях. */
  executables: string[]
  /** Путь к trac, если найден. */
  cli: string | null
  /** Что клиент сам рассказывает про свои подключения. */
  sites: CheckpointSite[]
}

export async function discoverCheckpoint(): Promise<CheckpointDiscovery> {
  const apps = APP_CANDIDATES.filter((p) => existsSync(p))
  const executables = CLI_CANDIDATES.filter((p) => existsSync(p))

  for (const app of apps) {
    const macos = join(app, 'Contents', 'MacOS')
    if (!existsSync(macos)) continue
    try {
      for (const name of readdirSync(macos)) executables.push(join(macos, name))
    } catch {
      // Нет доступа к бандлу — не повод ронять поиск.
    }
  }

  const cli = executables.find((p) => p.endsWith('/trac')) ?? null

  // Клиент сам знает свои сайты и логины — спрашиваем его, а не гадаем.
  let sites: CheckpointSite[] = []
  if (cli) {
    try {
      const { stdout } = await run(cli, ['info'], { timeout: 15_000 })
      sites = parseTracInfo(stdout)
    } catch {
      // Служба не запущена или нет прав — просто не предлагаем автозаполнение.
    }
  }

  return { apps, executables, cli, sites }
}

/** Контуры, помеченные «поднимать при старте». */
export async function autoConnectOnLaunch(): Promise<void> {
  // Indeed/OTP: диалог кода при старте показать некому, но connect всё равно
  // запускаем — пользователь подтверждает push, мы ждём health (waitSeconds).
  const envs = getConfig()
    .envs.filter((e) => e.enabled && e.vpn.autoConnect && e.vpn.kind !== 'none')
    .sort((a, b) => (a.id === 'bank' ? -1 : b.id === 'bank' ? 1 : 0))
  for (const env of envs) {
    await connect(env.id).catch(() => {
      // Молча: при старте это фоновая попытка, состояние и так видно в интерфейсе.
    })
  }
}

export { snxAvailable, snxLoginTypes, snxOpenInstaller }
