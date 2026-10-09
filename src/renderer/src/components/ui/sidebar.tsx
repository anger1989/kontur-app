import { createContext, useContext, useMemo, useState, type Dispatch, type JSX, type ReactNode, type SetStateAction } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarContextProps {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  animate: boolean
}

const SidebarContext = createContext<SidebarContextProps | undefined>(undefined)

export function useSidebar(): SidebarContextProps {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider')
  return context
}

export function SidebarProvider({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true
}: {
  children: ReactNode
  open?: boolean
  setOpen?: Dispatch<SetStateAction<boolean>>
  animate?: boolean
}): JSX.Element {
  const [openState, setOpenState] = useState(false)
  const open = openProp !== undefined ? openProp : openState
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState
  const value = useMemo(() => ({ open, setOpen, animate }), [open, setOpen, animate])

  return (
    <SidebarContext.Provider value={value}>
      {children}
    </SidebarContext.Provider>
  )
}

export function Sidebar({
  children,
  open,
  setOpen,
  animate
}: {
  children: ReactNode
  open?: boolean
  setOpen?: Dispatch<SetStateAction<boolean>>
  animate?: boolean
}): JSX.Element {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  )
}

export function SidebarBody(props: React.ComponentProps<typeof motion.div>): JSX.Element {
  return (
    <>
      <DesktopSidebar {...props} />
      <MobileSidebar {...(props as React.ComponentProps<'div'>)} />
    </>
  )
}

export function DesktopSidebar({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div>): JSX.Element {
  const { open, setOpen, animate } = useSidebar()
  return (
    <motion.div
      className={cn(
        'hidden h-full w-[220px] shrink-0 flex-col bg-neutral-100 px-3 py-3 md:flex dark:bg-neutral-800/80',
        className
      )}
      animate={{
        width: animate ? (open ? 220 : 60) : 220
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      {...props}
    >
      {children}
    </motion.div>
  )
}

export function MobileSidebar({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>): JSX.Element {
  const { open, setOpen } = useSidebar()
  return (
    <>
      <div
        className="flex h-10 w-full flex-row items-center justify-between bg-neutral-100 px-3 md:hidden dark:bg-neutral-800/80"
        {...props}
      >
        <div className="z-20 flex w-full justify-end">
          <Menu
            className="cursor-pointer text-neutral-800 dark:text-neutral-200"
            onClick={() => setOpen(!open)}
          />
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ x: '-100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '-100%', opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className={cn(
                'fixed inset-0 z-[100] flex h-full w-full flex-col justify-between bg-white p-8 dark:bg-neutral-900',
                className
              )}
            >
              <div
                className="absolute top-8 right-8 z-50 cursor-pointer text-neutral-800 dark:text-neutral-200"
                onClick={() => setOpen(false)}
              >
                <X />
              </div>
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

export interface SidebarItem {
  label: string
  icon: ReactNode
  onClick?: () => void
  active?: boolean
  badge?: string | number
}

/** Пункт сайдбара — кнопка, не ссылка (у нас окна, не роутер). */
export function SidebarLink({
  item,
  className
}: {
  item: SidebarItem
  className?: string
}): JSX.Element {
  const { open, animate } = useSidebar()
  return (
    <button
      type="button"
      onClick={item.onClick}
      title={item.label}
      className={cn(
        'group/sidebar flex w-full items-center justify-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
        item.active
          ? 'bg-neutral-200 dark:bg-neutral-700'
          : 'hover:bg-neutral-200/70 dark:hover:bg-neutral-700/70',
        className
      )}
    >
      {item.icon}
      <motion.span
        animate={{
          display: animate ? (open ? 'inline-block' : 'none') : 'inline-block',
          opacity: animate ? (open ? 1 : 0) : 1
        }}
        className="m-0! inline-block p-0! text-sm whitespace-pre text-neutral-700 transition duration-150 group-hover/sidebar:translate-x-1 dark:text-neutral-200"
      >
        {item.label}
      </motion.span>
      {item.badge != null && item.badge !== '' && item.badge !== 0 ? (
        <motion.span
          animate={{
            display: animate ? (open ? 'inline-flex' : 'none') : 'inline-flex',
            opacity: animate ? (open ? 1 : 0) : 1
          }}
          className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary tabular-nums"
        >
          {item.badge}
        </motion.span>
      ) : null}
    </button>
  )
}
