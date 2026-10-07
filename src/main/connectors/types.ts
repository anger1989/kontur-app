import type { EnvConfig, Item, ItemKind, ServiceConfig, ServiceKind } from '@shared/types'

/** Всё, что коннектору нужно знать о своём сервисе и его контуре. */
export interface SyncContext {
  env: EnvConfig
  service: ServiceConfig
  /** Расшифрованный токен или пароль. Берётся из keychain в момент вызова. */
  secret: string | null
  /** Курсор прошлой синхронизации: с чего дочитывать. */
  cursor: string | null
}

/**
 * Диапазон, по которому выдача коннектора полная: если элемента такого вида
 * с `startsAt` внутри окна в выдаче нет, его нет и на сервере — локальную
 * копию надо убрать.
 *
 * Без этого встреча, которую отменили и завели заново (на сервере у неё уже
 * новый id), навсегда оставалась в базе прежней копией со статусом
 * «отменена»: синк только дописывает элементы.
 *
 * Объявлять окно можно, только когда выдача гарантированно не обрезана —
 * страницы дочитаны, ошибок не было. Чистка по усечённому ответу стёрла бы
 * живые записи.
 */
export interface PruneWindow {
  kind: ItemKind
  /** Границы по `startsAt`, мс. */
  from: number
  to: number
}

export interface SyncResult {
  items: Item[]
  /** Новый курсор. null — оставить прежний. */
  cursor: string | null
  /** Окна, где выдача полная (см. PruneWindow). */
  prune?: PruneWindow[]
}

/**
 * Коннектор к одному типу сервиса.
 *
 * Сеть берётся только через dispatcherFor(env) — это и есть шов, за которым
 * спрятана разница между контурами. Коннектор про туннели ничего не знает:
 * его не вызывают, пока контур лежит.
 */
export interface Connector {
  kind: ServiceKind
  /** Инкрементальное чтение. Вызывается планировщиком, пока контур доступен. */
  sync(ctx: SyncContext): Promise<SyncResult>
  /** Подписка на события в реальном времени. Возвращает функцию отписки. */
  startRealtime?(ctx: SyncContext, onItems: (items: Item[]) => void): Promise<() => void>
  /** Выполнить отложенное действие из outbox. Бросает — действие останется в очереди. */
  perform?(ctx: SyncContext, action: string, payload: unknown): Promise<void>
}

/** Идентификатор элемента: контур, сервис и родной id — чтобы не схлопнулись среды. */
export const itemId = (service: ServiceConfig, nativeId: string): string =>
  `${service.envId}:${service.id}:${nativeId}`
