import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import { Slot } from 'radix-ui'
import { HoverBorderRing } from '@/components/ui/hover-border-gradient'

/**
 * Кнопки без GlowingEffect: абсолютный glow внутри `w-full` ломал flex-ряды
 * (Настройки → «Подключить» растягивался на всю карточку). Вместо него на
 * hover — Hover Border Gradient (кольцо внутри самой кнопки, раскладку не
 * трогает). Lift (`hover:-translate-y-0.5`) убран: кнопки не должны прыгать.
 */
const buttonVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition duration-200 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Палитра — токены темы, как во всём приложении. Кольцо Hover Border
      // Gradient рисует себя само (absolute -inset-px), собственная рамка и
      // непрозрачный фон кнопке для него не нужны: с ними `ghost` переставал
      // быть призрачным и настройки превращались в россыпь тёмных плашек.
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10'
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
  disabled,
  onMouseEnter,
  onMouseLeave,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }): React.JSX.Element {
  const [hovered, setHovered] = React.useState(false)
  const Comp = asChild ? Slot.Root : 'button'
  // У ссылки-кнопки нет рамки — рисовать кольцо не вокруг чего.
  const ring = variant !== 'link' && <HoverBorderRing active={hovered && !disabled} />
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={disabled}
      // relative — точка отсчёта для кольца; className после, чтобы absolute/fixed
      // у конкретной кнопки по-прежнему побеждали.
      className={cn(buttonVariants({ variant, size }), 'relative', className)}
      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
        setHovered(true)
        onMouseEnter?.(e)
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
        setHovered(false)
        onMouseLeave?.(e)
      }}
      {...props}
    >
      {/* Slot требует ровно одного «своего» ребёнка — кольцо идёт рядом через Slottable. */}
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
      {ring}
    </Comp>
  )
}

export { Button, buttonVariants }
