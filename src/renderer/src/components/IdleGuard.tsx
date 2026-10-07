import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useStore } from '@/store'
import { isOccludedByHigher } from '@/lib/deskLayout'
import { LockScreen } from '@/components/LockScreen'
import { Screensaver } from '@/components/Screensaver'

const TICK_MS = 5_000

/**
 * WebContentsView всегда рисуется поверх DOM, поэтому на время заставки и
 * блокировки показ вебвью запрещается целиком — в main. Одного `hide()` мало:
 * любой ре-рендер ServiceHost звал `show()` обратно, и открытый чат всплывал
 * поверх окна блокировки.
 */
function suppressViews(on: boolean): void {
  void window.kontur.view.suppress(on)
  if (on) return
  // Запрет снят — возвращаем то, что было видно, в прежнем z-порядке.
  const open = useStore.getState().windows.filter((w) => !w.minimized)
  const ids = open
    .filter((w) => w.route.kind === 'service')
    .filter((w) => !isOccludedByHigher(w, open))
    .sort((a, b) => a.z - b.z)
    .map((w) => (w.route as { serviceId: string }).serviceId)
  if (ids.length) void window.kontur.view.restore(ids)
}

/**
 * Заставка и блокировка по простою. Поверх всего UI; вебвью прячем —
 * иначе нативный слой торчит сквозь wavy/gradient.
 */
export function IdleGuard({ children }: { children: ReactNode }): JSX.Element {
  const profile = useStore((s) => s.config?.profile)
  const [screensaver, setScreensaver] = useState(false)
  const [locked, setLocked] = useState(false)
  const lastActive = useRef(Date.now())

  const ssMin = profile?.screensaverMinutes ?? 0
  const lockMin = profile?.lockMinutes ?? 0
  const enabled = ssMin > 0 || lockMin > 0

  const bump = useCallback((): void => {
    lastActive.current = Date.now()
  }, [])

  useEffect(() => {
    if (!enabled) {
      setScreensaver(false)
      return
    }
    const events: (keyof WindowEventMap)[] = [
      'pointerdown',
      'pointermove',
      'keydown',
      'wheel',
      'touchstart'
    ]
    const onAct = (): void => {
      if (locked) return
      if (screensaver) return
      bump()
    }
    for (const ev of events) window.addEventListener(ev, onAct, { passive: true })
    return () => {
      for (const ev of events) window.removeEventListener(ev, onAct)
    }
  }, [enabled, locked, screensaver, bump])

  useEffect(() => {
    if (!enabled) return
    const t = window.setInterval(() => {
      if (locked) return
      const idleMin = (Date.now() - lastActive.current) / 60_000
      if (lockMin > 0 && idleMin >= lockMin) {
        setScreensaver(false)
        setLocked(true)
        suppressViews(true)
        return
      }
      if (ssMin > 0 && idleMin >= ssMin && !screensaver) {
        setScreensaver(true)
        suppressViews(true)
      }
    }, TICK_MS)
    return () => clearInterval(t)
  }, [enabled, lockMin, ssMin, locked, screensaver])

  useEffect(() => {
    const onLock = (): void => {
      setScreensaver(false)
      setLocked(true)
      suppressViews(true)
    }
    window.addEventListener('kontur:lock', onLock)
    return () => window.removeEventListener('kontur:lock', onLock)
  }, [])

  const wakeFromScreensaver = (): void => {
    setScreensaver(false)
    bump()
    suppressViews(false)
  }

  const unlock = (): void => {
    setLocked(false)
    setScreensaver(false)
    bump()
    suppressViews(false)
  }

  return (
    <>
      {children}
      {screensaver && !locked && (
        <Screensaver
          displayName={profile?.displayName || profile?.username || 'Kontur'}
          onWake={wakeFromScreensaver}
        />
      )}
      {locked && (
        <div className="fixed inset-0 z-[210000]">
          <LockScreen
            displayName={profile?.displayName ?? ''}
            username={profile?.username ?? ''}
            onUnlock={unlock}
          />
        </div>
      )}
    </>
  )
}
