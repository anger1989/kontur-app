import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from 'radix-ui'
import { Spinner } from '@/components/ui/spinner'

const buttonVariants = cva(
  "relative inline-flex w-fit shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-sm font-medium outline-none transition-[background-color,border-color,box-shadow,color] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60 data-loading:select-none data-loading:text-transparent [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/20 before:shadow-[inset_0_1px_rgb(255_255_255/0.16)] hover:bg-primary/90 active:shadow-none',
        destructive:
          'border-destructive bg-destructive text-white shadow-xs shadow-destructive/20 before:shadow-[inset_0_1px_rgb(255_255_255/0.16)] hover:bg-destructive/90 focus-visible:ring-destructive/30 active:shadow-none',
        'destructive-outline':
          'border-input bg-popover text-destructive-foreground shadow-xs hover:border-destructive/30 hover:bg-destructive/5',
        outline:
          'border-input bg-popover text-foreground shadow-xs before:shadow-[inset_0_1px_rgb(255_255_255/0.04)] hover:bg-accent/70 active:shadow-none dark:bg-input/30',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'border-transparent text-foreground hover:bg-accent active:bg-accent/80',
        link: 'border-transparent text-brand underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-7 gap-1.5 px-2.5',
        lg: 'h-9 px-3.5',
        xl: 'h-10 px-4 text-base',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
        'icon-xl': 'size-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button'
  const disabled = loading || disabledProp
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? '' : undefined}
      aria-disabled={loading || undefined}
      disabled={disabled}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
      {loading ? <Spinner className="pointer-events-none absolute" data-slot="button-loading-indicator" /> : null}
    </Comp>
  )
}

export { Button, buttonVariants }
