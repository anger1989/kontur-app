import { useEffect, useRef, type CSSProperties, type JSX, type ReactNode } from 'react'
import { motion, useAnimation, useInView, useSpring, type Variants } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * Карточка с одной большой цифрой и столбиками — общий язык виджетов.
 *
 * Строение: приглушённый заголовок с шевроном-действием, крупное число,
 * которое «докручивается» при появлении, пояснение под ним и график, чьи
 * столбики вырастают по очереди. Последний столбик — сегодня, он выделен.
 *
 * Отличия от исходного образца:
 * — `motion/react` вместо framer-motion: это один и тот же пакет, и второй
 *   экземпляр анимаций проекту не нужен;
 * — `staggerChildren` живёт в варианте контейнера, а не в пропе `transition`
 *   (во втором месте он не работает — столбики вырастали разом);
 * — число пишется в DOM сразу, не дожидаясь первого тика пружины: при
 *   значении 0 пружина не срабатывает вовсе и ячейка оставалась пустой;
 * — размеры компактные: виджет рабочего стола шириной ~280px, отступы
 *   страницы (`p-6`) съели бы половину карточки.
 */

export interface StatsBar {
  name: string
  /** Высота точки/столбика в процентах, 0…100. */
  value: number
  /** Свой цвет столбика — класс Tailwind. Перебивает выделение последнего. */
  color?: string
  /** Подсказка при наведении: обычно точное значение. */
  title?: string
  /** Подпись над точкой у линейного графика — настоящее число, а не процент. */
  label?: string
  /**
   * Эта точка — «сейчас»: её выделяем акцентом. Если ни одна не помечена,
   * выделяется последняя (у скользящего окна это и есть сегодня, а у недели
   * сегодня стоит посередине).
   */
  current?: boolean
}

export interface StatsCardProps {
  title: string
  value: number
  valuePrefix?: string
  valuePostfix?: string
  description?: ReactNode
  /** Строка под графиком — вторичные цифры, которые не тянут на главную. */
  footer?: ReactNode
  chartData?: StatsBar[]
  /**
   * `bars` — столбики по дням (хорошо читается «сколько в каждый день»).
   * `line` — ломаная с заливкой: видно направление, а не только высоты.
   */
  chartKind?: 'bars' | 'line'
  /** Есть действие — заголовок становится кнопкой с шевроном. */
  onActionClick?: () => void
  /** Карточка уже лежит в чужой рамке (виджет стола) — свою не рисуем. */
  bare?: boolean
  className?: string
  defaultBarColor?: string
  highlightedBarColor?: string
}

/** Число, которое докручивается до значения при появлении и при его смене. */
export function AnimatedNumber({
  value,
  prefix = '',
  postfix = ''
}: {
  value: number
  prefix?: string
  postfix?: string
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true })
  const spring = useSpring(0, { damping: 30, stiffness: 100, mass: 1 })

  useEffect(() => {
    if (inView) spring.set(value)
  }, [spring, inView, value])

  useEffect(() => {
    const write = (latest: number): void => {
      if (!ref.current) return
      ref.current.textContent = `${prefix}${new Intl.NumberFormat('ru-RU').format(
        Math.round(latest)
      )}${postfix}`
    }
    // Пишем текущее значение сразу: на нуле пружина не шелохнётся, и ячейка
    // осталась бы пустой до первой смены данных.
    write(spring.get())
    return spring.on('change', write)
  }, [prefix, postfix, spring])

  return <span ref={ref} />
}

/** Контейнер столбиков: запускает их по очереди, слева направо. */
const chartVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } }
}

const barVariants: Variants = {
  hidden: { height: '0%' },
  visible: {
    height: 'var(--bar-height, 0%)',
    transition: { type: 'spring', damping: 15, stiffness: 100 }
  }
}

/** Линия прочерчивается слева направо, заливка проявляется следом, потом точки. */
const lineVariants: Variants = {
  hidden: {},
  visible: { transition: { delayChildren: 0.1, staggerChildren: 0.05 } }
}

const strokeVariants: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: { pathLength: 1, opacity: 1, transition: { duration: 0.6, ease: 'easeOut' } }
}

const areaVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.5, delay: 0.25 } }
}

const dotVariants: Variants = {
  hidden: { scale: 0, opacity: 0 },
  visible: { scale: 1, opacity: 1, transition: { type: 'spring', damping: 14, stiffness: 240 } }
}

/** Геометрия линейного графика. Единицы — координаты viewBox, не пиксели. */
const LINE = { w: 280, h: 58, padX: 10, padTop: 13, plotH: 29, labelY: 55 } as const

/**
 * Ломаная по значениям-процентам.
 *
 * Отдельный компонент, потому что точки нужны трижды: под заливку, под саму
 * линию и под кружки с подписями — считать их в разметке значило бы считать
 * одно и то же три раза.
 */
function LineChart({
  data,
  accentClass,
  mutedClass
}: {
  data: StatsBar[]
  accentClass: string
  mutedClass: string
}): JSX.Element {
  const currentIndex = data.some((d) => d.current)
    ? data.findIndex((d) => d.current)
    : data.length - 1
  const { w, h, padX, padTop, plotH, labelY } = LINE
  const baseline = padTop + plotH
  const n = data.length
  const pts = data.map((d, i) => {
    const x = padX + (n <= 1 ? (w - padX * 2) / 2 : (i / (n - 1)) * (w - padX * 2))
    const y = baseline - (Math.min(100, Math.max(0, d.value)) / 100) * plotH
    return [x, y] as const
  })
  const polyline = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `${pts[0]?.[0] ?? padX},${baseline} ${polyline} ${pts[n - 1]?.[0] ?? w - padX},${baseline}`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[58px] w-full" role="img">
      <line
        x1={padX}
        y1={baseline}
        x2={w - padX}
        y2={baseline}
        className="stroke-border"
        strokeWidth={1}
      />
      <motion.polygon points={area} variants={areaVariants} className="fill-primary/15" />
      <motion.polyline
        points={polyline}
        variants={strokeVariants}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        className="stroke-primary"
      />
      {pts.map(([x, y], i) => {
        const d = data[i]!
        // Сегодняшняя точка крупнее — остальные дни недели ровнее.
        const isLast = i === currentIndex
        const has = d.value > 0
        return (
          <motion.g key={`${d.name}-${i}`} variants={dotVariants} style={{ originX: x, originY: y }}>
            <circle
              cx={x}
              cy={y}
              r={isLast ? 3.5 : 2.5}
              className={has || isLast ? accentClass : mutedClass}
            >
              <title>{d.title ?? `${d.name}: ${d.label ?? d.value}`}</title>
            </circle>
            {d.label && has && (
              <text
                x={x}
                y={y - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {d.label}
              </text>
            )}
            <text
              x={x}
              y={labelY}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {d.name}
            </text>
          </motion.g>
        )
      })}
    </svg>
  )
}

export function StatsCard({
  title,
  value,
  valuePrefix,
  valuePostfix,
  description,
  footer,
  chartData,
  chartKind = 'bars',
  onActionClick,
  bare,
  className,
  defaultBarColor = 'bg-foreground/15',
  highlightedBarColor = 'bg-primary'
}: StatsCardProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const inView = useInView(bodyRef, { once: true, amount: 0.4 })
  const controls = useAnimation()

  useEffect(() => {
    if (inView) void controls.start('visible')
  }, [inView, controls])

  const Header = onActionClick ? 'button' : 'div'
  const body = (
    <div ref={bodyRef} className="flex flex-col gap-2">
      <div>
        <p className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
          <AnimatedNumber value={value} prefix={valuePrefix} postfix={valuePostfix} />
        </p>
        {description && (
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{description}</p>
        )}
      </div>

      {chartData && chartData.length > 0 && chartKind === 'line' && (
        <motion.div initial="hidden" animate={controls} variants={lineVariants}>
          <LineChart
            data={chartData}
            accentClass="fill-primary"
            mutedClass="fill-muted-foreground/40"
          />
        </motion.div>
      )}

      {chartData && chartData.length > 0 && chartKind === 'bars' && (
        <motion.div
          className="flex h-14 w-full items-end gap-1.5"
          initial="hidden"
          animate={controls}
          variants={chartVariants}
          aria-hidden
        >
          {chartData.map((bar, i) => (
            <div key={`${bar.name}-${i}`} className="flex h-full flex-1 flex-col items-end gap-1">
              <div className="flex w-full flex-1 items-end" title={bar.title ?? `${bar.name}: ${bar.value}`}>
                <motion.div
                  className={cn(
                    'w-full rounded-t-[3px]',
                    bar.color ??
                      ((bar.current ?? i === chartData.length - 1)
                        ? highlightedBarColor
                        : defaultBarColor)
                  )}
                  variants={barVariants}
                  // Нулевой день всё равно рисуем полоской в 2px: иначе в ряду
                  // появляется дырка и непонятно, что день вообще был.
                  style={{ '--bar-height': `${Math.max(2, bar.value)}%` } as CSSProperties}
                />
              </div>
              <span className="text-[10px] leading-none text-muted-foreground">{bar.name}</span>
            </div>
          ))}
        </motion.div>
      )}

      {footer && <p className="text-[11px] text-muted-foreground tabular-nums">{footer}</p>}
    </div>
  )

  const header = (
    <Header
      type={onActionClick ? 'button' : undefined}
      onClick={onActionClick}
      aria-label={onActionClick ? `${title} — подробнее` : undefined}
      className={cn(
        'flex w-full items-center gap-1.5 text-left',
        onActionClick && 'group/stats rounded-md outline-none'
      )}
    >
      <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </span>
      {onActionClick && (
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/stats:translate-x-0.5" />
      )}
    </Header>
  )

  if (bare) {
    return (
      <div className={cn('flex flex-col gap-2 p-3', className)}>
        {header}
        {body}
      </div>
    )
  }

  return (
    <Card className={cn('gap-2 py-3', className)}>
      <CardHeader className="px-3">{header}</CardHeader>
      <CardContent className="px-3">{body}</CardContent>
    </Card>
  )
}

/**
 * Шапка виджета-списка: тот же приглушённый заголовок и тот же шеврон, что у
 * StatsCard. Вынесена отдельно, чтобы «Дела», «Автоматизации» и «Требует
 * внимания» читались с карточкой-метрикой как одна семья, а не как четыре
 * разных способа подписать коробку.
 */
export function WidgetHeader({
  title,
  count,
  action,
  children
}: {
  title: string
  count?: number
  /** Шеврон справа — переход к полному экрану раздела. */
  action?: { label: string; onClick: () => void }
  /** Свои кнопки перед шевроном (например «добавить»). */
  children?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1">
      <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </h2>
      {count != null && (
        <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {children}
        {action && (
          <button
            type="button"
            title={action.label}
            aria-label={action.label}
            onClick={action.onClick}
            className="group/act flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className="size-3.5 transition-transform group-hover/act:translate-x-0.5" />
          </button>
        )}
      </div>
    </div>
  )
}
