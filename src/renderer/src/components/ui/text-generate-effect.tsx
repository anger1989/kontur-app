import { useEffect, type JSX } from 'react'
import { motion, stagger, useAnimate } from 'motion/react'
import { cn } from '@/lib/utils'

/**
 * Aceternity Text Generate Effect — слова проявляются по очереди с blur→sharp.
 * Цвет/кегль задаются через `className` (наследуются span'ами).
 */
export function TextGenerateEffect({
  words,
  className,
  filter = true,
  duration = 0.5
}: {
  words: string
  className?: string
  filter?: boolean
  duration?: number
}): JSX.Element {
  const [scope, animate] = useAnimate()
  const wordsArray = words.split(' ')

  useEffect(() => {
    void animate(
      'span',
      {
        opacity: 1,
        filter: filter ? 'blur(0px)' : 'none'
      },
      {
        duration: duration || 1,
        delay: stagger(0.2)
      }
    )
  }, [animate, duration, filter, words])

  return (
    <div className={cn('font-bold', className)}>
      <motion.div ref={scope} className="leading-snug tracking-wide">
        {wordsArray.map((word, idx) => (
          <motion.span
            key={word + idx}
            className="opacity-0"
            style={{ filter: filter ? 'blur(10px)' : 'none' }}
          >
            {word}{' '}
          </motion.span>
        ))}
      </motion.div>
    </div>
  )
}
