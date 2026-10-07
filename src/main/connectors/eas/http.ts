import { Agent, request, type Dispatcher } from 'undici'
import { net, session as electronSession, type Session } from 'electron'
import type { EnvConfig } from '@shared/types'
import { easLookup } from './dns'

export type EasAuthMode = 'basic' | 'negotiate'

/**
 * HTTP для EAS.
 *
 * Как AAS: прямой TLS (без HTTP-прокси контура). DNS — системный при VPN
 * (intranet 10.x), публичный только если системный не резолвит.
 * Basic через undici. Negotiate/NTLM — через Electron net, login один раз.
 */
export async function easHttpPost(opts: {
  url: string
  body: Buffer
  headers: Record<string, string>
  user: string
  password: string
  env: EnvConfig
  authMode: EasAuthMode
  /** Сколько ждать заголовков ответа, мс. По умолчанию 12 с (чтение). */
  headersTimeout?: number
}): Promise<{ status: number; buffer: Buffer; wwwAuth: string }> {
  if (opts.authMode === 'basic') {
    return postBasicUndici(opts)
  }
  return postNegotiateElectron(opts)
}

/** Отдельный агент: без ProxyAgent, с easLookup. CA/insecure — из env. */
const agents = new Map<string, { key: string; agent: Agent }>()

function easAgent(env: EnvConfig): Dispatcher {
  const key = `${env.caCertPath ?? ''}|${env.allowInsecureTls ? '1' : '0'}`
  const hit = agents.get(env.id)
  if (hit && hit.key === key) return hit.agent

  const connect: Agent.Options['connect'] = {
    lookup: easLookup as never,
    rejectUnauthorized: !env.allowInsecureTls
  }

  const agent = new Agent({ connect, connectTimeout: 8_000 })
  void hit?.agent.close().catch(() => {})
  agents.set(env.id, { key, agent })
  return agent
}

/** Рвём EAS-агенты при выходе — иначе undici держит libuv handles. */
export async function closeEasAgents(): Promise<void> {
  const pending = [...agents.values()].map((v) => Promise.resolve(v.agent.destroy()).catch(() => {}))
  agents.clear()
  await Promise.all(pending)
}

async function postBasicUndici(opts: {
  url: string
  body: Buffer
  headers: Record<string, string>
  user: string
  password: string
  env: EnvConfig
  headersTimeout?: number
}): Promise<{ status: number; buffer: Buffer; wwwAuth: string }> {
  const res = await request(opts.url, {
    method: 'POST',
    dispatcher: easAgent(opts.env),
    headers: {
      ...opts.headers,
      authorization: `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`
    },
    body: opts.body,
    headersTimeout: opts.headersTimeout ?? 12_000,
    bodyTimeout: 30_000
  })
  const www = String(res.headers['www-authenticate'] ?? '')
  const buffer = Buffer.from(await res.body.arrayBuffer())
  return { status: res.statusCode, buffer, wwwAuth: www }
}

async function postNegotiateElectron(opts: {
  url: string
  body: Buffer
  headers: Record<string, string>
  user: string
  password: string
  env: EnvConfig
}): Promise<{ status: number; buffer: Buffer; wwwAuth: string }> {
  const ses = sessionFor(opts.env)

  return new Promise((resolve, reject) => {
    let settled = false
    let loginAttempts = 0

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      if (/TOO_MANY_RETRIES|ERR_INVALID_AUTH|401/i.test(err.message)) {
        reject(
          new Error(
            'EAS отклонил вход (NTLM). Проверьте доменный пароль AD / пароль почты.'
          )
        )
        return
      }
      reject(err)
    }

    const req = net.request({
      method: 'POST',
      url: opts.url,
      session: ses,
      useSessionCookies: false
    })

    for (const [k, v] of Object.entries(opts.headers)) {
      if (k.toLowerCase() === 'authorization') continue
      req.setHeader(k, v)
    }

    req.on('login', (_authInfo, callback) => {
      if (loginAttempts++ === 0) {
        callback(opts.user, opts.password)
      } else {
        callback()
      }
    })

    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
      res.on('end', () => {
        if (settled) return
        settled = true
        const www = header(res.headers, 'www-authenticate')
        resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), wwwAuth: www })
      })
    })

    req.write(opts.body)
    req.end()
  })
}

function header(headers: Record<string, string | string[]>, name: string): string {
  const v = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(v)) return v.join(', ')
  return v ?? ''
}

const patched = new Set<string>()

function sessionFor(env: EnvConfig): Session {
  const ses = electronSession.fromPartition(`eas:${env.partition}`)
  if (patched.has(env.id)) return ses
  patched.add(env.id)

  if (env.allowInsecureTls) {
    ses.setCertificateVerifyProc((_req, callback) => callback(0))
  }
  // EAS — без прокси контура (AAS тоже чистит HTTP_PROXY).
  void ses.setProxy({ mode: 'direct' })
  return ses
}
