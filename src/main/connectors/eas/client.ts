import { randomUUID } from 'node:crypto'
import type { EnvConfig } from '@shared/types'
import { decode, el, elOpaque, encode, find, findAll, text, type El, type Node } from './wbxml'
import { easHttpPost } from './http'
import { logInfo, logWarn } from '../../log'

/** Как AAS Mail / outlook-activesync-mcp: 16.1 обоим (Stalwart терпит). */
export const EAS_PROTOCOL_VERSION = '16.1'
/** DeviceType вендора outlook-activesync-mcp (AAS). */
export const EAS_DEVICE_TYPE = 'MCP'
/** UA вендора AAS. */
export const EAS_USER_AGENT = 'outlook-activesync-mcp/0.1'

/** User= в query — без DOMAIN\ (как Settings.query_user в AAS). */
export function easQueryUser(username: string): string {
  const u = username.trim()
  if (u.includes('\\')) return u.split('\\').pop() ?? u
  if (u.includes('/')) return u.split('/').pop() ?? u
  return u
}

/**
 * Очередь запросов на одно EAS-устройство (сервер + DeviceId).
 *
 * Exchange обрабатывает запросы одного устройства по одному: пока идёт фоновый
 * синк (десятки Sync-страниц, ~40 с), запрос «создать встречу» с того же
 * DeviceId ждал на стороне сервера и падал по нашему headersTimeout (12 с) —
 * «Headers Timeout Error». Теперь очередь у нас: запросы устройства идут по
 * одному, а действия пользователя встают перед фоновым синком — ждут максимум
 * текущую страницу, а не весь синк. Таймаут меряет уже только сам запрос.
 */
export type EasPriority = 'interactive' | 'background'

interface Lane {
  busy: boolean
  waiting: { priority: EasPriority; go: () => void }[]
  /** До этого момента фоновые запросы ждут: действие пользователя ещё не закончено. */
  holdUntil: number
  timer: ReturnType<typeof setTimeout> | null
}
const lanes = new Map<string, Lane>()

/**
 * Окно после запроса пользователя, в которое фон не влезает. Действие — это
 * несколько запросов подряд (создать встречу: вход → папки → ключ → прогрев →
 * добавление); без окна между каждыми двумя вклинивалась страница синка, и
 * встреча «висела» ~40 с.
 */
const INTERACTIVE_HOLD_MS = 2000

/**
 * Команды записи, которые Exchange выполняет синхронно и заметно дольше чтения:
 * SendMail отдаёт письмо в транспорт, MeetingResponse рассылает ответ
 * организатору. 12 с на заголовки для них мало — ждём 45 с.
 */
const SLOW_COMMANDS = new Set(['SendMail', 'SmartReply', 'SmartForward', 'MeetingResponse'])

function pump(lane: Lane): void {
  if (lane.busy || !lane.waiting.length) return
  const i = lane.waiting.findIndex((w) => w.priority === 'interactive')
  if (i < 0) {
    const wait = lane.holdUntil - Date.now()
    if (wait > 0) {
      if (!lane.timer) {
        lane.timer = setTimeout(() => {
          lane.timer = null
          pump(lane)
        }, wait)
      }
      return
    }
  }
  const next = i >= 0 ? lane.waiting.splice(i, 1)[0]! : lane.waiting.shift()!
  lane.busy = true
  next.go()
}

async function inLane<T>(key: string, priority: EasPriority, fn: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key)
  if (!lane) {
    lane = { busy: false, waiting: [], holdUntil: 0, timer: null }
    lanes.set(key, lane)
  }
  const l = lane
  await new Promise<void>((go) => {
    l.waiting.push({ priority, go })
    pump(l)
  })
  try {
    return await fn()
  } finally {
    l.busy = false
    if (priority === 'interactive') l.holdUntil = Date.now() + INTERACTIVE_HOLD_MS
    pump(l)
  }
}

/**
 * PolicyKey — один на устройство и учётку, общий для всех экземпляров клиента.
 * Раньше каждое действие (встреча, письмо, GAL) создавало клиента и заново
 * провиженило устройство; сервер Ecom на каждый Provision выдаёт новый ключ, и
 * параллельные запросы со старым получали 449 и провиженили снова — по кругу.
 */
const policyKeys = new Map<string, string>()

/** Таймауты undici → понятная причина вместо «Headers Timeout Error». */
function humanizeTransportError(command: string, err: unknown): Error {
  const e = err as { code?: string; message?: string; name?: string }
  const msg = e?.message ?? String(err)
  if (
    e?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    e?.code === 'UND_ERR_BODY_TIMEOUT' ||
    /headers timeout|body timeout/i.test(msg)
  ) {
    return new Error(`Exchange не ответил вовремя (${command}) — сервер перегружен или недоступен. Повторите через минуту.`)
  }
  return err instanceof Error ? err : new Error(msg)
}

/**
 * Клиент Exchange ActiveSync (EAS) 16.1 — как AAS / outlook-activesync-mcp.
 *
 * Basic: полный логин (`DOMAIN\user` или email).
 * Query User=: только account без домена.
 */
export class EasClient {
  private authMode: 'basic' | 'negotiate' = 'basic'
  /** Действия пользователя по умолчанию; фоновый синк ставит 'background'. */
  priority: EasPriority = 'interactive'

  private get laneKey(): string {
    return `${this.endpoint}|${this.deviceId}`
  }
  private get policyCacheKey(): string {
    return `${this.endpoint}|${this.deviceId}|${this.user}`
  }
  private get policyKey(): string {
    return policyKeys.get(this.policyCacheKey) ?? '0'
  }
  private set policyKey(key: string) {
    policyKeys.set(this.policyCacheKey, key)
  }
  /** Устройство уже провижено под этой учёткой (в этом запуске приложения). */
  hasPolicy(): boolean {
    return policyKeys.has(this.policyCacheKey)
  }

  constructor(
    private readonly endpoint: string,
    /** Полный логин для Basic (DOMAIN\user или email). */
    private readonly user: string,
    private readonly password: string,
    private readonly deviceId: string,
    private readonly env: EnvConfig,
    private readonly deviceType = EAS_DEVICE_TYPE,
    private readonly protocolVersion = EAS_PROTOCOL_VERSION
  ) {}

  private async cmd(
    command: string,
    body: El,
    opts: { policyKey?: string; retried?: boolean } = {}
  ): Promise<Node | null> {
    const retried = opts.retried ?? false
    const policyKey = opts.policyKey ?? this.policyKey
    const queryUser = easQueryUser(this.user)
    const url =
      `${this.endpoint}?Cmd=${command}&User=${encodeURIComponent(queryUser)}` +
      `&DeviceId=${this.deviceId}&DeviceType=${encodeURIComponent(this.deviceType)}`

    const headers: Record<string, string> = {
      'content-type': 'application/vnd.ms-sync.wbxml',
      accept: 'application/vnd.ms-sync.wbxml',
      'ms-asprotocolversion': this.protocolVersion,
      'x-ms-policykey': policyKey,
      'user-agent': EAS_USER_AGENT,
      'accept-encoding': 'identity'
    }

    let res: Awaited<ReturnType<typeof easHttpPost>>
    try {
      res = await inLane(this.laneKey, this.priority, () =>
        easHttpPost({
          url,
          body: encode(body),
          headers,
          user: this.user,
          password: this.password,
          env: this.env,
          authMode: this.authMode,
          headersTimeout: SLOW_COMMANDS.has(command) ? 45_000 : undefined
        })
      )
    } catch (err) {
      throw humanizeTransportError(command, err)
    }

    if (res.status === 401) {
      if (
        this.authMode === 'basic' &&
        !retried &&
        /ntlm|negotiate/i.test(res.wwwAuth)
      ) {
        logWarn('mail', `EAS 401 Basic (WWW-Authenticate: NTLM) → negotiate`)
        this.authMode = 'negotiate'
        return this.cmd(command, body, { ...opts, retried: true })
      }
      throw new Error(
        /ntlm|negotiate/i.test(res.wwwAuth)
          ? 'EAS отклонил вход (401/NTLM). Проверьте доменный пароль AD.'
          : 'EAS отклонил вход (401). Проверьте логин (email или DOMAIN\\user) и пароль. Для app-password — пароль приложения из веб-клиента, не SSO.'
      )
    }

    if (res.status === 449) {
      if (command === 'Provision' || retried) {
        throw new Error('EAS требует провизию устройства (449), повтор не помог')
      }
      // Пока запрос ждал, другой клиент этого устройства уже перепровизил его —
      // просто повторяем с новым общим ключом, не выбивая его новым Provision.
      if (this.policyKey !== policyKey) {
        return this.cmd(command, body, { ...opts, policyKey: undefined, retried: true })
      }
      logWarn('mail', 'EAS 449 — перепровизия устройства')
      await this.provision()
      return this.cmd(command, body, { ...opts, retried: true })
    }

    if (res.status >= 400) {
      throw new Error(
        `EAS ${command}: HTTP ${res.status} ${res.buffer.toString('utf8').slice(0, 120)}`
      )
    }

    if (res.buffer.length === 0) return null
    return decode(res.buffer)
  }

  /**
   * Двухфазный Provision как AAS: DeviceInformation обязателен;
   * phase2 шлёт temp PolicyKey и в заголовке X-MS-PolicyKey.
   */
  async provision(): Promise<void> {
    const deviceInfo = el(18, 'DeviceInformation', [
      el(18, 'Set', [
        el(18, 'Model', this.deviceType),
        el(18, 'FriendlyName', 'outlook-activesync-mcp'),
        el(18, 'OS', 'MCP'),
        el(18, 'UserAgent', EAS_USER_AGENT)
      ])
    ])

    const phase1 = el(14, 'Provision', [
      deviceInfo,
      el(14, 'Policies', [
        el(14, 'Policy', [el(14, 'PolicyType', 'MS-EAS-Provisioning-WBXML')])
      ])
    ])
    const r1 = await this.cmd('Provision', phase1, { policyKey: '0' })
    const status1 = text(r1, 'Status')
    const tempKey = text(r1, 'PolicyKey')

    // Status 2 = политика на сервере не задана — ключ 0 допустим.
    if (status1 === '2' || (!tempKey && status1 === '1')) {
      this.policyKey = '0'
      logInfo('mail', `EAS: политика не требуется (Status=${status1 ?? '?'}), PolicyKey=0`)
      return
    }
    if (!tempKey) {
      throw new Error(`EAS Provision phase1 без PolicyKey (Status=${status1 ?? '?'})`)
    }

    const phase2 = el(14, 'Provision', [
      el(14, 'Policies', [
        el(14, 'Policy', [
          el(14, 'PolicyType', 'MS-EAS-Provisioning-WBXML'),
          el(14, 'PolicyKey', tempKey),
          el(14, 'Status', '1')
        ])
      ])
    ])
    // Как AAS: X-MS-PolicyKey на phase2 = временный ключ, не 0.
    const r2 = await this.cmd('Provision', phase2, { policyKey: tempKey })
    const finalKey = text(r2, 'PolicyKey')
    this.policyKey = finalKey || tempKey
    logInfo('mail', `EAS: устройство провижено, PolicyKey=${this.policyKey.slice(0, 8)}…`)
  }

  /** SyncKey последнего FolderSync — нужен для FolderCreate. */
  private folderSyncKey = '0'

  async folderSync(): Promise<{ serverId: string; type: string; name: string; parentId: string }[]> {
    const doc = el(7, 'FolderSync', [el(7, 'SyncKey', '0')])
    const resp = await this.cmd('FolderSync', doc)
    const status = text(resp, 'Status')
    if (status === '142' || status === '144' || status === '143') {
      logWarn('mail', `EAS FolderSync Status=${status} — перепровизия`)
      await this.provision()
      const retry = await this.cmd('FolderSync', doc)
      this.folderSyncKey = text(retry, 'SyncKey') ?? '0'
      return mapFolders(retry)
    }
    this.folderSyncKey = text(resp, 'SyncKey') ?? '0'
    return mapFolders(resp)
  }

  /**
   * Создать пользовательскую почтовую папку (Type=12).
   * parentServerId — ServerId родителя; «0» = корень mailbox.
   */
  async folderCreate(parentServerId: string, name: string): Promise<string> {
    if (this.folderSyncKey === '0') await this.folderSync()
    const doc = el(7, 'FolderCreate', [
      el(7, 'SyncKey', this.folderSyncKey),
      el(7, 'ParentId', parentServerId || '0'),
      el(7, 'DisplayName', name),
      el(7, 'Type', '12')
    ])
    const resp = await this.cmd('FolderCreate', doc)
    const status = text(resp, 'Status')
    if (status && status !== '1') {
      throw new Error(`EAS FolderCreate Status=${status}`)
    }
    this.folderSyncKey = text(resp, 'SyncKey') ?? this.folderSyncKey
    const serverId = text(resp, 'ServerId')
    if (!serverId) throw new Error('EAS FolderCreate: нет ServerId в ответе')
    return serverId
  }

  /** Переместить письма между коллекциями (MoveItems). */
  async moveItems(
    srcCollectionId: string,
    serverIds: string[],
    dstCollectionId: string
  ): Promise<{ srcMsgId: string; dstMsgId: string }[]> {
    if (!serverIds.length) return []
    const moves = serverIds.map((id) =>
      el(5, 'Move', [
        el(5, 'SrcMsgId', id),
        el(5, 'SrcFldId', srcCollectionId),
        el(5, 'DstFldId', dstCollectionId)
      ])
    )
    const doc = el(5, 'MoveItems', moves)
    const resp = await this.cmd('MoveItems', doc)
    const out: { srcMsgId: string; dstMsgId: string }[] = []
    for (const r of findAll(resp, 'Response')) {
      const st = text(r, 'Status')
      // 3 = Success
      if (st && st !== '3' && st !== '1') {
        throw new Error(`EAS MoveItems Status=${st}`)
      }
      const src = text(r, 'SrcMsgId')
      const dst = text(r, 'DstMsgId')
      if (src) out.push({ srcMsgId: src, dstMsgId: dst ?? src })
    }
    return out
  }

  private async primeSync(collectionId: string): Promise<string> {
    // Как AAS: без Class — класс определяется типом папки.
    const doc = el(0, 'Sync', [
      el(0, 'Collections', [
        el(0, 'Collection', [el(0, 'SyncKey', '0'), el(0, 'CollectionId', collectionId)])
      ])
    ])
    const resp = await this.cmd('Sync', doc)
    return text(resp, 'SyncKey') ?? '0'
  }

  async syncItems(
    collectionId: string,
    opts: {
      windowSize?: number
      filterType?: string
      bodyBytes?: number
      /** Макс. страниц при MoreAvailable (календарь часто >1). */
      maxPages?: number
      /** HTML BodyPreference (почта). Календарю обычно не нужен. */
      wantHtml?: boolean
    } = {}
  ): Promise<{ adds: Node[]; complete: boolean }> {
    let syncKey = await this.primeSync(collectionId)
    // Пустой ключ — договориться с сервером не вышло: выдачи нет и она не полная.
    if (syncKey === '0') return { adds: [], complete: false }

    const windowSize = opts.windowSize ?? 100
    const filterType = opts.filterType ?? '5'
    const bodyBytes = opts.bodyBytes ?? 20_480
    const maxPages = opts.maxPages ?? 8
    const wantHtml = opts.wantHtml ?? false

    const optionsChildren: El[] = [el(0, 'FilterType', filterType), el(0, 'MIMESupport', '0')]
    if (bodyBytes > 0) {
      optionsChildren.push(
        el(17, 'BodyPreference', [el(17, 'Type', '1'), el(17, 'TruncationSize', String(bodyBytes))])
      )
      if (wantHtml) {
        optionsChildren.push(
          el(17, 'BodyPreference', [el(17, 'Type', '2'), el(17, 'TruncationSize', String(bodyBytes))])
        )
      }
    }

    // Status=4 (Protocol error) часто из‑за BodyPreference/HTML на папках
    // вроде Drafts — один раз упрощаем Options до FilterType.
    let activeOptions = optionsChildren
    let minimalTried = false

    const adds: Node[] = []
    /**
     * Выдача дочитана до конца и без единой ошибки. Только тогда по ней можно
     * чистить локальную копию: на усечённом ответе это стёрло бы живые записи.
     */
    let complete = false
    let hadError = false
    for (let page = 0; page < maxPages; page++) {
      const coll: El[] = [
        el(0, 'SyncKey', syncKey),
        el(0, 'CollectionId', collectionId),
        el(0, 'GetChanges'),
        el(0, 'WindowSize', String(windowSize)),
        el(0, 'Options', activeOptions)
      ]
      const doc = el(0, 'Sync', [el(0, 'Collections', [el(0, 'Collection', coll)])])
      const resp = await this.cmd('Sync', doc)
      const status = text(resp, 'Status')
      if (status && status !== '1') {
        hadError = true
        logWarn('mail', `EAS Sync Status=${status} для ${collectionId}`)
        if (status === '3' || status === '12' || status === '14') {
          // Invalid sync key / folder — перепрайм один раз.
          syncKey = await this.primeSync(collectionId)
          if (syncKey === '0') break
          continue
        }
        if (status === '4' && !minimalTried) {
          minimalTried = true
          activeOptions = [el(0, 'FilterType', filterType), el(0, 'MIMESupport', '0')]
          syncKey = await this.primeSync(collectionId)
          if (syncKey === '0') break
          page -= 1
          continue
        }
        if (status === '4') break
      }
      adds.push(...findAll(resp, 'Add'))
      const nextKey = text(resp, 'SyncKey')
      if (nextKey) syncKey = nextKey
      const more = find(resp, 'MoreAvailable') != null
      if (!more) {
        complete = true
        break
      }
    }
    return { adds, complete: complete && !hadError }
  }

  async fetchItem(collectionId: string, serverId: string): Promise<Node | null> {
    const doc = el(20, 'ItemOperations', [
      el(20, 'Fetch', [
        el(20, 'Store', 'Mailbox'),
        el(0, 'CollectionId', collectionId),
        el(0, 'ServerId', serverId),
        el(20, 'Options', [
          el(17, 'BodyPreference', [el(17, 'Type', '2'), el(17, 'TruncationSize', '200000')]),
          el(17, 'BodyPreference', [el(17, 'Type', '1'), el(17, 'TruncationSize', '200000')])
        ])
      ])
    ])
    const resp = await this.cmd('ItemOperations', doc)
    const status = text(resp, 'Status')
    if (status && status !== '1') {
      throw new Error(`EAS ItemOperations Status=${status}`)
    }
    return findAll(resp, 'Properties')[0] ?? findAll(resp, 'Fetch').find((f) => findAll(f, 'Body').length) ?? null
  }

  /** Пометить письмо прочитанным через Sync/Change (Read=1). */
  async markRead(collectionId: string, serverId: string): Promise<void> {
    const syncKey = await this.primeSync(collectionId)
    if (syncKey === '0') throw new Error('EAS: нет SyncKey для markRead')
    const doc = el(0, 'Sync', [
      el(0, 'Collections', [
        el(0, 'Collection', [
          el(0, 'SyncKey', syncKey),
          el(0, 'CollectionId', collectionId),
          el(0, 'Commands', [
            el(0, 'Change', [
              el(0, 'ServerId', serverId),
              el(0, 'ApplicationData', [el(2, 'Read', '1')])
            ])
          ])
        ])
      ])
    ])
    const resp = await this.cmd('Sync', doc)
    const status = text(resp, 'Status')
    // Collection Status 1 = ok; иногда Status лежит глубже.
    if (status && status !== '1' && status !== '8') {
      // 8 = Object not found — письмо уже удалили, не фатально.
      logWarn('mail', `EAS markRead Status=${status} for ${serverId}`)
    }
  }

  async sendMail(mime: string, clientId: string): Promise<void> {
    // Mime — непрозрачный блок (WBXML OPAQUE), не строка: MS-ASCMD «Mime» —
    // «transferred as an opaque BLOB». Сервер Ecom прощал строку, Exchange банка
    // на такой запрос молчал до таймаута — письма из банковского ящика не уходили.
    const doc = el(21, 'SendMail', [
      el(21, 'ClientId', clientId),
      el(21, 'SaveInSentItems'),
      elOpaque(21, 'Mime', Buffer.from(mime, 'utf8'))
    ])
    const resp = await this.cmd('SendMail', doc)
    const status = text(resp, 'Status')
    if (status && status !== '1') {
      throw new Error(`EAS SendMail Status=${status}`)
    }
  }

  /**
   * Sync Add в коллекцию (создание встречи). Возвращает ServerId.
   * Как AAS: без GetChanges на write-раунде.
   * Перед Add — один read-раунд после SyncKey=0, иначе часть серверов
   * отдаёт Status=3/6 на «сыром» ключе.
   */
  async syncAdd(collectionId: string, applicationData: El): Promise<string> {
    let syncKey = await this.primeSync(collectionId)
    if (syncKey === '0') throw new Error('EAS: нет SyncKey для создания события')

    // Read-раунд: закрепляем ключ (WindowSize=0 — только ключ, без выгрузки).
    {
      const warmup = el(0, 'Sync', [
        el(0, 'Collections', [
          el(0, 'Collection', [
            el(0, 'SyncKey', syncKey),
            el(0, 'CollectionId', collectionId),
            el(0, 'GetChanges'),
            el(0, 'WindowSize', '0')
          ])
        ])
      ])
      const warmResp = await this.cmd('Sync', warmup)
      const next = text(warmResp, 'SyncKey')
      if (next && next !== '0') syncKey = next
    }

    const clientId = cryptoRandomId()
    const doc = el(0, 'Sync', [
      el(0, 'Collections', [
        el(0, 'Collection', [
          el(0, 'SyncKey', syncKey),
          el(0, 'CollectionId', collectionId),
          el(0, 'Commands', [
            el(0, 'Add', [el(0, 'ClientId', clientId), applicationData])
          ])
        ])
      ])
    ])
    const resp = await this.cmd('Sync', doc)
    // Responses>Add с нашим ClientId
    const adds = findAll(resp, 'Add')
    const hit =
      adds.find((a) => text(a, 'ClientId') === clientId) ??
      adds.find((a) => text(a, 'ServerId')) ??
      null
    const status = text(hit, 'Status') ?? text(resp, 'Status')
    if (status && status !== '1') {
      throw new Error(`EAS Sync Add Status=${status}`)
    }
    const serverId = text(hit, 'ServerId')
    if (!serverId) throw new Error('EAS: сервер не вернул ServerId после создания')
    return serverId
  }

  /**
   * Ответ на приглашение: 1 accept / 2 tentative / 3 decline.
   * instanceCompact — `20261002T090000Z` для одного вхождения серии.
   */
  /**
   * Ключ синхронизации папки, «догнанный» до конца: все страницы GetChanges.
   * Нужен, если сервер не узнаёт ServerId при свежем ключе (Status 8) — Exchange
   * ведёт состояние устройства и про элементы, которые устройству не выдавал,
   * может ответить «не найден».
   */
  private async caughtUpSyncKey(collectionId: string): Promise<string> {
    let syncKey = await this.primeSync(collectionId)
    for (let page = 0; page < 30 && syncKey !== '0'; page++) {
      const doc = el(0, 'Sync', [
        el(0, 'Collections', [
          el(0, 'Collection', [
            el(0, 'SyncKey', syncKey),
            el(0, 'CollectionId', collectionId),
            el(0, 'GetChanges'),
            el(0, 'WindowSize', '100'),
            el(0, 'Options', [el(0, 'FilterType', '0')])
          ])
        ])
      ])
      const resp = await this.cmd('Sync', doc)
      const next = text(resp, 'SyncKey')
      if (next) syncKey = next
      if (find(resp, 'MoreAvailable') == null) break
    }
    return syncKey
  }

  /** Один Sync с командой по существующему элементу. Статус элемента ('1' — ок). */
  private async syncCommand(collectionId: string, command: El, caughtUp = false): Promise<string> {
    let syncKey = caughtUp ? await this.caughtUpSyncKey(collectionId) : await this.primeSync(collectionId)
    if (syncKey === '0') throw new Error('EAS: нет SyncKey для изменения календаря')
    if (!caughtUp) {
      // Как в syncAdd: закрепляем ключ пустым GetChanges.
      const warm = await this.cmd(
        'Sync',
        el(0, 'Sync', [
          el(0, 'Collections', [
            el(0, 'Collection', [
              el(0, 'SyncKey', syncKey),
              el(0, 'CollectionId', collectionId),
              el(0, 'GetChanges'),
              el(0, 'WindowSize', '0')
            ])
          ])
        ])
      )
      const next = text(warm, 'SyncKey')
      if (next && next !== '0') syncKey = next
    }
    const resp = await this.cmd(
      'Sync',
      el(0, 'Sync', [
        el(0, 'Collections', [
          el(0, 'Collection', [
            el(0, 'SyncKey', syncKey),
            el(0, 'CollectionId', collectionId),
            // Conflict=0 — «побеждает клиент». По умолчанию Exchange выбирает
            // серверную версию и отвечает Status=7, хотя пользователь только
            // что осознанно нажал «отменить» или «сохранить»: его действие и
            // есть последняя правда. Порядок элементов важен — Options строго
            // перед Commands (MS-ASCMD, схема Collection).
            el(0, 'Options', [el(0, 'Conflict', '0')]),
            el(0, 'Commands', [command])
          ])
        ])
      ])
    )
    // Ответ по элементу приходит только при ошибке (MS-ASCMD Change/Delete).
    const itemStatus = text(find(resp, 'Responses'), 'Status')
    const status = itemStatus ?? text(resp, 'Status') ?? '1'
    // 8 — сервер не знает элемент при свежем ключе, 7 — у него есть не выданные
    // нам изменения по нему. Оба лечатся одним: догнать папку до конца и повторить.
    if ((status === '8' || status === '7') && !caughtUp) {
      return this.syncCommand(collectionId, command, true)
    }
    return status
  }

  /** ISO-дата вхождения для airsyncbase:InstanceId из компактного ключа (20261007T100000Z). */
  private static instanceIso(compact: string): string | null {
    const ms = parseCompactToMs(compact)
    if (ms == null) return null
    return new Date(ms).toISOString()
  }

  /**
   * Изменить встречу (Sync Change). В 16.x отсутствующие поля не трогаются,
   * а приглашённым изменения рассылает сам сервер. `instanceCompact` — одно
   * вхождение повторяющейся встречи (ServerId серии + InstanceId).
   */
  async syncChange(
    collectionId: string,
    serverId: string,
    applicationData: El,
    instanceCompact?: string
  ): Promise<void> {
    const children: El[] = [el(0, 'ServerId', serverId)]
    const iso = instanceCompact ? EasClient.instanceIso(instanceCompact) : null
    if (iso) children.push(el(17, 'InstanceId', iso))
    children.push(applicationData)
    const status = await this.syncCommand(collectionId, el(0, 'Change', children))
    if (status !== '1') throw new Error(`EAS Sync Change Status=${status}`)
  }

  /**
   * Удалить встречу (Sync Delete). Для встречи, где вы организатор, сервер 16.x
   * сам рассылает участникам отмену. `instanceCompact` — только это вхождение.
   */
  async syncDelete(collectionId: string, serverId: string, instanceCompact?: string): Promise<void> {
    const children: El[] = [el(0, 'ServerId', serverId)]
    const iso = instanceCompact ? EasClient.instanceIso(instanceCompact) : null
    if (iso) children.push(el(17, 'InstanceId', iso))
    const status = await this.syncCommand(collectionId, el(0, 'Delete', children))
    // 8 — уже удалена на сервере: цель достигнута.
    if (status !== '1' && status !== '8') throw new Error(`EAS Sync Delete Status=${status}`)
  }

  async meetingRespond(
    collectionId: string,
    requestId: string,
    userResponse: '1' | '2' | '3',
    opts: { instanceCompact?: string; notify?: boolean } = {}
  ): Promise<void> {
    const children: El[] = [
      el(8, 'UserResponse', userResponse),
      el(8, 'CollectionId', collectionId),
      el(8, 'RequestId', requestId)
    ]
    if (opts.instanceCompact) {
      // InstanceId — ISO с миллисекундами (AAS format_datetime millis=0).
      const ms = parseCompactToMs(opts.instanceCompact)
      if (ms != null) {
        const d = new Date(ms)
        const p = (n: number): string => String(n).padStart(2, '0')
        const iso =
          `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
          `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000Z`
        children.push(el(8, 'InstanceId', iso))
      }
    }
    if (opts.notify !== false) children.push(el(8, 'SendResponse'))

    const doc = el(8, 'MeetingResponse', [el(8, 'Request', children)])
    const resp = await this.cmd('MeetingResponse', doc)
    const result = findAll(resp, 'Result')[0] ?? null
    const status = text(result, 'Status') ?? text(resp, 'Status')
    if (status && status !== '1') {
      throw new Error(`EAS MeetingResponse Status=${status}`)
    }
  }

  /**
   * Поиск в GAL (Search Store=GAL). Пустой query → [].
   * Stalwart/часть серверов могут не уметь GAL — тогда пусто, UI возьмёт локальный кэш.
   */
  async searchGal(
    query: string,
    limit = 12
  ): Promise<{ email: string; name: string }[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const range = `0-${Math.max(0, Math.min(limit, 25) - 1)}`
    const doc = el(15, 'Search', [
      el(15, 'Store', [
        el(15, 'Name', 'GAL'),
        el(15, 'Query', q),
        el(15, 'Options', [el(15, 'Range', range)])
      ])
    ])
    try {
      const resp = await this.cmd('Search', doc)
      const status = text(resp, 'Status')
      // 1 = success; 10+ иногда «нет результатов» — не ошибка.
      if (status && status !== '1' && status !== '10') {
        logWarn('mail', `EAS GAL Search Status=${status}`)
        return []
      }
      const out: { email: string; name: string }[] = []
      const seen = new Set<string>()
      for (const props of findAll(resp, 'Properties')) {
        const email = (text(props, 'EmailAddress') ?? '').trim().toLowerCase()
        if (!email || !email.includes('@') || seen.has(email)) continue
        seen.add(email)
        const name =
          (text(props, 'DisplayName') ?? '').trim() ||
          [text(props, 'FirstName'), text(props, 'LastName')].filter(Boolean).join(' ') ||
          email.split('@')[0] ||
          email
        out.push({ email, name })
      }
      return out
    } catch (e) {
      logWarn('mail', `EAS GAL Search: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /**
   * Free/busy через ResolveRecipients Availability.
   * MergedFreeBusy — строка цифр, слот = 30 мин от startMs.
   * 0 free · 1 tentative · 2 busy · 3 oof · 4 unknown
   */
  async resolveAvailability(
    emails: string[],
    startMs: number,
    endMs: number
  ): Promise<{ email: string; name: string; merged: string }[]> {
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))]
    if (!unique.length || !(endMs > startMs)) return []

    const toIso = (ms: number): string => {
      const d = new Date(ms)
      const p = (n: number): string => String(n).padStart(2, '0')
      return (
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
        `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000Z`
      )
    }

    const children: El[] = unique.map((e) => el(10, 'To', e))
    children.push(
      el(10, 'Options', [
        el(10, 'Availability', [
          el(10, 'StartTime', toIso(startMs)),
          el(10, 'EndTime', toIso(endMs))
        ])
      ])
    )
    const doc = el(10, 'ResolveRecipients', children)
    try {
      const resp = await this.cmd('ResolveRecipients', doc)
      const out: { email: string; name: string; merged: string }[] = []
      for (const response of findAll(resp, 'Response')) {
        const to = (text(response, 'To') ?? '').trim().toLowerCase()
        const recipients = findAll(response, 'Recipient')
        // Берём первого unambiguous / первого с email.
        const hit =
          recipients.find((r) => (text(r, 'EmailAddress') ?? '').includes('@')) ??
          recipients[0] ??
          null
        const email = ((text(hit, 'EmailAddress') ?? to) || '').trim().toLowerCase()
        if (!email) continue
        const name = (text(hit, 'DisplayName') ?? '').trim() || email.split('@')[0] || email
        const merged = (text(hit, 'MergedFreeBusy') ?? text(response, 'MergedFreeBusy') ?? '').trim()
        out.push({ email, name, merged })
      }
      return out
    } catch (e) {
      logWarn('mail', `EAS Availability: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }
}

function cryptoRandomId(): string {
  return randomUUID().replace(/-/g, '')
}

function parseCompactToMs(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/i.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, hh, mm, ss] = m
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)
}

function mapFolders(
  resp: Node | null
): { serverId: string; type: string; name: string; parentId: string }[] {
  return findAll(resp, 'Add').map((add) => ({
    serverId: text(add, 'ServerId') ?? '',
    type: text(add, 'Type') ?? '',
    name: text(add, 'DisplayName') ?? '',
    parentId: text(add, 'ParentId') ?? '0'
  }))
}

export { find, findAll, text } from './wbxml'
export type { Node } from './wbxml'
