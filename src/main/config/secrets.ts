import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { SecretMeta } from '@shared/types'
import { secretsFile } from './paths'

interface StoredSecret {
  label: string
  /** base64 шифротекста из safeStorage; ключ живёт в системном keychain. */
  cipher: string
  updatedAt: number
}

type SecretsFile = Record<string, StoredSecret>

let cache: SecretsFile | null = null

function load(): SecretsFile {
  if (cache) return cache
  const file = secretsFile()
  if (!existsSync(file)) {
    cache = {}
    return cache
  }
  try {
    cache = JSON.parse(readFileSync(file, 'utf8')) as SecretsFile
  } catch {
    // Повреждённый файл не должен мешать приложению стартовать: секреты можно ввести заново.
    cache = {}
  }
  return cache
}

function persist(data: SecretsFile): void {
  cache = data
  writeFileSync(secretsFile(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

/** Доступно ли шифрование ОС. На macOS — Keychain, и это норма. */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function listSecrets(): SecretMeta[] {
  const data = load()
  return Object.entries(data).map(([ref, s]) => ({
    ref,
    label: s.label,
    hasValue: s.cipher.length > 0,
    updatedAt: s.updatedAt
  }))
}

export function hasSecret(ref: string): boolean {
  return Boolean(load()[ref]?.cipher)
}

export function setSecret(ref: string, value: string, label = ref): void {
  const data = { ...load() }
  if (!value) {
    delete data[ref]
    persist(data)
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Системное шифрование недоступно — секрет не сохранён')
  }
  data[ref] = {
    label,
    cipher: safeStorage.encryptString(value).toString('base64'),
    updatedAt: Date.now()
  }
  persist(data)
}

export function deleteSecret(ref: string): void {
  const data = { ...load() }
  delete data[ref]
  persist(data)
}

/** Перенос секрета при смене id сервиса (напр. ecom.mattermost → shared.mattermost). */
export function moveSecret(fromRef: string, toRef: string, label?: string): void {
  if (fromRef === toRef) return
  const data = { ...load() }
  const entry = data[fromRef]
  if (!entry) return
  if (!data[toRef]) {
    data[toRef] = { ...entry, label: label ?? entry.label }
  }
  delete data[fromRef]
  persist(data)
}

/**
 * Расшифровка. Вызывается коннекторами в main-процессе и — по явному
 * клику «показать» — страницей настроек. По умолчанию значения в renderer не уходят.
 */
/** Сверка пароля без отдачи значения в renderer (экран блокировки). */
export function verifySecret(ref: string, value: string): boolean {
  const stored = getSecret(ref)
  if (stored == null) return false
  return stored === value
}

/** Копировать секрет между ключами (профиль → сервис) без утечки в renderer. */
export function copySecret(fromRef: string, toRef: string, label?: string): boolean {
  const value = getSecret(fromRef)
  if (value == null) return false
  setSecret(toRef, value, label ?? toRef)
  return true
}

export function getSecret(ref: string): string | null {
  const entry = load()[ref]
  if (!entry?.cipher) return null
  try {
    return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'))
  } catch {
    return null
  }
}
