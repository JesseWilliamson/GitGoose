import { PANE_TITLES, SLOTS, activatePane, hidePane, movePane, type PaneId, type Slot, type SlotState } from '@gitgoose/shared'
import clsx from 'clsx'
import { Ellipsis } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useRef, useState, type DragEvent } from 'react'
import { PANE_MIME, changeLayout, usePaneDrag } from '../lib/panes'
import { useSetting, type RepoView } from '../lib/store'
import { AiChatPanel } from './AiChatPanel'
import { DetailPanel } from './DetailPanel'
import { Sidebar } from './Sidebar'
import { DM } from './ui'

/**
 * A slot of the workspace: a strip of tabs (one per pane, the title alone when there is only
 * one) over the active pane's body. Tabs are native drags (PANE_MIME); a tab strip takes a drop
 * and inserts where the pointer is, and the workspace's edge zones (Workspace.tsx) take a drop
 * into a slot that has no strip because it has no panes.
 */

function PaneBody({ pane, view }: { pane: PaneId; view: RepoView }) {
  switch (pane) {
    case 'branches': return <Sidebar view={view} />
    case 'details': return <DetailPanel view={view} />
    case 'ai': return <AiChatPanel view={view} />
  }
}

export function SlotView({ slot, view }: { slot: Slot; view: RepoView }) {
  const st = useSetting('layout')[slot]
  // A pane's body is built the first time its tab is in front and kept (hidden) while another
  // tab is: switching tabs must not lose a half-written commit message or a scroll position,
  // and a pane nobody has looked at costs nothing (the AI pane behind Details at startup).
  const built = useRef(new Set<PaneId>())
  if (st.active) built.current.add(st.active)
  for (const p of built.current) if (!st.panes.includes(p)) built.current.delete(p)
  return (
    <div className="flex h-full min-h-0 flex-col bg-card" data-testid={`slot-${slot}`}>
      <TabStrip slot={slot} state={st} />
      {st.panes.filter((p) => built.current.has(p)).map((p) => (
        <div key={p} className={clsx('min-h-0 flex-1 flex-col', p === st.active ? 'flex' : 'hidden')} data-pane={p}>
          <PaneBody pane={p} view={view} />
        </div>
      ))}
    </div>
  )
}

function TabStrip({ slot, state }: { slot: Slot; state: SlotState }) {
  const strip = useRef<HTMLDivElement>(null)
  /** Where a dragged tab would land: its index among the other tabs, and the x of the bar that shows it. */
  const [drop, setDrop] = useState<{ index: number; x: number } | null>(null)
  const dragging = usePaneDrag((s) => s.dragging)
  const tabbed = state.panes.length > 1

  const whereAt = (e: DragEvent): { index: number; x: number } => {
    const box = strip.current!.getBoundingClientRect()
    const tabs = [...strip.current!.querySelectorAll<HTMLElement>('[data-pane-tab]')].filter((t) => t.dataset.paneTab !== dragging)
    let index = 0
    let x = tabs.length ? tabs[0]!.getBoundingClientRect().left : box.left
    for (const t of tabs) {
      const r = t.getBoundingClientRect()
      if (e.clientX > r.left + r.width / 2) {
        index++
        x = r.right
      }
    }
    return { index, x: x - box.left }
  }

  return (
    <div ref={strip} className={clsx('relative flex h-strip shrink-0 items-stretch border-b border-border bg-background/40', drop && 'bg-primary/10')}
      data-testid={`tabs-${slot}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDrop(whereAt(e))
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null) }}
      onDrop={(e) => {
        const pane = e.dataTransfer.getData(PANE_MIME) as PaneId
        if (!pane) return
        e.preventDefault()
        const at = whereAt(e)
        setDrop(null)
        usePaneDrag.setState({ dragging: null })
        changeLayout((l) => movePane(l, pane, slot, at.index))
      }}>
      {state.panes.map((p) => (
        <Tab key={p} pane={p} slot={slot} tabbed={tabbed} active={state.active === p} />
      ))}
      {drop && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary" style={{ left: drop.x }} />}
    </div>
  )
}

function Tab({ pane, slot, tabbed, active }: { pane: PaneId; slot: Slot; tabbed: boolean; active: boolean }) {
  return (
    <div draggable data-pane-tab={pane} data-testid={`pane-tab-${pane}`} data-active={active || undefined}
      title={`${PANE_TITLES[pane]}: drag to move`}
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_MIME, pane)
        e.dataTransfer.effectAllowed = 'move'
        // After the browser has taken its drag image: changing the page in dragstart can cancel the drag.
        setTimeout(() => usePaneDrag.setState({ dragging: pane }), 0)
      }}
      onDragEnd={() => usePaneDrag.setState({ dragging: null })}
      onClick={() => changeLayout((l) => activatePane(l, pane))}
      className={clsx('group/tab flex min-w-0 cursor-default items-center gap-1 pr-1 pl-2 text-2xs font-semibold tracking-wide uppercase',
        tabbed && 'border-r border-border',
        tabbed && active ? 'bg-card text-foreground shadow-[inset_0_-2px_0_var(--primary)]' : 'text-muted-foreground hover:text-foreground')}>
      <span className="truncate">{PANE_TITLES[pane]}</span>
      <PaneMenu pane={pane} slot={slot} />
    </div>
  )
}

function PaneMenu({ pane, slot }: { pane: PaneId; slot: Slot }) {
  return (
    // React events bubble out of a portal to the component that rendered it: without this stop, a
    // click on a menu item would also reach the tab and activate it (with a stale layout).
    <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button aria-label={`${PANE_TITLES[pane]} pane menu`} data-testid={`pane-menu-${pane}`}
            className="rounded p-0.5 text-muted-foreground/70 opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 data-[state=open]:opacity-100">
            <Ellipsis size={13} />
          </button>
        </DropdownMenu.Trigger>
        <DM.Content align="end">
          {SLOTS.map((s) => (
            <DM.Item key={s} reason={s === slot ? `Already in the ${s} slot` : undefined} onSelect={() => changeLayout((l) => movePane(l, pane, s))}>Move to {s}</DM.Item>
          ))}
          <DM.Separator />
          <DM.Item onSelect={() => changeLayout((l) => hidePane(l, pane))}>Hide</DM.Item>
        </DM.Content>
      </DropdownMenu.Root>
    </span>
  )
}

/**
 * While a pane tab is in the air: a strip along the left, right and bottom edge of the workspace
 * to drop it on. They are what makes an empty slot reachable.
 */
export function PaneDropZones() {
  const dragging = usePaneDrag((s) => s.dragging)
  const [over, setOver] = useState<Slot | null>(null)
  if (!dragging) return null
  const zone = (slot: Slot, cls: string) => (
    <div key={slot} data-testid={`pane-drop-${slot}`}
      className={clsx('absolute z-30 border-primary/60 bg-primary/15 transition-colors', cls, over === slot && 'bg-primary/50')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(slot)
      }}
      onDragLeave={() => setOver((o) => (o === slot ? null : o))}
      onDrop={(e) => {
        const pane = (e.dataTransfer.getData(PANE_MIME) || dragging) as PaneId
        e.preventDefault()
        setOver(null)
        usePaneDrag.setState({ dragging: null })
        changeLayout((l) => movePane(l, pane, slot))
      }} />
  )
  return (
    <>
      {zone('left', 'inset-y-0 left-0 w-6 border-r-2')}
      {zone('right', 'inset-y-0 right-0 w-6 border-l-2')}
      {zone('bottom', 'inset-x-0 bottom-0 h-6 border-t-2')}
    </>
  )
}
