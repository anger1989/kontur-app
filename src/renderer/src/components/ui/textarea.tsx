import * as React from "react"
import { cn } from "@/lib/utils"
import { HoverBorderRing } from "@/components/ui/hover-border-gradient"
import { splitLayoutClasses, useHoverRing } from "@/components/ui/input"

const BASE =
  "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40"

function Textarea({ className, onMouseEnter, onMouseLeave, ...props }: React.ComponentProps<"textarea">) {
  const { hovered, handlers } = useHoverRing(onMouseEnter, onMouseLeave)

  // Безрамочная «поверхность» (редактор на всю панель, `border-0`) — не поле в
  // форме: кольцо там нарисовало бы рамку, которой нет, а обёртка сломала бы
  // растяжение `flex-1` по высоте. Оставляем как было.
  if (/(^|\s)border-0(\s|$)/.test(className ?? "")) {
    return (
      <textarea
        data-slot="textarea"
        className={cn(BASE, className)}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        {...props}
      />
    )
  }

  const { wrapper, own } = splitLayoutClasses(className)
  return (
    <span data-slot="textarea-wrapper" className={cn("relative block w-full min-w-0 rounded-md", wrapper)}>
      <textarea data-slot="textarea" className={cn(BASE, own)} {...handlers} {...props} />
      <HoverBorderRing active={hovered && !props.disabled} />
    </span>
  )
}

export { Textarea }
