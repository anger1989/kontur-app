import { useState, type FormEvent, type JSX } from 'react'
import { PROFILE_PASSWORD_REF } from '@shared/types'
import { BackgroundGradientAnimation } from '@/components/ui/background-gradient-animation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Экран блокировки — Aceternity gradient + форма входа паролем профиля.
 */
export function LockScreen({
  displayName,
  username,
  onUnlock
}: {
  displayName: string
  username: string
  onUnlock: () => void
}): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const has = await window.kontur.secrets.has(PROFILE_PASSWORD_REF)
      if (!has) {
        // Пароль ещё не задан — пускаем (настройка в профиле).
        onUnlock()
        return
      }
      const ok = await window.kontur.secrets.verify(PROFILE_PASSWORD_REF, password)
      if (!ok) {
        setError('Неверный пароль')
        setPassword('')
        return
      }
      onUnlock()
    } finally {
      setBusy(false)
    }
  }

  const greeting = displayName.trim() || username.trim() || 'пользователь'

  return (
    <BackgroundGradientAnimation containerClassName="h-full w-full" className="flex h-full items-center justify-center px-6">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/35 px-7 py-8 shadow-2xl backdrop-blur-xl"
      >
        <p className="text-[11px] font-semibold tracking-[0.14em] text-neutral-300 uppercase">Kontur</p>
        <h1 className="mt-3 font-sans text-[26px] font-semibold tracking-tight text-white">
          С возвращением
        </h1>
        <p className="mt-1.5 text-[13px] text-white/55">{greeting}</p>

        {/* Без подписи «Пароль»: в форме одно поле, и плейсхолдер уже всё говорит.
            Поле и кнопка — одной высоты и с одинаковым шагом друг от друга. */}
        <Input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Пароль профиля"
          className="mt-7 h-11 rounded-lg border-white/15 bg-white/8 text-white placeholder:text-white/35 focus-visible:border-white/35 focus-visible:ring-white/20"
          placeholder="Пароль профиля"
        />
        {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}

        <Button
          type="submit"
          disabled={busy}
          className="mt-3 h-11 w-full rounded-lg bg-neutral-100 text-neutral-900 hover:bg-white"
        >
          Войти
        </Button>
      </form>
    </BackgroundGradientAnimation>
  )
}
