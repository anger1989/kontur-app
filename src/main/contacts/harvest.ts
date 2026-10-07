/**
 * Разбор людей из EAS-данных. Отдельно от contacts/index.ts — его импортирует
 * синк EAS, а index сам зависит от EAS-клиента (GAL): так нет цикла импортов.
 */
import type { MailFolder } from '@shared/types'
import { upsertContacts, type ContactSource } from '../db'
import { getConfig } from '../config/store'
import { logWarn } from '../log'
import { find, findAll, text, type Node } from '../connectors/eas/wbxml'

export interface Person {
  email: string
  name: string
}

export interface SeenPerson extends Person {
  source: ContactSource
}

const ADDRESS_RE = /[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}/i

/**
 * `"Иванов Иван" <ivanov@bank.ru>, petrov@bank.ru; Сидоров <s@x.ru>` → список.
 * Запятые внутри кавычек (имена вида «Иванов, Иван») не режут адрес пополам.
 */
export function parseAddresses(raw: string | null | undefined): Person[] {
  if (!raw) return []
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)

  const out: Person[] = []
  for (const part of parts) {
    const p = part.trim()
    if (!p) continue
    const inAngle = /<([^>]+)>/.exec(p)?.[1]
    const email = (inAngle ?? ADDRESS_RE.exec(p)?.[0] ?? '').trim().toLowerCase()
    if (!ADDRESS_RE.test(email)) continue
    const name = p
      .replace(/<[^>]*>/, '')
      .replace(email, '')
      .replace(/["']/g, '')
      .trim()
    out.push({ email, name })
  }
  return out
}

/** Люди из письма. В отправленных получатели — это «кому я пишу», вес выше. */
export function harvestMail(data: Node, folder: MailFolder): SeenPerson[] {
  const recipients: ContactSource = folder === 'inbox' ? 'mail' : 'sent'
  return [
    ...parseAddresses(text(data, 'From')).map((p) => ({ ...p, source: 'mail' as const })),
    ...parseAddresses(text(data, 'To')).map((p) => ({ ...p, source: recipients })),
    ...parseAddresses(text(data, 'Cc')).map((p) => ({ ...p, source: recipients }))
  ]
}

/** Организатор и участники встречи (MS-ASCAL: OrganizerEmail, Attendees/Attendee). */
export function harvestEvent(data: Node): SeenPerson[] {
  const out: SeenPerson[] = []
  const orgEmail = text(data, 'OrganizerEmail')?.trim().toLowerCase()
  if (orgEmail && ADDRESS_RE.test(orgEmail)) {
    out.push({ email: orgEmail, name: text(data, 'OrganizerName')?.trim() ?? '', source: 'meeting' })
  }
  const attendees = find(data, 'Attendees')
  if (attendees) {
    for (const a of findAll(attendees, 'Attendee')) {
      const email = text(a, 'AttendeeEmail')?.trim().toLowerCase()
      if (!email || !ADDRESS_RE.test(email)) continue
      out.push({ email, name: text(a, 'AttendeeName')?.trim() ?? '', source: 'meeting' })
    }
  }
  return out
}

/** Свои адреса — в подсказках им не место. */
export function ownAddresses(): Set<string> {
  const own = new Set<string>()
  for (const s of getConfig().services) {
    const e = s.options.email?.trim().toLowerCase()
    if (e) own.add(e)
    const u = s.auth.username?.trim().toLowerCase()
    if (u?.includes('@')) own.add(u)
  }
  return own
}

/** Записать увиденных при синке людей (идемпотентно: повторный синк вес не раздувает). */
export function rememberPeople(people: SeenPerson[], envId: string): void {
  if (!people.length) return
  const own = ownAddresses()
  try {
    upsertContacts(
      people.filter((p) => !own.has(p.email)),
      envId,
      false
    )
  } catch (e) {
    logWarn('contacts', `не удалось сохранить контакты: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Явное действие: отправили письмо / позвали на встречу — эти люди всплывают первыми. */
export function rememberRecipients(raw: string | null | undefined, envId: string): void {
  const people = parseAddresses(raw).map((p) => ({ ...p, source: 'sent' as const }))
  if (!people.length) return
  const own = ownAddresses()
  try {
    upsertContacts(
      people.filter((p) => !own.has(p.email)),
      envId,
      true
    )
  } catch (e) {
    logWarn('contacts', `не удалось сохранить получателей: ${e instanceof Error ? e.message : String(e)}`)
  }
}
