import * as React from 'react'
import { cn } from '@/lib/utils'

type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  /** Coss visual size; a number is forwarded as the native input size attribute. */
  size?: 'sm' | 'default' | 'lg' | number
  /** Compatibility flags used by Coss composite controls. */
  nativeInput?: boolean
  unstyled?: boolean
}

function Input({ className, type, size = 'default', nativeInput: _nativeInput, unstyled = false, ...props }: InputProps) {
  const nativeSize = typeof size === 'number' ? size : undefined
  return (
    <input
      type={type}
      size={nativeSize}
      data-size={typeof size === 'string' ? size : 'default'}
      data-slot={unstyled ? 'input-control' : 'input'}
      className={cn(
        !unstyled &&
          'h-8 w-full min-w-0 rounded-lg border border-input bg-popover px-2.5 text-sm text-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:opacity-60',
        !unstyled &&
          'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30',
        unstyled && 'w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground',
        size === 'sm' && !unstyled && 'h-7 px-2 text-xs',
        size === 'lg' && !unstyled && 'h-9 px-3',
        className
      )}
      {...props}
    />
  )
}

export { Input, type InputProps }
