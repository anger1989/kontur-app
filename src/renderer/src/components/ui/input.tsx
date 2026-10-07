import * as React from "react"
import { cn } from "@/lib/utils"
import { HoverBorderRing } from "@/components/ui/hover-border-gradient"

/**
 * Классы, которые описывают место поля в раскладке, а не само поле: отступы,
 * flex/grid-участие, ширина, display. С обёрткой (её требует кольцо Hover Border
 * Gradient — у <input> не бывает детей) они должны жить на обёртке, иначе
 * `sm:flex-[2]` или `mt-2` перестанут действовать на flex-родителя.
 */
const LAYOUT_RE =
  /^-?(m[trblxyse]?-|w-|min-w-|max-w-|flex-|grow|shrink|basis-|self-|order-|col-|row-|justify-self-|place-self-|hidden$|block$|inline-block$)/

export function splitLayoutClasses(className?: string): { wrapper: string; own: string } {
  const wrapper: string[] = []
  const own: string[] = []
  for (const token of (className ?? "").split(/\s+/).filter(Boolean)) {
    // `sm:hover:mt-2` → смотрим на саму утилиту после вариантов; `!` — important.
    const base = token.split(":").pop()!.replace(/^!/, "")
    if (LAYOUT_RE.test(base)) wrapper.push(token)
    else if (/^rounded/.test(base)) {
      // Скругление нужно обоим: полю — для вида, обёртке — чтобы кольцо повторило форму.
      wrapper.push(token)
      own.push(token)
    } else own.push(token)
  }
  return { wrapper: wrapper.join(" "), own: own.join(" ") }
}

/** Общая обёртка с кольцом для Input и Textarea. */
export function useHoverRing<E extends HTMLElement>(
  onMouseEnter?: React.MouseEventHandler<E>,
  onMouseLeave?: React.MouseEventHandler<E>
): {
  hovered: boolean
  handlers: { onMouseEnter: React.MouseEventHandler<E>; onMouseLeave: React.MouseEventHandler<E> }
} {
  const [hovered, setHovered] = React.useState(false)
  return {
    hovered,
    handlers: {
      onMouseEnter: (e) => {
        setHovered(true)
        onMouseEnter?.(e)
      },
      onMouseLeave: (e) => {
        setHovered(false)
        onMouseLeave?.(e)
      }
    }
  }
}

function Input({ className, type, onMouseEnter, onMouseLeave, ...props }: React.ComponentProps<"input">) {
  const { hovered, handlers } = useHoverRing(onMouseEnter, onMouseLeave)
  const { wrapper, own } = splitLayoutClasses(className)
  return (
    <span data-slot="input-wrapper" className={cn("relative block w-full min-w-0 rounded-md", wrapper)}>
      <input
        type={type}
        data-slot="input"
        className={cn(
          "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          own
        )}
        {...handlers}
        {...props}
      />
      <HoverBorderRing active={hovered && !props.disabled} />
    </span>
  )
}

export { Input }
