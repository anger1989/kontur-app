import * as React from "react"
import { cn } from "@/lib/utils"

const BASE =
  "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-popover px-2.5 py-2 text-sm shadow-xs outline-none transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30"

type TextareaProps = React.ComponentProps<"textarea"> & { unstyled?: boolean }

function Textarea({ className, unstyled = false, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot={unstyled ? "textarea-control" : "textarea"}
      className={cn(unstyled ? "w-full min-w-0 resize-none bg-transparent outline-none placeholder:text-muted-foreground" : BASE, className)}
      {...props}
    />
  )
}

export { Textarea, type TextareaProps }
