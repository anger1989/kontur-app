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
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  const animations: MotionProps = {
    initial: { scale: 0.92, opacity: 0, y: -8 },
    animate: { scale: 1, opacity: 1, y: 0, originY: 0 },
    exit: { scale: 0.96, opacity: 0, y: -6 },
    transition: { type: 'spring', stiffness: 380, damping: 28 }
  }

  return (
    <motion.div {...animations} layout className={cn('w-full', className)}>
      {children}
    </motion.div>
  )
}

export interface AnimatedListProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode
  /** Зарезервировано для совместимости с Magic UI API (демо-stagger). */
  delay?: number
}

/**
 * Список с spring-появлением / уходом (Magic UI Animated List).
 * Все элементы видны сразу; анимация — при add/remove по `key` (новые уведомления).
 */
export const AnimatedList = React.memo(function AnimatedList({
  children,
  className,
  delay: _delay,
  ...props
}: AnimatedListProps) {
  void _delay
  const childrenArray = useMemo(() => React.Children.toArray(children), [children])

  return (
    <div className={cn('flex flex-col gap-1.5', className)} {...props}>
      <AnimatePresence initial={false} mode="popLayout">
        {childrenArray.map((child, i) => {
          const el = child as ReactElement
          const key = el.key ?? `idx-${i}`
          return (
            <AnimatedListItem key={key}>{child}</AnimatedListItem>
          )
        })}
      </AnimatePresence>
    </div>
  )
})

AnimatedList.displayName = 'AnimatedList'
