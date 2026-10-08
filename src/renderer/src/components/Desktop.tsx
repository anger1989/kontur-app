import { useEffect, useRef, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isPopoverOpen, useStore } from '@/store'
import { wallpaperStyle } from '@/lib/wallpapers'
import { AnimatedWallpaper } from './AnimatedWallpaper'
import { Window } from './Window'
import { TodayWidgets } from './TodayWidgets'
import { DesktopIcon } from './DesktopIcon'

/**
 * Рабочий стол: обои на весь экран, поверх — плавающие окна.
 * Измеряет сам себя, чтобы «развернуть» окно можно было ровно по его площади
 * (а не по размеру всего окна Electron, под которым ещё и дек).
 *
 * Клик по пустому столу — как «Показать рабочий стол» в macOS: окна уезжают
 * к краям (слева / сверху / справа остаётся полоска); повторный клик
 * (или клик по окну / Esc) возвращает как было.
 */
export function Desktop(): JSX.Element {
  const wallpaper = useStore((s) => s.config?.wallpaper)
  // Без minimized: размонтируем, чтобы при restore сработала genie-анимация из дока.
  // При драге массив id стабилен → Desktop не ре-рендерится.
  const windowIds = useStore(
    useShallow((s) => s.windows.filter((w) => !w.minimized).map((w) => w.id))
  )
  const closeWindow = useStore((s) => s.closeWindow)
  const peekDesktop = useStore((s) => s.peekDesktop)
  const ref = useRef<HTMLDivElement>(null)
  // Размер живёт в сторе: от него зависят не только окна, но и виджеты с доком.
  const size = useStore((s) => s.desktop)
  const setDesktopSize = useStore((s) => s.setDesktopSize)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const push = (): void => {
      const r = el.getBoundingClientRect()
      setDesktopSize({ width: r.width, height: r.height })
    }
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setDesktopSize])

  const cycleWindow = useStore((s) => s.cycleWindow)

  // Esc: switcher → вернуть окна со стола → закрыть верхнее.
  // ⌘` / ⌘⇧` — лента миниатюр (подтверждение на keyup ⌘ / settle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.code === 'Backquote' || e.key === '`' || e.key === 'ё')) {
        if (e.defaultPrevented) return
        // Switcher сам использует popoverDepth — не блокируем повторные ⌘`.
        if (!useStore.getState().windowSwitcher && isPopoverOpen()) return
        if (document.querySelector('[data-slot="dialog-content"]')) return
        e.preventDefault()
        cycleWindow(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      const st = useStore.getState()
      if (st.windowSwitcher) {
        st.cancelWindowSwitcher()
        return
      }
      if (isPopoverOpen()) return
      if (document.querySelector('[data-slot="dialog-content"]')) return
      if (st.arranged) {
        peekDesktop(size)
        return
      }
      const top = [...st.windows]
        .filter((w) => !w.minimized)
        .sort((a, b) => b.z - a.z)[0]
      if (top) closeWindow(top.id)
    }
    // Keyup Meta всегда слушает Desktop — иначе после ⌘` listener WindowSwitcher
    // ещё не смонтирован и подтверждение теряется.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!useStore.getState().windowSwitcher) return
      if (
        e.key === 'Meta' ||
        e.key === 'Control' ||
        e.code === 'MetaLeft' ||
        e.code === 'MetaRight' ||
        e.code === 'ControlLeft' ||
        e.code === 'ControlRight'
      ) {
        useStore.getState().confirmWindowSwitcher()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [closeWindow, peekDesktop, size, cycleWindow])

  // Фокус в вебвью — keydown/keyup до рендерера не доходят; main шлёт IPC.
  useEffect(() => {
    const offCycle = window.kontur.nav.onCycleWindow((dir) => {
      useStore.getState().cycleWindow(dir)
    })
    const offConfirm = window.kontur.nav.onConfirmCycleWindow(() => {
      useStore.getState().confirmWindowSwitcher()
    })
    return () => {
      offCycle()
      offConfirm()
    }
  }, [])

  const toggleShowDesktop = (): void => {
    const st = useStore.getState()
    if (!st.arranged && !st.windows.some((w) => !w.minimized)) return
    peekDesktop(size)
  }

  return (
    <div
      ref={ref}
      data-desktop-root
      className="relative min-h-0 flex-1 overflow-hidden"
      style={wallpaperStyle(wallpaper)}
    >
      {/* Живые обои — самым нижним слоем: всё остальное в DOM идёт после и
          рисуется поверх, а клики ловит прозрачная подложка ниже. */}
      <AnimatedWallpaper wallpaper={wallpaper} />
      {/* Пустой стол ловит клик → показать стол. Виджеты/иконки/окна выше и перехватывают. */}
      <div
        data-desktop-backdrop
        className="absolute inset-0"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          toggleShowDesktop()
        }}
      />
      {/* Виджеты и иконки лежат в DOM раньше окон ⇒ ниже по стеку — окно поверх перекрывает их как обычное окно. */}
      <DesktopIcon />
      <TodayWidgets />
      {windowIds.map((id) => (
        <Window key={id} winId={id} desktopSize={size} />
      ))}
    </div>
  )
}
