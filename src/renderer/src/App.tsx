import { useEffect, useState, type JSX } from 'react'
import { TitleBar } from '@/components/TitleBar'
import { Desktop } from '@/components/Desktop'
import { Dock } from '@/components/Dock'
import { WindowSwitcher } from '@/components/WindowSwitcher'
import { HotkeysDialog } from '@/components/HotkeysDialog'
import { EnvEditorHost } from '@/components/EnvEditorHost'
import { IdleGuard } from '@/components/IdleGuard'
import { LoadingScreen } from '@/components/LoadingScreen'
import { Onboarding } from '@/components/Onboarding'
import { useStore } from '@/store'
import { Toaster } from '@/components/ui/toast'
import { openLink } from '@/lib/openLink'
import { toast } from '@/components/ui/toast'

/** Заставка при запуске держится не меньше этого — чтобы не мелькала. */
const MIN_SPLASH_MS = 5000
/** Приветствие после онбординга — тот же экран, чуть дольше. */
const EXIT_SPLASH_MS = 1800

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const config = useStore((s) => s.config)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const load = useStore((s) => s.load)
  const refreshStatuses = useStore((s) => s.refreshStatuses)
  const [splashDone, setSplashDone] = useState(false)
  const [exitSplash, setExitSplash] = useState(false)

  useEffect(() => {
    void load()
    const t = setTimeout(() => setSplashDone(true), MIN_SPLASH_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  useEffect(() => {
    const offTheme = window.kontur.theme.onChange((t) => useStore.setState({ resolvedTheme: t }))
    const offEnv = window.kontur.env.onChange(() => void refreshStatuses())
    const offCfg = window.kontur.config.onChange(() => void useStore.getState().load())
    const offNav = window.kontur.nav.onOpenRoute((target) => useStore.getState().applyNav(target))
    const offBrowser = window.kontur.browser.onChange((st) =>
      useStore.getState().setBrowserState(st)
    )
    // «Подключиться» в уведомлении о встрече — main прислал ссылку, маршрутизация
    // (Ктолк → настроенный сервис, иначе — наружу) уже целиком на renderer.
    const offJoin = window.kontur.nav.onJoinMeeting((url) => openLink(url))
    const offUpdate = window.kontur.app.onUpdateAvailable((info) => {
      toast.message(`Доступна Kontur ${info.latestVersion}`, {
        description: `Сейчас ${info.currentVersion}. Скачайте DMG и замените приложение в Applications.`,
        action: {
          label: 'Скачать',
          onClick: () => void window.kontur.app.openUpdate(info.downloadUrl)
        },
        duration: 20_000
      })
    })
    return () => {
      offTheme()
      offEnv()
      offCfg()
      offNav()
      offBrowser()
      offJoin()
      offUpdate()
    }
  }, [refreshStatuses])

  if (!ready || !splashDone) {
    return <LoadingScreen message="Собираем контуры…" />
  }

  if (exitSplash) {
    return <LoadingScreen message="Добро пожаловать" />
  }

  if (config && !config.onboardingCompleted) {
    return (
      <Onboarding
        onFinished={() => {
          setExitSplash(true)
          window.setTimeout(() => setExitSplash(false), EXIT_SPLASH_MS)
        }}
      />
    )
  }

  return (
    <IdleGuard>
      <div className="flex h-full flex-col bg-background">
        <TitleBar />

        <div className="relative flex min-h-0 flex-1">
          <Desktop />
          <Dock />
        </div>

        <WindowSwitcher />
        <HotkeysDialog />
        <EnvEditorHost />
        <Toaster />
      </div>
    </IdleGuard>
  )
}
