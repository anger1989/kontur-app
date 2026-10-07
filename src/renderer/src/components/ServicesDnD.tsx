import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import { toast } from '@/components/ui/toast'
import type { EnvConfig, ServiceConfig } from '@shared/types'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { EnvDot } from '@/components/EnvDot'
import { ServiceIcon } from '@/components/ServiceIcon'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'

function sortedServices(all: ServiceConfig[], envId: string): ServiceConfig[] {
  return [...all]
    // Временные вкладки чужих сайтов в настройках не показываем: настраивать
    // в них нечего, а закрываются они вместе с окном.
    .filter((s) => s.envId === envId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'))
}

function listsFromConfig(services: ServiceConfig[], envIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const id of envIds) {
    out[id] = sortedServices(services, id).map((s) => s.id)
  }
  return out
}

function findContainer(
  id: UniqueIdentifier,
  lists: Record<string, string[]>
): string | undefined {
  if (id in lists) return String(id)
  return Object.keys(lists).find((key) => lists[key]!.includes(String(id)))
}

function SortableServiceRow({
  service,
  open,
  onToggleOpen,
  onToggleEnabled,
  children
}: {
  service: ServiceConfig
  open: boolean
  onToggleOpen: () => void
  onToggleEnabled: (v: boolean) => void
  children?: ReactNode
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: service.id,
    data: { type: 'service', envId: service.envId }
  })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Сам ряд оставляем «дыркой» — карточку тащим через DragOverlay в portal.
        opacity: isDragging ? 0.25 : 1
      }}
      className="border-b last:border-b-0"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleOpen}
        onKeyDown={(e) => e.key === 'Enter' && onToggleOpen()}
        className="flex cursor-pointer items-center gap-2 px-3 py-3 transition-colors hover:bg-accent/50 sm:gap-3 sm:px-4"
      >
        <button
          type="button"
          title="Перетащить"
          className="flex shrink-0 cursor-grab touch-none rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <span className="shrink-0 text-muted-foreground">
          <ServiceIcon serviceId={service.id} kind={service.kind} size={16} />
        </span>
        <div className="grid min-w-0 flex-1">
          <span className="truncate text-[13px] font-medium">{service.name}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {service.baseUrl || 'адрес не задан'}
          </span>
        </div>
        <Switch
          checked={service.enabled}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={onToggleEnabled}
          aria-label={service.enabled ? 'Выключить' : 'Включить'}
        />
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
      </div>
      {open && children}
    </div>
  )
}

function EnvDropList({
  env,
  ids,
  byId,
  open,
  setOpen,
  activeId,
  renderEditor,
  onToggleEnabled
}: {
  env: EnvConfig
  ids: string[]
  byId: Map<string, ServiceConfig>
  open: string | null
  setOpen: (id: string | null) => void
  activeId: string | null
  renderEditor: (s: ServiceConfig) => ReactNode
  onToggleEnabled: (s: ServiceConfig, v: boolean) => void
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: env.id, data: { type: 'container', envId: env.id } })
  const isShared = env.id === 'shared'
  const dragging = Boolean(activeId)

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {!isShared && <EnvDot accent={env.accent} tunnel="up" />}
        {env.name}
        {isShared && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
            · не зависят от VPN
          </span>
        )}
      </h2>
      <div ref={setNodeRef}>
        <Card
          className={cn(
            'gap-0 overflow-hidden py-0 transition-colors',
            dragging && isOver && 'border-primary/50 bg-primary/[0.04] ring-1 ring-primary/35'
          )}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {ids.length === 0 ? (
              <p
                className={cn(
                  'px-4 py-8 text-center text-[12px] text-muted-foreground',
                  dragging && isOver && 'bg-primary/10 text-foreground'
                )}
              >
                Перетащи сюда сервис
              </p>
            ) : (
              ids.map((id) => {
                const s = byId.get(id)
                if (!s) return null
                return (
                  <SortableServiceRow
                    key={id}
                    service={{ ...s, envId: env.id }}
                    open={open === id}
                    onToggleOpen={() => setOpen(open === id ? null : id)}
                    onToggleEnabled={(v) => onToggleEnabled(s, v)}
                  >
                    {renderEditor(s)}
                  </SortableServiceRow>
                )
              })
            )}
          </SortableContext>
        </Card>
      </div>
    </section>
  )
}

function OverlayCard({ service }: { service: ServiceConfig }): JSX.Element {
  return (
    <div className="flex w-[min(420px,90vw)] cursor-grabbing items-center gap-3 rounded-lg border border-primary/40 bg-card px-3 py-3 shadow-2xl ring-1 ring-primary/20">
      <GripVertical className="size-4 shrink-0 text-muted-foreground" />
      <ServiceIcon serviceId={service.id} kind={service.kind} size={16} />
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-[13px] font-medium">{service.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {service.baseUrl || 'адрес не задан'}
        </span>
      </div>
    </div>
  )
}

/**
 * Списки сервисов по контурам: @dnd-kit multiple containers —
 * сортировка внутри группы и перенос между «Общими» / контурами.
 */
export function ServicesDnD({
  open,
  setOpen,
  renderEditor,
  addButton
}: {
  open: string | null
  setOpen: (id: string | null) => void
  renderEditor: (s: ServiceConfig) => ReactNode
  addButton: (env: EnvConfig) => ReactNode
}): JSX.Element {
  const config = useStore((s) => s.config)
  const saveService = useStore((s) => s.saveService)
  const reorderServices = useStore((s) => s.reorderServices)

  const envSections = useMemo(
    () =>
      [...(config?.envs ?? [])].sort((a, b) => {
        if (a.id === 'shared') return -1
        if (b.id === 'shared') return 1
        return a.name.localeCompare(b.name, 'ru')
      }),
    [config?.envs]
  )
  const envIds = useMemo(() => envSections.map((e) => e.id), [envSections])

  const byId = useMemo(() => {
    const m = new Map<string, ServiceConfig>()
    for (const s of config?.services ?? []) m.set(s.id, s)
    return m
  }, [config?.services])

  const [lists, setLists] = useState<Record<string, string[]>>(() =>
    listsFromConfig(config?.services ?? [], envIds)
  )
  const [activeId, setActiveId] = useState<string | null>(null)

  // Синхронизация с конфигом, когда не тащим. activeId намеренно не в зависимостях:
  // onDragEnd уже выставил локально верный порядок и сам обновит config после
  // сохранения — если триггерить эффект ещё и переходом activeId→null, он успевает
  // отработать ДО того, как config дойдёт до стора, и на миг откатывает список
  // к дореордерному состоянию (гонка, не влияет на то, что уляжется на диск).
  useEffect(() => {
    if (activeId) return
    setLists(listsFromConfig(config?.services ?? [], envIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.services, envIds])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const activeService = activeId ? byId.get(activeId) : undefined

  const onDragStart = (e: DragStartEvent): void => {
    setActiveId(String(e.active.id))
  }

  const onDragOver = (e: DragOverEvent): void => {
    const { active, over } = e
    if (!over) return
    const activeItem = String(active.id)
    const overId = String(over.id)

    const from = findContainer(activeItem, lists)
    const to = findContainer(overId, lists)
    if (!from || !to || from === to) return

    setLists((prev) => {
      const fromItems = prev[from] ?? []
      const toItems = prev[to] ?? []
      if (!fromItems.includes(activeItem)) return prev

      const overIsContainer = overId === to
      let toIndex = overIsContainer
        ? toItems.length
        : toItems.indexOf(overId)
      if (toIndex < 0) toIndex = toItems.length

      // Курсор в нижней половине — вставляем после.
      const overRect = over.rect
      const activeRect = active.rect.current.translated
      if (!overIsContainer && overRect && activeRect) {
        const mid = overRect.top + overRect.height / 2
        if (activeRect.top + activeRect.height / 2 > mid) toIndex += 1
      }

      return {
        ...prev,
        [from]: fromItems.filter((id) => id !== activeItem),
        [to]: [...toItems.slice(0, toIndex), activeItem, ...toItems.slice(toIndex)]
      }
    })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e
    const id = String(active.id)
    setActiveId(null)
    if (!over || !config) {
      setLists(listsFromConfig(config?.services ?? [], envIds))
      return
    }

    const overId = String(over.id)
    const fromEnv = byId.get(id)?.envId
    let toEnv = findContainer(overId, lists)
    // lists уже могли обновиться в onDragOver — берём актуальный контейнер active.
    toEnv = findContainer(id, lists) ?? toEnv
    if (!fromEnv || !toEnv) {
      setLists(listsFromConfig(config.services, envIds))
      return
    }

    // Финальная перестановка внутри контейнера (если over — сосед).
    let nextLists = lists
    const container = findContainer(id, lists)
    const overContainer = findContainer(overId, lists)
    if (container && overContainer && container === overContainer && id !== overId && overId !== container) {
      const items = lists[container] ?? []
      const oldIndex = items.indexOf(id)
      const newIndex = items.indexOf(overId)
      if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
        nextLists = { ...lists, [container]: arrayMove(items, oldIndex, newIndex) }
        setLists(nextLists)
      }
    }

    const targetIds = nextLists[toEnv] ?? []
    const prevIds = sortedServices(config.services, fromEnv).map((s) => s.id)
    const same =
      fromEnv === toEnv && prevIds.join('\0') === targetIds.join('\0')
    if (same) return

    void (async () => {
      try {
        if (fromEnv !== toEnv) {
          const svc = byId.get(id)
          if (!svc) return
          await saveService({ ...svc, envId: toEnv, order: targetIds.indexOf(id) })
          const left = nextLists[fromEnv] ?? []
          if (left.length) await reorderServices(fromEnv, left)
          const name = config.envs.find((e) => e.id === toEnv)?.name ?? toEnv
          toast.success(`«${svc.name}» → ${name}`)
        }
        await reorderServices(toEnv, targetIds)
      } catch (err) {
        toast.error(String(err))
        setLists(listsFromConfig(useStore.getState().config?.services ?? [], envIds))
      }
    })()
  }

  const onDragCancel = (): void => {
    setActiveId(null)
    setLists(listsFromConfig(config?.services ?? [], envIds))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {envSections.map((env) => (
        <div key={env.id}>
          <EnvDropList
            env={env}
            ids={lists[env.id] ?? []}
            byId={byId}
            open={open}
            setOpen={setOpen}
            activeId={activeId}
            renderEditor={renderEditor}
            onToggleEnabled={(s, v) => void saveService({ ...s, enabled: v })}
          />
          {addButton(env)}
        </div>
      ))}

      {/*
        Overlay обязан жить в document.body: плавающие окна с backdrop-blur/filter
        становятся containing block для position:fixed — иначе карточка «залипает»
        не под курсором (координаты viewport vs окно).
      */}
      {createPortal(
        <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }} style={{ zIndex: 50_000 }}>
          {activeService ? <OverlayCard service={activeService} /> : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  )
}
