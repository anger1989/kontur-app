/**
 * Локальный планировщик — личные дела с сроком и напоминанием.
 * Не путать с Jira `task`: живут в items с kind=`todo`, env=`local`.
 */
import { randomUUID } from 'node:crypto'
import type { Item, TodoCreatePayload, TodoUpdatePayload } from '@shared/types'
import { deleteItem, getItem, queryItems, upsertItems } from '../db'
import { emitItemsChanged } from '../notify/itemsChanged'

export const TODO_ENV = 'local'
export const TODO_SERVICE = 'todos'

type TodoMeta = {
  cat: 'open' | 'done'
  remind: number | null
  cal: boolean
  note: string
}

function parseMeta(body: string): TodoMeta {
  let cat: 'open' | 'done' = 'open'
  let remind: number | null = null
  let cal = true
  const notes: string[] = []
  for (const line of body.split('\n')) {
    if (line === 'cat:done') cat = 'done'
    else if (line === 'cat:open') cat = 'open'
    else if (line.startsWith('remind:')) {
      const n = Number(line.slice(7))
      remind = Number.isFinite(n) && n > 0 ? n : null
    } else if (line === 'cal:0') cal = false
    else if (line === 'cal:1') cal = true
    else if (line.startsWith('note:')) notes.push(line.slice(5))
    else if (line.trim() && !line.includes(':')) notes.push(line)
  }
  return { cat, remind, cal, note: notes.join('\n').trim() }
}

function buildBody(meta: TodoMeta): string {
  const lines = [`cat:${meta.cat}`, `cal:${meta.cal ? '1' : '0'}`]
  if (meta.remind != null) lines.push(`remind:${meta.remind}`)
  if (meta.note.trim()) {
    for (const line of meta.note.trim().split('\n')) lines.push(`note:${line}`)
  }
  return lines.join('\n')
}

export function isTodoDone(it: Item): boolean {
  return parseMeta(it.body).cat === 'done'
}

export function todoRemindAt(it: Item): number | null {
  return parseMeta(it.body).remind
}

export function listTodos(): Item[] {
  return queryItems({ kinds: ['todo'], limit: 2000, mode: 'full' }).sort((a, b) => {
    const ad = isTodoDone(a) ? 1 : 0
    const bd = isTodoDone(b) ? 1 : 0
    if (ad !== bd) return ad - bd
    const as = a.startsAt ?? Number.MAX_SAFE_INTEGER
    const bs = b.startsAt ?? Number.MAX_SAFE_INTEGER
    if (as !== bs) return as - bs
    return b.updatedAt - a.updatedAt
  })
}

export function createTodo(payload: TodoCreatePayload): Item {
  const title = payload.title.trim()
  if (!title) throw new Error('Название обязательно')
  const id = `${TODO_ENV}:${TODO_SERVICE}:${randomUUID()}`
  const dueAt = payload.dueAt && payload.dueAt > 0 ? payload.dueAt : null
  const remindAt = payload.remindAt && payload.remindAt > 0 ? payload.remindAt : null
  const showCal = payload.showInCalendar !== false && dueAt != null
  const item: Item = {
    id,
    envId: TODO_ENV,
    serviceId: TODO_SERVICE,
    kind: 'todo',
    title,
    body: buildBody({
      cat: 'open',
      remind: remindAt,
      cal: showCal,
      note: payload.note?.trim() ?? ''
    }),
    author: null,
    state: null,
    url: '',
    updatedAt: Date.now(),
    unread: false,
    mentioned: false,
    startsAt: dueAt,
    endsAt: dueAt != null ? dueAt + 30 * 60_000 : null
  }
  upsertItems([item])
  emitItemsChanged()
  return item
}

export function updateTodo(payload: TodoUpdatePayload): Item {
  const prev = getItem(payload.id)
  if (!prev || prev.kind !== 'todo') throw new Error('Задача не найдена')
  const meta = parseMeta(prev.body)
  if (payload.title != null) {
    const t = payload.title.trim()
    if (!t) throw new Error('Название обязательно')
  }
  if (payload.done === true) meta.cat = 'done'
  if (payload.done === false) meta.cat = 'open'
  if (payload.remindAt !== undefined) {
    meta.remind = payload.remindAt && payload.remindAt > 0 ? payload.remindAt : null
  }
  if (payload.showInCalendar !== undefined) meta.cal = payload.showInCalendar
  if (payload.note !== undefined) meta.note = payload.note.trim()

  const dueAt =
    payload.dueAt !== undefined
      ? payload.dueAt && payload.dueAt > 0
        ? payload.dueAt
        : null
      : prev.startsAt
  if (dueAt == null) meta.cal = false
  else if (payload.showInCalendar === undefined && payload.dueAt !== undefined) meta.cal = true

  const next: Item = {
    ...prev,
    title: payload.title?.trim() ?? prev.title,
    body: buildBody(meta),
    updatedAt: Date.now(),
    startsAt: dueAt,
    endsAt: dueAt != null ? dueAt + 30 * 60_000 : null
  }
  upsertItems([next])
  emitItemsChanged()
  return next
}

export function removeTodo(id: string): boolean {
  const prev = getItem(id)
  if (!prev || prev.kind !== 'todo') return false
  const ok = deleteItem(id)
  if (ok) emitItemsChanged()
  return ok
}
