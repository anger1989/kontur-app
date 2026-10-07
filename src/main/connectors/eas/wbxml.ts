/**
 * Минимальный кодек WBXML для Exchange ActiveSync (MS-ASWBXML).
 *
 * EAS гоняет не обычный XML, а его бинарную форму. Реализуем ровно то, что нужно
 * для Provision → FolderSync → Sync: нужные кодовые страницы и токены тегов.
 */

/* Токены тегов по кодовым страницам (имя → код). Значения из MS-ASWBXML. */
const PAGES: Record<number, Record<string, number>> = {
  // 0 — AirSync
  0: {
    Sync: 0x05, Responses: 0x06, Add: 0x07, Change: 0x08, Delete: 0x09, Fetch: 0x0a,
    SyncKey: 0x0b, ClientId: 0x0c, ServerId: 0x0d, Status: 0x0e, Collection: 0x0f,
    Class: 0x10, CollectionId: 0x12, GetChanges: 0x13, MoreAvailable: 0x14,
    WindowSize: 0x15, Commands: 0x16, Options: 0x17, FilterType: 0x18,
    Conflict: 0x1b, Collections: 0x1c, ApplicationData: 0x1d, DeletesAsMoves: 0x1e,
    Supported: 0x20, SoftDelete: 0x21, MIMESupport: 0x22, MIMETruncation: 0x23,
    Wait: 0x24, Limit: 0x25, Partial: 0x26, ConversationMode: 0x27, MaxItems: 0x28,
    HeartbeatInterval: 0x29
  },
  // 2 — Email
  2: {
    DateReceived: 0x0f, DisplayTo: 0x11, Importance: 0x12, MessageClass: 0x13,
    Subject: 0x14, Read: 0x15, To: 0x16, Cc: 0x17, From: 0x18, ReplyTo: 0x19
  },
  // 5 — Move (MoveItems)
  5: {
    MoveItems: 0x05, Move: 0x06, SrcMsgId: 0x07, SrcFldId: 0x08, DstFldId: 0x09,
    Response: 0x0a, Status: 0x0b, DstMsgId: 0x0c
  },
  // 4 — Calendar (токены как MS-ASWBXML / AAS — иначе StartTime=0x27 читается как 0x27)
  4: {
    TimeZone: 0x05, AllDayEvent: 0x06, Attendees: 0x07, Attendee: 0x08,
    AttendeeEmail: 0x09, AttendeeName: 0x0a, BusyStatus: 0x0d,
    Categories: 0x0e, Category: 0x0f, DtStamp: 0x11, EndTime: 0x12,
    Exception: 0x13, Exceptions: 0x14, Deleted: 0x15, ExceptionStartTime: 0x16,
    Location: 0x17, MeetingStatus: 0x18, OrganizerEmail: 0x19, OrganizerName: 0x1a,
    Recurrence: 0x1b, Type: 0x1c, Until: 0x1d, Occurrences: 0x1e, Interval: 0x1f,
    DayOfWeek: 0x20, DayOfMonth: 0x21, WeekOfMonth: 0x22, MonthOfYear: 0x23,
    Reminder: 0x24, Sensitivity: 0x25, Subject: 0x26, StartTime: 0x27, UID: 0x28,
    AttendeeStatus: 0x29, AttendeeType: 0x2a,
    // По MS-ASWBXML (Code Page 4). Раньше тут стояли 0x2b/0x2c — ответ сервера
    // ResponseType (0x36) не распознавался, и «принята/под вопросом» терялись.
    DisallowNewTimeProposal: 0x33, ResponseRequested: 0x34, AppointmentReplyTime: 0x35,
    ResponseType: 0x36, CalendarType: 0x37, IsLeapMonth: 0x38, FirstDayOfWeek: 0x39,
    OnlineMeetingConfLink: 0x3a, OnlineMeetingExternalLink: 0x3b,
    ClientUid: 0x3c
  },
  // 8 — MeetingResponse (принять / отклонить / под вопросом)
  8: {
    CalId: 0x05, CollectionId: 0x06, MeetingResponse: 0x07, RequestId: 0x08,
    Request: 0x09, Result: 0x0a, Status: 0x0b, UserResponse: 0x0c,
    InstanceId: 0x0e, SendResponse: 0x12
  },
  // 10 — ResolveRecipients (GAL resolve + Availability / free-busy)
  10: {
    ResolveRecipients: 0x05, Response: 0x06, Status: 0x07, Type: 0x08,
    Recipient: 0x09, DisplayName: 0x0a, EmailAddress: 0x0b,
    Certificates: 0x0c, Certificate: 0x0d, SerialNumber: 0x0f,
    Options: 0x11, To: 0x12, CertificateRetrieval: 0x13,
    RecipientCount: 0x14, MaxCertificates: 0x15, MaxAmbiguousRecipients: 0x16,
    CertificateCount: 0x17, Availability: 0x18, StartTime: 0x19,
    EndTime: 0x1a, MergedFreeBusy: 0x1b
  },
  // 15 — Search (GAL query)
  15: {
    Search: 0x05, Store: 0x07, Name: 0x08, Query: 0x09, Options: 0x0a,
    Range: 0x0b, Status: 0x0c, Response: 0x0d, Result: 0x0e,
    Properties: 0x0f, Total: 0x10, EqualTo: 0x11, Value: 0x12,
    And: 0x13, Or: 0x14, FreeText: 0x15, DeepTraversal: 0x17,
    LongId: 0x18, RebuildResults: 0x19
  },
  // 16 — GAL properties в ответе Search
  16: {
    DisplayName: 0x05, Phone: 0x06, Office: 0x07, Title: 0x08,
    Company: 0x09, Alias: 0x0a, FirstName: 0x0b, LastName: 0x0c,
    HomePhone: 0x0d, MobilePhone: 0x0e, EmailAddress: 0x0f
  },
  // 7 — FolderHierarchy
  7: {
    Folders: 0x05, Folder: 0x06, DisplayName: 0x07, ServerId: 0x08, ParentId: 0x09,
    Type: 0x0a, Response: 0x0b, Status: 0x0c, ContentClass: 0x0d, Changes: 0x0e,
    Add: 0x0f, Delete: 0x10, Update: 0x11, SyncKey: 0x12, FolderCreate: 0x13,
    FolderDelete: 0x14, FolderUpdate: 0x15, FolderSync: 0x16, Count: 0x17
  },
  // 14 — Provision
  14: {
    Provision: 0x05, Policies: 0x06, Policy: 0x07, PolicyType: 0x08, PolicyKey: 0x09,
    Data: 0x0a, Status: 0x0b, RemoteWipe: 0x0c, EASProvisionDoc: 0x0d
  },
  // 18 — Settings (DeviceInformation обязателен в Provision phase1 — иначе Status 165)
  18: {
    Settings: 0x05, Status: 0x06, Get: 0x07, Set: 0x08,
    DeviceInformation: 0x16, Model: 0x17, IMEI: 0x18, FriendlyName: 0x19,
    OS: 0x1a, OSLanguage: 0x1b, PhoneNumber: 0x1c, UserAgent: 0x20
  },
  // 17 — AirSyncBase
  17: {
    BodyPreference: 0x05, Type: 0x06, TruncationSize: 0x07, AllOrNone: 0x08,
    Body: 0x0a, Data: 0x0b, EstimatedDataSize: 0x0c, Truncated: 0x0d,
    Attachments: 0x0e, Attachment: 0x0f, DisplayName: 0x10, FileReference: 0x11,
    Method: 0x12, ContentId: 0x13, ContentLocation: 0x14, IsInline: 0x15,
    NativeBodyType: 0x16, ContentType: 0x17, Preview: 0x18,
    // 16.0+: Location-контейнер (Calendar:Location устарел)
    Location: 0x20,
    // 16.0+: дата вхождения повторяющейся встречи в Sync Change/Delete (MS-ASWBXML p.17)
    InstanceId: 0x2d
  },
  // 20 — ItemOperations
  20: {
    ItemOperations: 0x05, Fetch: 0x06, Store: 0x07, Options: 0x08, Range: 0x09,
    Total: 0x0a, Properties: 0x0b, Data: 0x0c, Status: 0x0d, Response: 0x0e,
    Version: 0x0f, Schema: 0x10, Part: 0x11, EmptyFolderContents: 0x12,
    DeleteSubFolders: 0x13, UserName: 0x14, Password: 0x15, Move: 0x16,
    DstFldId: 0x17, ConversationId: 0x18, MoveAlways: 0x19
  },
  // 21 — ComposeMail
  21: {
    SendMail: 0x05, SmartForward: 0x06, SmartReply: 0x07, SaveInSentItems: 0x08,
    ReplaceMime: 0x09, Source: 0x0b, FolderId: 0x0c, ItemId: 0x0d, LongId: 0x0e,
    InstanceId: 0x0f, Mime: 0x10, ClientId: 0x11, Status: 0x12, AccountId: 0x13
  }
}

/* Обратные таблицы: (страница, код) → имя. */
const REVERSE: Record<number, Record<number, string>> = {}
for (const [p, map] of Object.entries(PAGES)) {
  REVERSE[+p] = {}
  for (const [name, code] of Object.entries(map)) REVERSE[+p][code] = name
}

const SWITCH_PAGE = 0x00
const END = 0x01
const ENTITY = 0x02
const STR_I = 0x03
const STR_T = 0x83
const OPAQUE = 0xc3
const WITH_CONTENT = 0x40

/* ── Построение дерева для кодирования ───────────────────────────── */
export interface El {
  page: number
  name: string
  text?: string
  /** Сырые байты (OPAQUE) — TimeZone blob и т.п. */
  opaque?: Buffer
  children?: El[]
}
export const el = (page: number, name: string, body?: string | El[]): El =>
  typeof body === 'string' ? { page, name, text: body } : { page, name, children: body }

export const elOpaque = (page: number, name: string, data: Buffer): El => ({
  page,
  name,
  opaque: data
})

function writeMbUint32(out: number[], n: number): void {
  const bytes: number[] = []
  do {
    bytes.unshift(n & 0x7f)
    n >>>= 7
  } while (n > 0)
  for (let i = 0; i < bytes.length - 1; i++) out.push(bytes[i]! | 0x80)
  out.push(bytes[bytes.length - 1]!)
}

export function encode(root: El): Buffer {
  const out: number[] = [0x03, 0x01, 0x6a, 0x00] // version 1.3, publicid 1, UTF-8, пустая таблица строк
  let page = 0

  const writeEl = (e: El): void => {
    if (e.page !== page) {
      out.push(SWITCH_PAGE, e.page)
      page = e.page
    }
    const token = PAGES[e.page]?.[e.name]
    if (token == null) throw new Error(`WBXML: неизвестный тег ${e.page}:${e.name}`)
    const hasContent =
      e.text != null || e.opaque != null || (e.children != null && e.children.length > 0)
    out.push(hasContent ? token | WITH_CONTENT : token)
    if (e.opaque != null) {
      out.push(OPAQUE)
      writeMbUint32(out, e.opaque.length)
      for (const b of e.opaque) out.push(b)
    }
    if (e.text != null) {
      out.push(STR_I)
      for (const b of Buffer.from(e.text, 'utf8')) out.push(b)
      out.push(0x00)
    }
    if (e.children) for (const c of e.children) writeEl(c)
    if (hasContent) out.push(END)
  }

  writeEl(root)
  return Buffer.from(out)
}

/* ── Разбор WBXML в дерево объектов ──────────────────────────────── */
export interface Node {
  name: string
  page: number
  text?: string
  /** Opaque bytes (TimeZone и т.п.) — иначе 0xC3 ломает весь Sync календаря. */
  data?: Buffer
  children: Node[]
}

/** Multi-byte uint32 (WBXML). */
function readMbUint32(buf: Buffer, i: number): { value: number; next: number } {
  let n = 0
  let p = i
  while (p < buf.length) {
    const b = buf[p++]
    n = (n << 7) | (b & 0x7f)
    if ((b & 0x80) === 0) break
  }
  return { value: n, next: p }
}

export function decode(buf: Buffer): Node | null {
  let i = 4 // пропускаем заголовок (version, publicid, charset, strtab len)
  let page = 0

  // Разбираем детей тега `parent`: текст (STR_I) принадлежит самому `parent`,
  // вложенные теги становятся его children. END завершает уровень.
  const parseInto = (parent: Node): void => {
    while (i < buf.length) {
      const b = buf[i]
      if (b === END) {
        i++
        return
      }
      if (b === SWITCH_PAGE) {
        page = buf[i + 1]
        i += 2
        continue
      }
      if (b === STR_I) {
        i++
        const start = i
        while (i < buf.length && buf[i] !== 0x00) i++
        parent.text = (parent.text ?? '') + buf.slice(start, i).toString('utf8')
        i++ // пропускаем 0x00
        continue
      }
      if (b === OPAQUE) {
        // Calendar:TimeZone и др. — длина mb_uint32, затем сырые байты.
        const { value: len, next } = readMbUint32(buf, i + 1)
        i = next
        parent.data = buf.subarray(i, i + len)
        i += len
        continue
      }
      if (b === ENTITY) {
        const { value: code, next } = readMbUint32(buf, i + 1)
        parent.text = (parent.text ?? '') + String.fromCodePoint(code)
        i = next
        continue
      }
      if (b === STR_T) {
        // Индекс в string table (обычно пустой) — пропускаем.
        const { next } = readMbUint32(buf, i + 1)
        i = next
        continue
      }
      // Тег
      const hasContent = (b & WITH_CONTENT) !== 0
      const token = b & 0x3f
      const name = REVERSE[page]?.[token] ?? `0x${token.toString(16)}`
      i++
      const node: Node = { name, page, children: [] }
      parent.children.push(node)
      if (hasContent) parseInto(node)
    }
  }

  const root: Node = { name: '#root', page: 0, children: [] }
  parseInto(root)
  return root.children[0] ?? null
}

/* ── Помощники обхода дерева ─────────────────────────────────────── */
export function find(node: Node | null, name: string): Node | null {
  if (!node) return null
  for (const c of node.children) {
    if (c.name === name) return c
    const deep = find(c, name)
    if (deep) return deep
  }
  return null
}
export function findAll(node: Node | null, name: string): Node[] {
  const out: Node[] = []
  const walk = (n: Node): void => {
    for (const c of n.children) {
      if (c.name === name) out.push(c)
      walk(c)
    }
  }
  if (node) walk(node)
  return out
}
export function text(node: Node | null, name: string): string | null {
  const n = find(node, name)
  return n?.text ?? null
}
