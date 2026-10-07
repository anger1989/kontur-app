import type { ServiceConfig } from '@shared/types'
import { PROFILE_PASSWORD_REF } from '@shared/types'

/** Сервисы, куда имеет смысл подставлять логин/пароль формы. */
export function acceptsFormLogin(s: ServiceConfig): boolean {
  if (!s.enabled) return false
  if (s.mode === 'launcher') return false
  if (s.auth.kind === 'none') return false
  return Boolean(s.baseUrl?.trim()) || s.kind === 'mail'
}

/**
 * Раздать логин/пароль профиля по включённым сервисам + включить autoLogin.
 * Пароль: аргумент или уже сохранённый profile.password.
 */
export async function applyProfileCredentials(opts: {
  username: string
  password?: string
  services: ServiceConfig[]
  saveService: (s: ServiceConfig) => Promise<unknown>
}): Promise<number> {
  const user = opts.username.trim()
  if (!user) return 0

  const password = opts.password?.trim() ?? ''
  const hasProfilePass = password
    ? true
    : await window.kontur.secrets.has(PROFILE_PASSWORD_REF)

  let n = 0
  for (const s of opts.services) {
    if (!acceptsFormLogin(s)) continue
    const next: ServiceConfig = {
      ...s,
      auth: {
        ...s.auth,
        username: user,
        secretRef: `${s.id}.secret`
      },
      autoLogin: {
        ...s.autoLogin,
        enabled: true
      }
    }
    if (password) {
      await window.kontur.secrets.set(`${s.id}.secret`, password, s.name)
    } else if (hasProfilePass) {
      await window.kontur.secrets.copy(PROFILE_PASSWORD_REF, `${s.id}.secret`, s.name)
    }
    await opts.saveService(next)
    n++
  }
  return n
}

export async function saveProfilePassword(password: string): Promise<void> {
  const v = password.trim()
  if (!v) return
  await window.kontur.secrets.set(PROFILE_PASSWORD_REF, v, 'Пароль профиля')
}
