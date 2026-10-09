import React, {
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode
} from 'react'
import { AnimatePresence, motion, type MotionProps } from 'motion/react'
import { cn } from '@/lib/utils'

export function AnimatedListItem({
  children,
  className,
  index = 0,
  delay = 0,
  layout = true
}: {
  children: ReactNode
  className?: string
  index?: number
  /** Секунды между соседними элементами при stagger. */
  delay?: number
  layout?: boolean
}): ReactElement {
  // Stagger только у «головы» списка (фильтр / первый экран).
  // Хвост при lazy-догрузке входит сразу spring'ом, без накопленной задержки.
  const stagger = delay > 0 && index < 16 ? index * delay : 0
  const animations: MotionProps = {
    initial: { scale: 0.92, opacity: 0, y: -8 },
    animate: { scale: 1, opacity: 1, y: 0, originY: 0 },
    exit: { scale: 0.96, opacity: 0, y: -6 },
    transition: { type: 'spring', stiffness: 380, damping: 28, delay: stagger }
  }

  return (
    <motion.div {...animations} layout={layout} className={cn('w-full min-w-0 max-w-full', className)}>
      {children}
    </motion.div>
  )
}

export interface AnimatedListProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode
  /** Stagger между элементами, секунды (Magic UI delay). */
  delay?: number
  /** Анимировать первый mount (по умолчанию выкл.). */
  animateInitial?: boolean
  /** layout-анимации Framer — дорого на длинных списках. */
  layout?: boolean
}

/**
 * Список с spring-появлением / уходом (Magic UI Animated List).
 * Анимация — при add/remove по `key`; stagger — через `delay`.
 */
export const AnimatedList = React.memo(function AnimatedList({
  children,
  className,
  delay = 0,
  animateInitial = false,
  layout = true,
  ...props
}: AnimatedListProps) {
  const childrenArray = useMemo(() => React.Children.toArray(children), [children])

  return (
    <div className={cn('flex flex-col gap-1.5', className)} {...props}>
      <AnimatePresence initial={animateInitial} mode="popLayout">
        {childrenArray.map((child, i) => {
          const el = child as ReactElement
          const key = el.key ?? `idx-${i}`
          return (
            <AnimatedListItem key={key} index={i} delay={delay} layout={layout}>
              {child}
            </AnimatedListItem>
          )
        })}
      </AnimatePresence>
    </div>
  )
})

AnimatedList.displayName = 'AnimatedList'
