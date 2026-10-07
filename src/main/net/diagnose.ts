import { request } from 'undici'
import { getConfig } from '../config/store'
import { getSecret } from '../config/secrets'
import { dispatcherFor } from './transport'
import { health } from './health'
import { connectorFor } from '../connectors/registry'
import { easDnsProbe } from '../connectors/eas/dns'
import { logInfo, logError, withTimeout } from '../log'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface DiagnosticStep {
  label: string
  status: CheckStatus
  detail: string
}

export interface Diagnosis {
  serviceId: string
  steps: DiagnosticStep[]
  /** Короткий человеческий вывод: где именно проблема. */
  verdict: string
}

/** Расшифровка сетевых ошибок Node/undici в понятную причину. */
function explainNetworkError(err: unknown): { detail: string; hint: string } {
  const code = (err as NodeJS.ErrnoException)?.code ?? ''
  const msg = err instanceof Error ? err.message : String(err)

  if (/ENOTFOUND|EAI_AGAIN/.test(code))
    return { detail: `Имя хоста не разрешается (${code})`, hint: 'DNS не отвечает — почти всегда это значит, что туннель до контура не поднят.' }
  if (/ECONNREFUSED/.test(code))
    return { detail: 'Соединение отклонено (ECONNREFUSED)', hint: 'Порт закрыт или сервис не слушает по этому адресу. Проверьте URL.' }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|headers timeout|ConnectTimeout/i.test(code + msg))
    return { detail: 'Таймаут подключения', hint: 'Сеть контура недоступна — вероятно, активен другой сайт VPN или туннель не поднят.' }
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|CERT_|certificate/i.test(code + msg))
    return { detail: `Сертификат не доверенный (${code || 'TLS'})`, hint: 'Это внутренний сертификат контура. Включите «Доверять сертификатам контура» в его настройках — или укажите корпоративный CA.' }
  return { detail: msg.slice(0, 160), hint: 'Непредвиденная сетевая ошибка.' }
}

/**
 * Пошаговая проверка сервиса: по порядку туннель → сеть/TLS → HTTP → данные.
 * Отвечает на «почему пусто» конкретикой, а не общим «не работает».
 */
export async function diagnoseService(serviceId: string): Promise<Diagnosis> {
  logInfo('diagnose', `старт проверки ${serviceId}`)
  const cfg = getConfig()
  const service = cfg.services.find((s) => s.id === serviceId)
  const steps: DiagnosticStep[] = []
  if (!service) return { serviceId, steps, verdict: 'Сервис не найден' }
  const env = cfg.envs.find((e) => e.id === service.envId)
  if (!env) return { serviceId, steps, verdict: 'Контур не найден' }

  // 1. Адрес задан?
  if (!service.baseUrl) {
    steps.push({ label: 'Адрес', status: 'fail', detail: 'Не задан базовый URL' })
    return { serviceId, steps, verdict: 'Укажите адрес сервиса в настройках' }
  }
  steps.push({ label: 'Адрес', status: 'ok', detail: service.baseUrl })

  // 2. Туннель контура.
  const tunnel = await health.probe(env.id)
  if (env.healthCheckUrl) {
    const err = health.all().find((s) => s.envId === env.id)?.lastError
    steps.push({
      label: 'Туннель',
      status: tunnel === 'up' ? 'ok' : 'fail',
      detail:
        tunnel === 'up'
          ? `Контур «${env.name}» доступен (${env.healthCheckUrl})`
          : `Контур «${env.name}» недоступен: ${err ?? 'нет ответа на адрес проверки'}`
    })
  } else {
    steps.push({ label: 'Туннель', status: 'skip', detail: 'Адрес проверки контура не задан' })
  }

  // 3. Сеть + TLS + HTTP.
  let httpOk = false
  try {
    const started = Date.now()
    const res = await request(service.baseUrl, {
      method: 'GET',
      dispatcher: dispatcherFor(env),
      headersTimeout: 8000,
      bodyTimeout: 8000
    })
    res.body.dump().catch(() => {})
    const ms = Date.now() - started
    const code = res.statusCode
    // 2xx/3xx/401/403 — сервер отвечает, сеть и TLS в порядке.
    const reachable = code < 500
    steps.push({
      label: 'Сеть и TLS',
      status: 'ok',
      detail: `Сервер ответил за ${ms} мс`
    })
    steps.push({
      label: 'HTTP-ответ',
      status: reachable ? 'ok' : 'warn',
      detail:
        code === 401 || code === 403
          ? `${code} — сервер требует авторизацию (это нормально для веб-клиента)`
          : code >= 300 && code < 400
            ? `${code} — редирект, обычно на страницу входа`
            : `${code}`
    })
    httpOk = reachable
  } catch (err) {
    const { detail, hint } = explainNetworkError(err)
    logError('diagnose', `${serviceId}: сеть/TLS — ${detail}`)
    steps.push({ label: 'Сеть и TLS', status: 'fail', detail })
    return { serviceId, steps, verdict: hint }
  }

  // 4. Данные через API — только если для сервиса есть коннектор.
  const connector = connectorFor(service.kind)
  if (!connector) {
    steps.push({
      label: 'Синхронизация',
      status: 'skip',
      detail: 'Для этого сервиса пока нет коннектора — список наполняться не будет, но веб-клиент работает'
    })
    return {
      serviceId,
      steps,
      verdict: httpOk
        ? 'Веб-клиент доступен. Автосинхронизации для этого сервиса ещё нет — поэтому список пуст.'
        : 'Веб-клиент отвечает с ошибкой, смотрите шаги выше.'
    }
  }

  // 5. Токен/пароль на месте?
  const secret = getSecret(`${service.id}.secret`)
  if (service.auth.kind !== 'none' && service.auth.kind !== 'cookie' && !secret) {
    steps.push({ label: 'Доступ', status: 'fail', detail: 'Не задан токен или пароль' })
    return { serviceId, steps, verdict: 'Укажите токен или пароль в настройках сервиса' }
  }

  // Пароль почты часто путают с VPN / SSO.
  if (service.kind === 'mail' && secret) {
    const vpnSecret = getSecret(`env.${env.id}.vpn`)
    if (vpnSecret && vpnSecret === secret) {
      steps.push({
        label: 'Пароль почты',
        status: 'warn',
        detail:
          'Совпадает с паролем VPN. Для ActiveSync обычно нужен доменный пароль или пароль приложения из веб-клиента, не пароль VPN.'
      })
    }
  }

  // 5b. EAS DNS: при VPN предпочитаем системный (intranet), публичный — fallback.
  if (service.kind === 'mail' && (service.options.protocol ?? 'eas') === 'eas') {
    try {
      const easUrl =
        service.options.easUrl?.trim() ||
        `${service.baseUrl.replace(/\/$/, '')}/Microsoft-Server-ActiveSync`
      const host = new URL(easUrl).hostname
      const dns = await easDnsProbe(host)
      if (dns.systemPrivate && dns.preferred === 'system') {
        steps.push({
          label: 'EAS DNS',
          status: 'ok',
          detail: `${host} → ${dns.system} (intranet, VPN). Публичный ${dns.public ?? '—'} — запасной`
        })
      } else if (dns.systemPrivate) {
        steps.push({
          label: 'EAS DNS',
          status: 'warn',
          detail: `Система: ${dns.system} (intranet). Уйдём на публичный ${dns.public ?? '?'}`
        })
      } else {
        steps.push({
          label: 'EAS DNS',
          status: 'ok',
          detail: `${host} → ${dns.system ?? dns.public ?? '?'}`
        })
      }
    } catch (err) {
      steps.push({
        label: 'EAS DNS',
        status: 'warn',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // 6. Пробная синхронизация. Для EAS — только Provision+FolderSync (быстро),
  // полный Sync писем в diagnose слишком долгий и давал Headers Timeout на публичном VIP.
  try {
    logInfo('diagnose', `${serviceId}: пробная синхронизация`)
    if (service.kind === 'mail' && (service.options.protocol ?? 'eas') === 'eas') {
      const { createEasClient } = await import('../connectors/eas')
      const client = await withTimeout(
        createEasClient({ env, service, secret, cursor: null }),
        18_000,
        'EAS вход'
      )
      const folders = await withTimeout(client.folderSync(), 12_000, 'EAS FolderSync')
      logInfo('diagnose', `${serviceId}: EAS ок, папок ${folders.length}`)
      steps.push({
        label: 'Синхронизация',
        status: 'ok',
        detail: `EAS вошёл, папок: ${folders.length}`
      })
      return {
        serviceId,
        steps,
        verdict: folders.length > 0 ? 'Всё работает — ActiveSync отвечает.' : 'Вход прошёл, папок пока нет.'
      }
    }

    const { items } = await withTimeout(
      connector.sync({ env, service, secret, cursor: null }),
      20_000,
      'синхронизация'
    )
    logInfo('diagnose', `${serviceId}: получено записей ${items.length}`)
    steps.push({
      label: 'Синхронизация',
      status: 'ok',
      detail: `Получено записей: ${items.length}`
    })
    return {
      serviceId,
      steps,
      verdict:
        items.length > 0
          ? 'Всё работает — данные приходят.'
          : 'Соединение и доступ в порядке, но сервер вернул пусто. Возможно, нет непрочитанного или не тот аккаунт.'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logError('diagnose', `${serviceId}: синхронизация не удалась — ${msg}`)
    steps.push({ label: 'Синхронизация', status: 'fail', detail: msg.slice(0, 200) })
    return { serviceId, steps, verdict: `Не удалось получить данные: ${msg.slice(0, 160)}` }
  }
}
