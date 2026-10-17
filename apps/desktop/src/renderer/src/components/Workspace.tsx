import {
  movePane, setActive, setCollapsed, setSize, slotOf, SLOTS,
  type PaneId, type PaneLayout, type Slot,
} from '@gitsquid/shared'
import clsx from 'clsx'
import { GripVertical } from 'lucide-react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { saveSettings, setting, useSetting, type RepoView } from '../lib/store'
import { ConflictWizard } from './ConflictWizard'
import { DetailPanel } from './DetailPanel'
import { FileView } from './DiffView'
import { Graph } from './Graph'
import { Sidebar } from './Sidebar'

/**
 * The repository window: the graph in the centre, and panes in left, right and bottom slots
 * arranged by the `layout` setting (packages/shared/src/layout.ts). Dividers resize (and
 * collapse, past the minimum); pane tabs can be dragged to another slot.
 */

export const PANE_MIME = 'application/x-gitsquid-pane'
const TITLES: Record<PaneId, string> = { branches: 'Branches', details: 'Details', diff: 'Diff' }
const MIN: Record<Slot, number> = { left: 160, right: 260, bottom: 120 }

function saveLayout(next: PaneLayout) {
  void saveSettings({ layout: next })
}

export function Workspace({ view }: { view: RepoView }) {
  const layout = useSetting('layout')
  const [dragging, setDragging] = useState<PaneId | null>(null)
  const diffDocked = slotOf(layout, 'diff') !== null
  const fileOpen = view.center.kind === 'file'

  const pane = (id: PaneId): ReactNode => {
    if (id === 'branches') return <Sidebar view={view} />
    if (id === 'details') return <DetailPanel view={view} />
    return view.center.kind === 'file'
      ? <FileView view={view} target={view.center.target} mode={view.center.mode} />
      : <div className="flex h-full items-center justify-center text-sm text-faint">Click a file to see its diff here.</div>
  }

  const center = view.center.kind === 'conflicts' ? <ConflictWizard view={view} />
    : fileOpen && !diffDocked && view.center.kind === 'file' ? <FileView view={view} target={view.center.target} mode={view.center.mode} />
    : <Graph view={view} />

  // Which slots exist changes the panel tree, so remount the groups then: each panel's default
  // size (from the layout) is only read on mount.
  const shape = SLOTS.map((s) => `${s}${layout[s].panes.length ? 1 : 0}`).join('')

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="workspace"
      onDragStartCapture={(e) => {
        const id = (e.target as HTMLElement).closest('[data-pane-tab]')?.getAttribute('data-pane-tab') as PaneId | null
        if (id) setDragging(id)
      }}
      onDragEndCapture={() => setDragging(null)}>
      <Group key={`h-${shape}`} orientation="horizontal" className="min-h-0 flex-1">
        {layout.left.panes.length > 0 && (
          <>
            <SidePanel slot="left" layout={layout} render={pane} />
            <Separator id="sep-left" className="w-px bg-line transition-colors hover:bg-accent data-[separator-state=drag]:bg-accent" />
          </>
        )}
        <Panel id="center" minSize={320}>
          <Group key={`v-${shape}`} orientation="vertical" className="h-full">
            <Panel id="main" minSize={160}>
              <main className="flex h-full min-w-0 flex-col">{center}</main>
            </Panel>
            {layout.bottom.panes.length > 0 && (
              <>
                <Separator id="sep-bottom" className="h-px bg-line transition-colors hover:bg-accent data-[separator-state=drag]:bg-accent" />
                <SidePanel slot="bottom" layout={layout} render={pane} />
              </>
            )}
          </Group>
        </Panel>
        {layout.right.panes.length > 0 && (
          <>
            <Separator id="sep-right" className="w-px bg-line transition-colors hover:bg-accent data-[separator-state=drag]:bg-accent" />
            <SidePanel slot="right" layout={layout} render={pane} />
          </>
        )}
      </Group>
      {dragging && <DropZones pane={dragging} layout={layout} done={() => setDragging(null)} />}
    </div>
  )
}

function SidePanel({ slot, layout, render }: { slot: Slot; layout: PaneLayout; render: (id: PaneId) => ReactNode }) {
  const st = layout[slot]
  const ref = usePanelRef()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Collapse and expand when the setting changes (toolbar toggles, presets, other windows).
  useEffect(() => {
    const p = ref.current
    if (!p) return
    if (st.collapsed && !p.isCollapsed()) p.collapse()
    else if (!st.collapsed && p.isCollapsed()) p.expand()
  }, [st.collapsed, ref])

  return (
    <Panel id={slot} panelRef={ref} defaultSize={st.collapsed ? 0 : st.size} minSize={MIN[slot]} collapsible collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(size, _id, prev) => {
        if (!prev) return // the initial measurement is not a user change
        // Persist after the drag settles; dragging past the minimum collapses the slot.
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          const current = setting('layout')
          const collapsed = size.inPixels < 1
          let next = setCollapsed(current, slot, collapsed)
          if (!collapsed) next = setSize(next, slot, size.inPixels)
          if (JSON.stringify(next) !== JSON.stringify(current)) saveLayout(next)
        }, 250)
      }}>
      <div className="flex h-full min-h-0 flex-col bg-panel" data-testid={`slot-${slot}`}>
        <SlotHeader slot={slot} layout={layout} />
        <div className="flex min-h-0 flex-1 flex-col">{st.active && render(st.active)}</div>
      </div>
    </Panel>
  )
}

function SlotHeader({ slot, layout }: { slot: Slot; layout: PaneLayout }) {
  const st = layout[slot]
  return (
    <div className="flex h-6 shrink-0 items-stretch gap-px border-b border-line bg-bg/40 text-[11px]">
      {st.panes.map((p) => (
        <button key={p} draggable data-pane-tab={p} data-testid={`pane-tab-${p}`}
          onDragStart={(e) => {
            e.dataTransfer.setData(PANE_MIME, p)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => saveLayout(setActive(setting('layout'), slot, p))}
          title={`${TITLES[p]}: drag to move this pane`}
          className={clsx('flex cursor-grab items-center gap-1 px-2 font-semibold tracking-wide uppercase',
            st.active === p ? 'text-fg' : 'text-faint hover:text-muted')}>
          <GripVertical size={11} className="opacity-50" />
          {TITLES[p]}
        </button>
      ))}
    </div>
  )
}

/** Shown while a pane tab is dragged: where it can go. */
function DropZones({ pane, layout, done }: { pane: PaneId; layout: PaneLayout; done: () => void }) {
  const [over, setOver] = useState<string | null>(null)
  const zones: { id: Slot | 'center'; label: string; className: string }[] = [
    { id: 'left', label: 'Left', className: 'left-0 top-0 bottom-0 w-1/5' },
    { id: 'right', label: 'Right', className: 'right-0 top-0 bottom-0 w-1/5' },
    { id: 'bottom', label: 'Bottom', className: 'left-1/5 right-1/5 bottom-0 h-1/4' },
    ...(pane === 'diff' ? [{ id: 'center' as const, label: 'Over the graph', className: 'left-1/5 right-1/5 top-0 h-1/4' }] : []),
  ]
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {zones.map((z) => (
        <div key={z.id} data-testid={`drop-${z.id}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PANE_MIME)) return
            e.preventDefault()
            setOver(z.id)
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault()
            saveLayout(movePane(layout, pane, z.id))
            done()
          }}
          className={clsx('pointer-events-auto absolute flex items-center justify-center rounded-md border-2 border-dashed text-xs font-semibold transition-colors',
            z.className, over === z.id ? 'border-accent bg-accent/20 text-accent' : 'border-accent/40 bg-accent/5 text-accent/70')}>
          {z.label}
        </div>
      ))}
    </div>
  )
}

/** Toggles for the keyboard and View menu. */
export function toggleSlotOf(pane: PaneId): void {
  const layout = setting('layout')
  const slot = slotOf(layout, pane)
  if (slot) saveLayout(setCollapsed(layout, slot, !layout[slot].collapsed))
}

export function toggleBottom(): void {
  const layout = setting('layout')
  // An empty bottom slot has nothing to show: dock the diff there, which is what people want.
  if (!layout.bottom.panes.length) saveLayout(movePane(layout, 'diff', 'bottom'))
  else saveLayout(setCollapsed(layout, 'bottom', !layout.bottom.collapsed))
}

