/**
 * Aceternity Terminal — демо с «печатной машинкой» + живая обёртка над zsh (PTY).
 * @see https://ui.aceternity.com (registry: @aceternity/terminal)
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject
} from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { takeAssistantRestart } from '@/lib/assistantSession'
import { cn } from '@/lib/utils'

const KEY_SOUNDS_DOWN: Record<string, [number, number]> = {
  A: [31542, 85],
  B: [40621, 107],
  C: [39632, 95],
  D: [32492, 85],
  E: [23317, 83],
  F: [32973, 87],
  G: [33453, 94],
  H: [33986, 93],
  I: [25795, 91],
  J: [34425, 88],
  K: [34932, 90],
  L: [35410, 95],
  M: [41610, 93],
  N: [41103, 90],
  O: [26309, 84],
  P: [26804, 83],
  Q: [22245, 95],
  R: [23817, 92],
  S: [32031, 88],
  T: [24297, 92],
  U: [25313, 95],
  V: [40136, 94],
  W: [22790, 89],
  X: [39148, 76],
  Y: [24811, 93],
  Z: [38694, 80],
  ' ': [51541, 144],
  '-': [42594, 90],
  '@': [23317, 83],
  '/': [42594, 90],
  '.': [42594, 90],
  ':': [42594, 90],
  '0': [26309, 84],
  '1': [25313, 95],
  '2': [23317, 83],
  '3': [23817, 92],
  '4': [24297, 92],
  '5': [24811, 93],
  '6': [25313, 95],
  '7': [25795, 91],
  '8': [26309, 84],
  '9': [26804, 83],
  Enter: [19065, 110]
}

const KEY_SOUNDS_UP: Record<string, [number, number]> = {
  A: [31632, 80],
  B: [40736, 95],
  C: [39732, 85],
  D: [32577, 80],
  E: [23402, 80],
  F: [33063, 80],
  G: [33553, 85],
  H: [34081, 85],
  I: [25890, 85],
  J: [34515, 85],
  K: [35027, 85],
  L: [35510, 85],
  M: [41710, 85],
  N: [41198, 85],
  O: [26394, 80],
  P: [26889, 80],
  Q: [22345, 85],
  R: [23912, 85],
  S: [32121, 80],
  T: [24392, 85],
  U: [25413, 85],
  V: [40236, 85],
  W: [22880, 85],
  X: [39228, 70],
  Y: [24911, 85],
  Z: [38779, 75],
  ' ': [51691, 130],
  '-': [42689, 85],
  '@': [23402, 80],
  '/': [42689, 85],
  '.': [42689, 85],
  ':': [42689, 85],
  '0': [26394, 80],
  '1': [25413, 85],
  '2': [23402, 80],
  '3': [23912, 85],
  '4': [24392, 85],
  '5': [24911, 85],
  '6': [25413, 85],
  '7': [25890, 85],
  '8': [26394, 80],
  '9': [26889, 80],
  Enter: [19180, 100]
}

function useAudio(enabled: boolean): {
  down: (key: string) => void
  up: (key: string) => void
} {
  const ctxRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const readyRef = useRef(false)

  useEffect(() => {
    readyRef.current = false
    if (!enabled) return

    const controller = new AbortController()
    let context: AudioContext | null = null
    let started = false

    const removeListeners = (): void => {
      window.removeEventListener('click', initAudio)
      window.removeEventListener('keydown', initAudio)
    }

    async function initAudio(): Promise<void> {
      if (started) return
      started = true
      removeListeners()

      try {
        context = new AudioContext()
        ctxRef.current = context
        void context.resume().catch(() => {})
        const response = await fetch('/sounds/sound.ogg', { signal: controller.signal })
        if (!response.ok || controller.signal.aborted) return
        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted) return
        const buffer = await context.decodeAudioData(bytes)
        if (controller.signal.aborted) return
        bufferRef.current = buffer
        readyRef.current = true
      } catch {
        /* демо не должно падать из‑за звука */
      }
    }

    window.addEventListener('click', initAudio, { once: true })
    window.addEventListener('keydown', initAudio, { once: true })

    return () => {
      removeListeners()
      controller.abort()
      readyRef.current = false
      bufferRef.current = null
      ctxRef.current = null
      if (context) void context.close().catch(() => {})
    }
  }, [enabled])

  const playSound = (sound: [number, number] | undefined): void => {
    if (!readyRef.current || !ctxRef.current || !bufferRef.current || !sound) return
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume()
    const src = ctxRef.current.createBufferSource()
    src.buffer = bufferRef.current
    src.connect(ctxRef.current.destination)
    src.start(0, sound[0] / 1000, sound[1] / 1000)
  }

  return {
    down: (key: string) => playSound(KEY_SOUNDS_DOWN[key.toUpperCase()] || KEY_SOUNDS_DOWN[key]),
    up: (key: string) => playSound(KEY_SOUNDS_UP[key.toUpperCase()] || KEY_SOUNDS_UP[key])
  }
}

function useInView(ref: RefObject<HTMLElement | null>, once = true): boolean {
  const [inView, setInView] = useState(false)
  const triggered = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || (once && triggered.current)) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !triggered.current) {
          setInView(true)
          if (once) {
            triggered.current = true
            observer.disconnect()
          }
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, once])

  return inView
}

type TokenType =
  | 'command'
  | 'flag'
  | 'string'
  | 'number'
  | 'operator'
  | 'path'
  | 'variable'
  | 'comment'
  | 'default'

interface Token {
  type: TokenType
  value: string
}

function tokenizeBash(text: string): Token[] {
  const tokens: Token[] = []
  const words = text.split(/(\s+)/)
  let isFirstWord = true

  for (const word of words) {
    if (/^\s+$/.test(word)) {
      tokens.push({ type: 'default', value: word })
      continue
    }
    if (word.startsWith('#')) {
      tokens.push({ type: 'comment', value: word })
      continue
    }
    if (word.startsWith('$')) {
      tokens.push({ type: 'variable', value: word })
      isFirstWord = false
      continue
    }
    if (word.startsWith('--') || word.startsWith('-')) {
      tokens.push({ type: 'flag', value: word })
      isFirstWord = false
      continue
    }
    if (/^["'].*["']$/.test(word)) {
      tokens.push({ type: 'string', value: word })
      isFirstWord = false
      continue
    }
    if (/^\d+$/.test(word)) {
      tokens.push({ type: 'number', value: word })
      isFirstWord = false
      continue
    }
    if (/^[|>&<]+$/.test(word)) {
      tokens.push({ type: 'operator', value: word })
      isFirstWord = true
      continue
    }
    if (word.includes('/') || word.startsWith('.') || word.startsWith('~')) {
      tokens.push({ type: 'path', value: word })
      isFirstWord = false
      continue
    }
    if (isFirstWord) {
      tokens.push({ type: 'command', value: word })
      isFirstWord = false
      continue
    }
    tokens.push({ type: 'default', value: word })
  }

  return tokens
}

const tokenColors: Record<TokenType, string> = {
  command: 'text-emerald-400',
  flag: 'text-sky-400',
  string: 'text-amber-300',
  number: 'text-purple-400',
  operator: 'text-red-400',
  path: 'text-cyan-300',
  variable: 'text-pink-400',
  comment: 'text-neutral-500',
  default: 'text-neutral-300'
}

function SyntaxHighlightedText({ text }: { text: string }): JSX.Element {
  const tokens = tokenizeBash(text)
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} className={tokenColors[token.type]}>
          {token.value}
        </span>
      ))}
    </>
  )
}

interface TerminalLine {
  type: 'command' | 'output'
  content: string
}

export interface TerminalProps {
  commands: string[]
  outputs?: Record<number, string[]>
  username?: string
  className?: string
  typingSpeed?: number
  delayBetweenCommands?: number
  initialDelay?: number
  enableSound?: boolean
}

/** Демо-режим: анимация набора команд (оригинал Aceternity). */
export function Terminal({
  commands = ['npx shadcn@latest init'],
  outputs = {},
  username = 'kontur',
  className,
  typingSpeed = 50,
  delayBetweenCommands = 800,
  initialDelay = 500,
  enableSound = true
}: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const inView = useInView(containerRef)
  const { down, up } = useAudio(enableSound)

  const [lines, setLines] = useState<TerminalLine[]>([])
  const [currentText, setCurrentText] = useState('')
  const [commandIdx, setCommandIdx] = useState(0)
  const [charIdx, setCharIdx] = useState(0)
  const [outputIdx, setOutputIdx] = useState(-1)
  const [phase, setPhase] = useState<
    'idle' | 'typing' | 'executing' | 'outputting' | 'pausing' | 'done'
  >('idle')
  const [cursorVisible, setCursorVisible] = useState(true)

  const currentCommand = commands[commandIdx] || ''
  const currentOutputs = useMemo(() => outputs[commandIdx] || [], [outputs, commandIdx])
  const isLastCommand = commandIdx === commands.length - 1

  useEffect(() => {
    if (!inView || phase !== 'idle') return
    const t = setTimeout(() => setPhase('typing'), initialDelay)
    return () => clearTimeout(t)
  }, [inView, phase, initialDelay])

  useEffect(() => {
    if (phase !== 'typing') return

    if (charIdx < currentCommand.length) {
      const char = currentCommand[charIdx]
      down(char)
      const t = setTimeout(
        () => {
          up(char)
          setCurrentText(currentCommand.slice(0, charIdx + 1))
          setCharIdx((c) => c + 1)
        },
        typingSpeed + Math.random() * 30
      )
      return () => clearTimeout(t)
    }

    down('Enter')
    const t = setTimeout(() => {
      up('Enter')
      setPhase('executing')
    }, 80)
    return () => clearTimeout(t)
  }, [phase, charIdx, currentCommand, typingSpeed, down, up])

  useEffect(() => {
    if (phase !== 'executing') return

    setLines((prev) => [...prev, { type: 'command', content: currentCommand }])
    setCurrentText('')

    if (currentOutputs.length > 0) {
      setOutputIdx(0)
      setPhase('outputting')
    } else if (isLastCommand) {
      setPhase('done')
    } else {
      setPhase('pausing')
    }
  }, [phase, currentCommand, currentOutputs.length, isLastCommand])

  useEffect(() => {
    if (phase !== 'outputting') return

    if (outputIdx >= 0 && outputIdx < currentOutputs.length) {
      const t = setTimeout(() => {
        setLines((prev) => [...prev, { type: 'output', content: currentOutputs[outputIdx] }])
        setOutputIdx((i) => i + 1)
      }, 150)
      return () => clearTimeout(t)
    }

    if (outputIdx >= currentOutputs.length) {
      const t = setTimeout(() => {
        setPhase(isLastCommand ? 'done' : 'pausing')
      }, 300)
      return () => clearTimeout(t)
    }
  }, [phase, outputIdx, currentOutputs, isLastCommand])

  useEffect(() => {
    if (phase !== 'pausing') return
    const t = setTimeout(() => {
      setCharIdx(0)
      setOutputIdx(-1)
      setCommandIdx((c) => c + 1)
      setPhase('typing')
    }, delayBetweenCommands)
    return () => clearTimeout(t)
  }, [phase, delayBetweenCommands])

  useEffect(() => {
    const interval = setInterval(() => setCursorVisible((v) => !v), 530)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [lines, phase])

  const prompt = (
    <span className="text-neutral-500">
      <span className="text-sky-500">{username}</span>
      <span className="text-emerald-600">:</span>
      <span className="text-sky-400">~</span>
      <span className="text-neutral-500">$</span>{' '}
    </span>
  )

  return (
    <div ref={containerRef} className={cn('mx-auto w-full max-w-xl px-4 font-mono text-xs', className)}>
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl">
        <TerminalChrome title={`${username} — bash`} />
        <div ref={contentRef} className="h-80 overflow-y-auto p-4 font-mono">
          {lines.map((line, i) => (
            <div key={i} className="leading-relaxed whitespace-pre-wrap">
              {line.type === 'command' ? (
                <span>
                  {prompt}
                  <SyntaxHighlightedText text={line.content} />
                </span>
              ) : (
                <span className="text-neutral-400">{line.content}</span>
              )}
            </div>
          ))}

          {phase === 'typing' && (
            <div className="leading-relaxed whitespace-pre-wrap">
              {prompt}
              <SyntaxHighlightedText text={currentText} />
              <span className="ml-0.5 inline-block h-4 w-2 bg-neutral-300 align-middle" />
            </div>
          )}

          {(phase === 'done' || phase === 'pausing' || phase === 'outputting') && (
            <div className="leading-relaxed whitespace-pre-wrap">
              {prompt}
              <span
                className={cn(
                  'inline-block h-4 w-2 bg-neutral-300 align-middle transition-opacity duration-100',
                  !cursorVisible && 'opacity-0'
                )}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TerminalChrome({ title }: { title: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 bg-neutral-800 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <div className="h-3 w-3 rounded-full bg-red-500" />
        <div className="h-3 w-3 rounded-full bg-yellow-500" />
        <div className="h-3 w-3 rounded-full bg-green-500" />
      </div>
      <div className="min-w-0 flex-1 text-center">
        <span className="truncate text-xs text-neutral-400">{title}</span>
      </div>
      <div className="w-[52px]" />
    </div>
  )
}

export interface LiveTerminalProps {
  className?: string
  /** Показать декоративный title bar (в окне Kontur обычно false — свой chrome). */
  chrome?: boolean
  username?: string
  cwd?: string
  /** Должен совпадать с рендером — иначе FitAddon врёт rows и курсор agent'а уезжает. */
  fontSize?: number
  /**
   * Вкладки: неактивные остаются смонтированными (PTY живёт), но скрыты.
   * При активации — fit + focus.
   */
  active?: boolean
  /**
   * Именованная PTY-сессия в main. Повторный mount (виджет ↔ окно) подключает
   * тот же процесс и дописывает scrollback.
   */
  sessionKey?: string
  /** `agent` — Cursor Agent CLI; по умолчанию login-shell. */
  profile?: 'shell' | 'agent'
  /**
   * Не убивать PTY при unmount. Нужно для ассистента: сессия живёт при
   * переключении виджет ↔ окно и пока виджет скрыт.
   */
  keepAlive?: boolean
  /** Сброс сессии (перезапуск agent): меняется снаружи → kill + create. */
  restartToken?: number
  /** OSC/title с xterm — для подписи вкладки. */
  onTitle?: (title: string) => void
  /** Сессия завершилась (exit) — вкладка может показать статус. */
  onExit?: (info: { exitCode: number; signal: number | null }) => void
}

/** Ждём ненулевой box — иначе FitAddon no-op и PTY стартует с дефолтом 80×24. */
function waitForHostSize(el: HTMLElement, signal: AbortSignal): Promise<void> {
  if (el.clientWidth >= 40 && el.clientHeight >= 40) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = (): void => {
      ro.disconnect()
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      ro.disconnect()
      reject(new DOMException('aborted', 'AbortError'))
    }
    const ro = new ResizeObserver(() => {
      if (el.clientWidth >= 40 && el.clientHeight >= 40) done()
    })
    ro.observe(el)
    signal.addEventListener('abort', onAbort)
    requestAnimationFrame(() => {
      if (el.clientWidth >= 40 && el.clientHeight >= 40) done()
    })
  })
}

/**
 * Живой zsh / agent через node-pty + xterm, в визуале Aceternity Terminal.
 * Окно приложения даёт свой title bar — здесь `chrome={false}` по умолчанию.
 *
 * Ввод — полный passthrough в PTY (как iTerm/Terminal.app). Локальный
 * line-buffer + stty -echo ломают TUI (Cursor Agent, vim, less): клавиши
 * до Enter не доходят до приложения, alternate screen рисуется криво.
 * Подсветку команд даёт сам шелл (zsh-syntax-highlighting) или демо-Terminal.
 */
export function LiveTerminal({
  className,
  chrome = false,
  username,
  cwd,
  fontSize = 13,
  active = true,
  sessionKey,
  profile,
  keepAlive = false,
  restartToken = 0,
  onTitle,
  onExit
}: LiveTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const keepAliveRef = useRef(keepAlive)
  keepAliveRef.current = keepAlive
  const onTitleRef = useRef(onTitle)
  const onExitRef = useRef(onExit)
  onTitleRef.current = onTitle
  onExitRef.current = onExit
  const [title, setTitle] = useState(`${username ?? 'kontur'} — zsh`)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      // Canvas measureText не понимает var(--font-*) — иначе метрики ячейки
      // расходятся с отрисовкой и курсор agent'а уезжает от строки ввода.
      fontFamily: "'IBM Plex Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize,
      // 1.0 — FitAddon считает rows по метрикам шрифта; lineHeight>1 раздувает
      // визуал относительно fit и оставляет «пустой» низ с курсором.
      lineHeight: 1,
      letterSpacing: 0,
      // macOS Option как Meta — привычные шорткаты шелла.
      macOptionIsMeta: true,
      allowTransparency: false,
      // FitAddon резервирует 14px под overview ruler при scrollback>0 —
      // для agent TUI скролл не нужен, лишний запас врёт cols.
      scrollback: profile === 'agent' ? 0 : 1000,
      theme: {
        background: '#171717',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#171717',
        selectionBackground: '#404040',
        black: '#171717',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#38bdf8',
        magenta: '#f472b6',
        cyan: '#22d3ee',
        white: '#d4d4d4',
        brightBlack: '#737373',
        brightRed: '#fca5a5',
        brightGreen: '#6ee7b7',
        brightYellow: '#fde68a',
        brightBlue: '#7dd3fc',
        brightMagenta: '#f9a8d4',
        brightCyan: '#67e8f9',
        brightWhite: '#f5f5f5'
      },
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined
    let roTimer: ReturnType<typeof setTimeout> | null = null
    const ac = new AbortController()

    /**
     * FitAddon берёт getComputedStyle(parent).height и НЕ вычитает padding родителя.
     * Хост без padding (см. JSX) — иначе rows завышены и курсор TUI ниже поля ввода.
     * Дополнительно клампим по реальному content-box (client* минус padding).
     */
    const syncSize = (force = false): void => {
      try {
        fit.fit()
      } catch {
        return
      }
      const core = (
        term as unknown as {
          _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } }
        }
      )._core
      const cell = core?._renderService?.dimensions?.css?.cell
      if (cell && cell.width > 0 && cell.height > 0) {
        const cs = getComputedStyle(host)
        const padX =
          (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        const padY =
          (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
        const cols = Math.max(2, Math.floor((host.clientWidth - padX) / cell.width))
        const rows = Math.max(1, Math.floor((host.clientHeight - padY) / cell.height))
        if (cols !== term.cols || rows !== term.rows) {
          try {
            term.resize(cols, rows)
          } catch {
            /* ignore */
          }
        }
      }
      const cols = term.cols
      const rows = term.rows
      if (!force && cols === sizeRef.current.cols && rows === sizeRef.current.rows) return
      sizeRef.current = { cols, rows }
      const id = sessionIdRef.current
      if (id) void window.kontur.terminal.resize(id, cols, rows)
      term.scrollToBottom()
    }

    const boot = async (): Promise<void> => {
      try {
        // Метрики ячейки до загрузки веб-шрифта = fallback → после подмены курсор плывёт.
        try {
          await document.fonts.ready
        } catch {
          /* ignore */
        }
        await waitForHostSize(host, ac.signal)
        if (disposed) return
        syncSize(true)
        term.focus()

        // Перезапуск только если seq ещё не применяли (не на каждый remount).
        if (sessionKey && restartToken > 0 && takeAssistantRestart(restartToken)) {
          const prev = await window.kontur.terminal.create({
            cols: term.cols,
            rows: term.rows,
            cwd,
            key: sessionKey,
            profile
          })
          void window.kontur.terminal.kill(prev.id)
        }

        const session = await window.kontur.terminal.create({
          cols: term.cols,
          rows: term.rows,
          cwd,
          key: sessionKey,
          profile
        })
        if (disposed) {
          if (!keepAliveRef.current) void window.kontur.terminal.kill(session.id)
          return
        }
        sessionIdRef.current = session.id
        const shellName = session.shell.split('/').pop() ?? 'zsh'
        const initial = `${username ?? 'kontur'} — ${shellName}`
        setTitle(initial)
        onTitleRef.current?.(shellName)

        // Сначала resize под хост — иначе replay/TUI рисуются в чужом 80×24.
        syncSize(true)

        // Agent TUI: replay ANSI со старым размером ломает курсор (виджет↔окно).
        // Двойной SIGWINCH (rows±1) — иначе часть сборок agent не перерисовывает composer.
        if (profile === 'agent' && session.reused) {
          const id = session.id
          const { cols, rows } = term
          void window.kontur.terminal.resize(id, cols, Math.max(8, rows - 1)).then(() => {
            if (!disposed) void window.kontur.terminal.resize(id, cols, rows)
          })
        } else if (session.scrollback) {
          term.write(session.scrollback)
          term.scrollToBottom()
        }

        term.onTitleChange((t) => {
          const next = t.trim() || shellName
          setTitle(next)
          onTitleRef.current?.(next)
        })

        offData = window.kontur.terminal.onData((id, data) => {
          if (id === session.id) term.write(data)
        })
        offExit = window.kontur.terminal.onExit((id, info) => {
          if (id !== session.id) return
          term.writeln('')
          term.writeln(
            `\x1b[90m[сессия завершена: code=${info.exitCode}${info.signal != null ? ` signal=${info.signal}` : ''}]\x1b[0m`
          )
          sessionIdRef.current = null
          onExitRef.current?.(info)
        })

        // Каждый кейстрок сразу в PTY — иначе raw-mode TUI (agent) не получает `a` до Enter.
        term.onData((data) => {
          const id = sessionIdRef.current
          if (id) void window.kontur.terminal.write(id, data)
        })

        // Повторный fit после layout (шрифты/паддинги).
        requestAnimationFrame(() => {
          if (!disposed) syncSize(true)
        })
      } catch (e) {
        if (disposed || (e instanceof DOMException && e.name === 'AbortError')) return
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        term.writeln(`\x1b[31m${msg}\x1b[0m`)
      }
    }

    void boot()

    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer)
      roTimer = setTimeout(() => {
        if (!disposed) syncSize()
      }, 50)
    })
    ro.observe(host)

    return () => {
      disposed = true
      ac.abort()
      if (roTimer) clearTimeout(roTimer)
      ro.disconnect()
      offData?.()
      offExit?.()
      const id = sessionIdRef.current
      sessionIdRef.current = null
      if (id && !keepAliveRef.current) void window.kontur.terminal.kill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [cwd, username, sessionKey, profile, restartToken, fontSize])

  // Вкладка снова видна — подогнать размер (пока была скрыта host 0×0) и фокус.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    requestAnimationFrame(() => {
      try {
        fit.fit()
        const core = (
          term as unknown as {
            _core?: {
              _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } }
            }
          }
        )._core
        const cell = core?._renderService?.dimensions?.css?.cell
        if (cell && cell.width > 0 && cell.height > 0) {
          const cols = Math.max(2, Math.floor(host.clientWidth / cell.width))
          const rows = Math.max(1, Math.floor(host.clientHeight / cell.height))
          if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
        }
        const cols = term.cols
        const rows = term.rows
        sizeRef.current = { cols, rows }
        const id = sessionIdRef.current
        if (id) void window.kontur.terminal.resize(id, cols, rows)
        term.scrollToBottom()
        term.focus()
      } catch {
        /* ignore */
      }
    })
  }, [active])

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden bg-neutral-900 font-mono text-xs',
        chrome && 'rounded-lg border border-neutral-800 shadow-2xl',
        className
      )}
      onClick={() => termRef.current?.focus()}
    >
      {chrome ? <TerminalChrome title={title} /> : null}
      {error ? (
        <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}
      {/*
        Padding снаружи хоста: FitAddon меряет parent без вычета padding и
        завышает rows → курсор agent ниже строки ввода. Без h-full на .xterm.
      */}
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={hostRef}
          className={cn(
            'h-full min-h-0 w-full overflow-hidden',
            profile !== 'agent' && '[&_.xterm-viewport]:!overflow-auto'
          )}
        />
      </div>
    </div>
  )
}
