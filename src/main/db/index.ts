import Database from 'better-sqlite3'
import type { Bookmark, Item, OutboxEntry } from '@shared/types'
import { dbFile } from '../config/paths'

let db: Database.Database | null = null

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  env_id      TEXT NOT NULL,
  service_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  author      TEXT,
  state       TEXT,
  url         TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 0,
  mentioned   INTEGER NOT NULL DEFAULT 0,
  starts_at   INTEGER,
  ends_at     INTEGER,
  folder      TEXT
);
CREATE INDEX IF NOT EXISTS items_updated  ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS items_env_kind ON items(env_id, kind);

-- Сквозной поиск. Внешнее содержимое, чтобы не дублировать тексты.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, content='items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Отложенные действия на запись: уходят, когда контур снова доступен.
CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  env_id           TEXT NOT NULL,
  service_id       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  action           TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);

-- Курсоры инкрементальной синхронизации: с какого момента дочитывать каждый сервис.
CREATE TABLE IF NOT EXISTS sync_state (
  service_id  TEXT PRIMARY KEY,
  cursor      TEXT,
  last_sync   INTEGER
);

-- Каталог закладок. url уникален: повторное добавление той же страницы
-- обновляет существующую запись, а не плодит дубль. Группа каталога — host,
-- отдельной таблицей/полем не хранится, формируется на лету.
CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  favicon     TEXT,
  host        TEXT NOT NULL,
  service_id  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_host ON bookmarks(host);

-- Адресная книга для подсказок получателей (см. main/contacts). email — в
-- нижнем регистре. weight — самый ценный источник, где человек встречался
-- (sent 3, meeting 2, mail 1, gal 0): повторный синк его не раздувает.
-- uses — сколько раз вы сами ему писали/звали на встречу из приложения.
-- search — name + email в нижнем регистре: LIKE в SQLite регистронезависим
-- только для латиницы, а имена у нас кириллицей.
CREATE TABLE IF NOT EXISTS contacts (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  env_id     TEXT,
  source     TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 0,
  uses       INTEGER NOT NULL DEFAULT 0,
  last_seen  INTEGER NOT NULL,
  search     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_rank ON contacts(weight DESC, uses DESC, last_seen DESC);
`

export function initDb(): Database.Database {
  if (db) return db
  db = new Database(dbFile())
  db.exec(SCHEMA)
  migrate(db)
  return db
}

export function closeDb(): void {
  try {
    db?.close()
  } catch {
    // уже закрыта / process exiting
  }
  db = null
}

/** Лёгкие миграции для установок, созданных до появления колонки. */
function migrate(d: Database.Database): void {
  const cols = new Set((d.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('starts_at')) d.exec('ALTER TABLE items ADD COLUMN starts_at INTEGER')
  if (!cols.has('ends_at')) d.exec('ALTER TABLE items ADD COLUMN ends_at INTEGER')
  if (!cols.has('folder')) d.exec('ALTER TABLE items ADD COLUMN folder TEXT')
  // Письма, синкнутые до появления folder, считаем входящими — иначе
  // фильтр «Входящие» их видит, а Sent/Drafts остаются «пустыми» в UI.
  d.exec(`UPDATE items SET folder = 'inbox' WHERE kind = 'mail' AND folder IS NULL`)
}

function conn(): Database.Database {
  return db ?? initDb()
}

const rowToItem = (r: Record<string, unknown>): Item => ({
  id: r.id as string,
  envId: r.env_id as string,
  serviceId: r.service_id as string,
  kind: r.kind as Item['kind'],
  title: r.title as string,
  body: r.body as string,
  author: (r.author as string) ?? null,
  state: (r.state as string) ?? null,
  url: r.url as string,
  updatedAt: r.updated_at as number,
  unread: Boolean(r.unread),
  mentioned: Boolean(r.mentioned),
  startsAt: (r.starts_at as number) ?? null,
  endsAt: (r.ends_at as number) ?? null,
  folder: (r.folder as string) ?? null
})

export function upsertItems(items: Item[]): Item[] {
  if (!items.length) return []
  // Какие ещё не в базе — одним IN, а не N×SELECT (иначе синк сотен писем жрёт main).
  const existing = new Set<string>()
  const chunk = 400
  for (let i = 0; i < items.length; i += chunk) {
    const ids = items.slice(i, i + chunk).map((it) => it.id)
    const ph = ids.map(() => '?').join(',')
    const rows = conn()
      .prepare(`SELECT id FROM items WHERE id IN (${ph})`)
      .all(...ids) as { id: string }[]
    for (const r of rows) existing.add(r.id)
  }
  const fresh = items.filter((it) => !existing.has(it.id))

  const stmt = conn().prepare(`
    INSERT INTO items (id, env_id, service_id, kind, title, body, author, state, url, updated_at, unread, mentioned, starts_at, ends_at, folder)
    VALUES (@id, @envId, @serviceId, @kind, @title, @body, @author, @state, @url, @updatedAt, @unread, @mentioned, @startsAt, @endsAt, @folder)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      body=CASE WHEN length(excluded.body) > 0 THEN excluded.body ELSE items.body END,
      author=excluded.author, state=excluded.state,
      url=excluded.url, updated_at=excluded.updated_at,
      -- Прочитал в приложении → не возвращаем флаг синка (MM mention / MR / почта
      -- не «прыгают» обратно каждую минуту). Исключение: MM channel:… — тот же
      -- id при новых непрочитанных, синк должен снова выставить unread.
      unread=CASE
        WHEN items.unread = 0
          AND (items.kind != 'message' OR instr(items.id, ':channel:') = 0)
          THEN 0
        ELSE excluded.unread
      END,
      mentioned=CASE
        WHEN items.mentioned = 0
          AND (items.kind != 'message' OR instr(items.id, ':channel:') = 0)
          THEN 0
        ELSE excluded.mentioned
      END,
      starts_at=excluded.starts_at, ends_at=excluded.ends_at, folder=excluded.folder
  `)
  const tx = conn().transaction((rows: Item[]) => {
    for (const it of rows) {
      stmt.run({
        ...it,
        unread: it.unread ? 1 : 0,
        mentioned: it.mentioned ? 1 : 0,
        startsAt: it.startsAt ?? null,
        endsAt: it.endsAt ?? null,
        folder: it.folder ?? null
      })
    }
  })
  tx(items)
  return fresh
}

/**
 * Убрать элементы вида `kind`, попавшие в окно по `starts_at`, которых не
 * оказалось в свежей выдаче сервиса (см. PruneWindow у коннектора).
 *
 * Считаем в два шага, а не одним `NOT IN`: развёрнутая серия даёт сотни
 * вхождений, и такой список в параметрах запроса упирается в лимит SQLite.
 */
export function pruneItems(
  serviceId: string,
  kind: string,
  from: number,
  to: number,
  keepIds: string[]
): number {
  const rows = conn()
    .prepare(
      `SELECT id FROM items
       WHERE service_id = ? AND kind = ?
         AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at <= ?`
    )
    .all(serviceId, kind, from, to) as { id: string }[]
  const keep = new Set(keepIds)
  const stale = rows.map((r) => r.id).filter((id) => !keep.has(id))
  if (!stale.length) return 0

  const del = conn().prepare('DELETE FROM items WHERE id = ?')
  const tx = conn().transaction((ids: string[]) => {
    let n = 0
    for (const id of ids) n += del.run(id).changes
    return n
  })
  return tx(stale) as number
}

/** Снять «внимание» с элемента: счётчики и «Мой день» обновляются сразу. */
export function markItemsRead(ids: string[]): number {
  if (!ids.length) return 0
  const stmt = conn().prepare(
    'UPDATE items SET unread = 0, mentioned = 0 WHERE id = ? AND (unread = 1 OR mentioned = 1)'
  )
  const tx = conn().transaction((list: string[]) => {
    let n = 0
    for (const id of list) {
      const r = stmt.run(id)
      n += r.changes
    }
    return n
  })
  return tx(ids)
}

/** Все непрочитанные/упомянутые элементы сервиса данного вида, которых нет в keepIds. */
export function settleUnread(serviceId: string, kind: string, keepIds: string[]): number {
  if (!keepIds.length) {
    const r = conn()
      .prepare(
        `UPDATE items SET unread = 0, mentioned = 0
         WHERE service_id = ? AND kind = ? AND (unread = 1 OR mentioned = 1)`
      )
      .run(serviceId, kind)
    return r.changes
  }
  const ph = keepIds.map(() => '?').join(',')
  const r = conn()
    .prepare(
      `UPDATE items SET unread = 0, mentioned = 0
       WHERE service_id = ? AND kind = ? AND (unread = 1 OR mentioned = 1)
         AND id NOT IN (${ph})`
    )
    .run(serviceId, kind, ...keepIds)
  return r.changes
}

/** Один элемент по точному id — без лимита по дате/объёму, в отличие от queryItems. */
export function getItem(id: string): Item | null {
  const row = conn().prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToItem(row) : null
}

/** Удалить элемент (локальные todos). FTS обновит триггер. */
export function deleteItem(id: string): boolean {
  const r = conn().prepare('DELETE FROM items WHERE id = ?').run(id)
  return r.changes > 0
}

/**
 * Удалить событие и все его вхождения: `id` целиком или `id:20261007T100000Z`.
 * Не LIKE: у серии `…:event:7:42` префикс совпал бы и с чужой `…:event:7:420`.
 */
export function deleteItemsByPrefix(baseId: string): number {
  const withSep = `${baseId}:`
  const r = conn()
    .prepare('DELETE FROM items WHERE id = ? OR substr(id, 1, ?) = ?')
    .run(baseId, withSep.length, withSep)
  return r.changes
}

export interface ItemQuery {
  envIds?: string[]
  kinds?: Item['kind'][]
  unreadOnly?: boolean
  mentionedOnly?: boolean
  limit?: number
  /**
   * `list` (по умолчанию) — body обрезан (превью/cat:), без мегабайт HTML в IPC.
   * `full` — целиком; для редких случаев, когда нужен полный текст из кэша.
   */
  mode?: 'list' | 'full'
}

/** Хватает для превью письма и meta-строк задачи (`cat:…`). */
const LIST_BODY_CHARS = 512

export function queryItems(q: ItemQuery = {}): Item[] {
  const where: string[] = []
  const params: unknown[] = []
  if (q.envIds?.length) {
    where.push(`env_id IN (${q.envIds.map(() => '?').join(',')})`)
    params.push(...q.envIds)
  }
  if (q.kinds?.length) {
    where.push(`kind IN (${q.kinds.map(() => '?').join(',')})`)
    params.push(...q.kinds)
  }
  if (q.unreadOnly) where.push('unread = 1')
  if (q.mentionedOnly) where.push('mentioned = 1')
  const bodyExpr = q.mode === 'full' ? 'body' : `substr(body, 1, ${LIST_BODY_CHARS}) AS body`
  const sql = `SELECT id, env_id, service_id, kind, title, ${bodyExpr}, author, state, url,
                      updated_at, unread, mentioned, starts_at, ends_at, folder
               FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT ?`
  params.push(q.limit ?? 200)
  return conn().prepare(sql).all(...params).map((r) => rowToItem(r as Record<string, unknown>))
}

/** Сквозной поиск по всем контурам сразу — главная причина, по которой всё это складывается в одну базу. */
export function searchItems(query: string, limit = 100): Item[] {
  if (!query.trim()) return []
  const sql = `
    SELECT items.* FROM items_fts
    JOIN items ON items.rowid = items_fts.rowid
    WHERE items_fts MATCH ?
    ORDER BY rank LIMIT ?`
  try {
    return conn().prepare(sql).all(`${query.trim()}*`, limit).map((r) => rowToItem(r as Record<string, unknown>))
  } catch {
    // Невалидный синтаксис FTS (пользователь печатает в реальном времени) — просто пустой результат.
    return []
  }
}

export function enqueueOutbox(entry: OutboxEntry): void {
  conn()
    .prepare(`
      INSERT OR IGNORE INTO outbox (id, env_id, service_id, idempotency_key, action, payload, created_at, attempts, last_error)
      VALUES (@id, @envId, @serviceId, @idempotencyKey, @action, @payload, @createdAt, @attempts, @lastError)
    `)
    .run({ ...entry, payload: JSON.stringify(entry.payload) })
}

export function outboxFor(envId: string): OutboxEntry[] {
  return conn()
    .prepare('SELECT * FROM outbox WHERE env_id = ? ORDER BY created_at')
    .all(envId)
    .map((r) => {
      const row = r as Record<string, unknown>
      return {
        id: row.id as string,
        envId: row.env_id as string,
        serviceId: row.service_id as string,
        idempotencyKey: row.idempotency_key as string,
        action: row.action as string,
        payload: JSON.parse(row.payload as string),
        createdAt: row.created_at as number,
        attempts: row.attempts as number,
        lastError: (row.last_error as string) ?? null
      }
    })
}

export function outboxCount(envId: string): number {
  const row = conn().prepare('SELECT COUNT(*) AS n FROM outbox WHERE env_id = ?').get(envId) as { n: number }
  return row.n
}

/** Попытка не удалась: помечаем, чтобы было видно, почему действие висит. */
export function bumpOutbox(id: string, error: string): void {
  conn()
    .prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    .run(error, id)
}

export function dropOutbox(id: string): void {
  conn().prepare('DELETE FROM outbox WHERE id = ?').run(id)
}

export function setCursor(serviceId: string, cursor: string | null): void {
  conn()
    .prepare(`INSERT INTO sync_state (service_id, cursor, last_sync) VALUES (?, ?, ?)
              ON CONFLICT(service_id) DO UPDATE SET cursor=excluded.cursor, last_sync=excluded.last_sync`)
    .run(serviceId, cursor, Date.now())
}

export function getCursor(serviceId: string): { cursor: string | null; lastSync: number | null } {
  const row = conn().prepare('SELECT cursor, last_sync FROM sync_state WHERE service_id = ?').get(serviceId) as
    | { cursor: string | null; last_sync: number | null }
    | undefined
  return { cursor: row?.cursor ?? null, lastSync: row?.last_sync ?? null }
}

/* ── Закладки ────────────────────────────────────────────────────────── */

const rowToBookmark = (r: Record<string, unknown>): Bookmark => ({
  id: r.id as string,
  url: r.url as string,
  title: r.title as string,
  favicon: (r.favicon as string) ?? null,
  host: r.host as string,
  serviceId: (r.service_id as string) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

/** Добавить/обновить по адресу — повторное добавление той же страницы обновляет запись, не плодит дубль. */
export function upsertBookmark(b: Bookmark): Bookmark {
  conn()
    .prepare(`
      INSERT INTO bookmarks (id, url, title, favicon, host, service_id, created_at, updated_at)
      VALUES (@id, @url, @title, @favicon, @host, @serviceId, @createdAt, @updatedAt)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        favicon = COALESCE(excluded.favicon, bookmarks.favicon),
        service_id = excluded.service_id,
        updated_at = excluded.updated_at
    `)
    .run(b)
  return getBookmarkByUrl(b.url)!
}

export function getBookmarkByUrl(url: string): Bookmark | null {
  const row = conn().prepare('SELECT * FROM bookmarks WHERE url = ?').get(url) as
    | Record<string, unknown>
    | undefined
  return row ? rowToBookmark(row) : null
}

export function listBookmarks(): Bookmark[] {
  return conn()
    .prepare('SELECT * FROM bookmarks ORDER BY updated_at DESC')
    .all()
    .map((r) => rowToBookmark(r as Record<string, unknown>))
}

export function removeBookmark(id: string): void {
  conn().prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
}

/* ── Адресная книга ──────────────────────────────────────────────────── */

export type ContactSource = 'sent' | 'meeting' | 'mail' | 'gal'

const SOURCE_WEIGHT: Record<ContactSource, number> = { sent: 3, meeting: 2, mail: 1, gal: 0 }

export interface ContactRow {
  email: string
  name: string
  source: ContactSource
  envId: string | null
}

/** Имя «настоящее», а не адрес/логин, подставленный вместо имени. */
function isRealName(name: string, email: string): boolean {
  const n = name.trim().toLowerCase()
  return Boolean(n) && n !== email && n !== email.split('@')[0]
}

/**
 * Записать людей. `explicit` — вы сами им написали/позвали: +1 к uses.
 * Синк зовёт с explicit=false и может повторяться сколько угодно — вес берётся
 * максимальный, а не суммируется.
 */
export function upsertContacts(
  people: { email: string; name: string; source: ContactSource }[],
  envId: string | null,
  explicit: boolean
): void {
  if (!people.length) return
  const now = Date.now()
  const select = conn().prepare('SELECT name, weight, source FROM contacts WHERE email = ?')
  const insert = conn().prepare(`
    INSERT INTO contacts (email, name, env_id, source, weight, uses, last_seen, search)
    VALUES (@email, @name, @envId, @source, @weight, @uses, @now, @search)
  `)
  const update = conn().prepare(`
    UPDATE contacts SET name = @name, source = @source, weight = @weight,
      uses = uses + @uses, last_seen = @now, search = @search,
      env_id = COALESCE(env_id, @envId)
    WHERE email = @email
  `)
  const tx = conn().transaction(() => {
    for (const p of people) {
      const email = p.email.trim().toLowerCase()
      if (!email.includes('@')) continue
      const weight = SOURCE_WEIGHT[p.source]
      const prev = select.get(email) as { name: string; weight: number; source: ContactSource } | undefined
      // Имя: GAL — эталон; иначе не затираем нормальное имя пустым/адресом.
      const name =
        isRealName(p.name, email) && (!prev || p.source === 'gal' || !isRealName(prev.name, email))
          ? p.name.trim()
          : (prev?.name ?? '')
      const best = !prev || weight > prev.weight
      const row = {
        email,
        name,
        envId,
        source: best ? p.source : prev!.source,
        weight: best ? weight : prev!.weight,
        uses: explicit ? 1 : 0,
        now,
        search: `${name} ${email}`.toLowerCase()
      }
      if (prev) update.run(row)
      else insert.run(row)
    }
  })
  tx()
}

/**
 * Поиск по подстроке имени/адреса, регистронезависимо и для кириллицы.
 * Ранжирование: совпадение с началом слова (фамилии, имени, адреса) выше
 * совпадения в середине; дальше — ценность источника, частота своих писем,
 * свежесть.
 */
export function searchContacts(query: string, limit: number): ContactRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const rows = conn()
    .prepare(
      `SELECT email, name, source, env_id, weight, uses, last_seen, search FROM contacts
       WHERE instr(search, ?) > 0
       ORDER BY weight DESC, uses DESC, last_seen DESC LIMIT 400`
    )
    .all(q) as {
    email: string
    name: string
    source: ContactSource
    env_id: string | null
    weight: number
    uses: number
    last_seen: number
    search: string
  }[]
  const wordStart = (r: { search: string }): boolean =>
    r.search.startsWith(q) || r.search.includes(` ${q}`) || r.search.includes(`.${q}`)
  return rows
    .map((r, i) => ({ r, score: (wordStart(r) ? 0 : 1000) + i }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ r }) => ({ email: r.email, name: r.name, source: r.source, envId: r.env_id }))
}
