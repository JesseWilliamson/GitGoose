import { setCollapsed, setSize, type PaneLayout, type Slot } from '@gitsquid/shared'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef, type ReactNode } from 'react'
import { saveSettings, setting, useSetting, type RepoView } from '../lib/store'
import { ConflictWizard } from './ConflictWizard'
import { DetailPanel } from './DetailPanel'
import { FileView } from './DiffView'
import { Graph } from './Graph'
import { CommandLogView } from './CommandLogView'
import { ReflogView } from './ReflogView'
import { Sidebar } from './Sidebar'

/**
 * The repository window: branches on the left, the graph in the centre, details on the right.
 * The places are fixed; the dividers resize the sides (and collapse them, dragged past the
 * minimum), and the sizes persist in the `layout` setting (packages/shared/src/layout.ts).
 * A file's diff opens over the graph and closes back to it.
 */

const TITLES: Record<Slot, string> = { left: 'Branches', right: 'Details' }
const MIN: Record<Slot, number> = { left: 160, right: 260 }

function saveLayout(next: PaneLayout) {
  void saveSettings({ layout: next })
}

export function Workspace({ view }: { view: RepoView }) {
  const center = view.center.kind === 'conflicts' ? <ConflictWizard view={view} />
    : view.center.kind === 'reflog' ? <ReflogView view={view} />
    : view.center.kind === 'commands' ? <CommandLogView view={view} />
    : view.center.kind === 'file' ? <FileView view={view} target={view.center.target} mode={view.center.mode} />
    : <Graph view={view} />

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="workspace">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <SidePanel slot="left"><Sidebar view={view} /></SidePanel>
        <Separator id="sep-left" className="w-px bg-line transition-colors hover:bg-accent data-[separator-state=drag]:bg-accent" />
        <Panel id="center" minSize={320}>
          <main className="flex h-full min-w-0 flex-col">{center}</main>
        </Panel>
        <Separator id="sep-right" className="w-px bg-line transition-colors hover:bg-accent data-[separator-state=drag]:bg-accent" />
        <SidePanel slot="right"><DetailPanel view={view} /></SidePanel>
      </Group>
    </div>
  )
}

function SidePanel({ slot, children }: { slot: Slot; children: ReactNode }) {
  const st = useSetting('layout')[slot]
  const ref = usePanelRef()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Collapse and expand when the setting changes (keyboard toggles, the palette, other windows).
  useEffect(() => {
    const p = ref.current
    if (!p) return
    if (st.collapsed && !p.isCollapsed()) p.collapse()
    else if (!st.collapsed && p.isCollapsed()) p.expand()
    // A size set elsewhere (Reset panel sizes) applies too; after a drag it already matches.
    if (!st.collapsed && Math.abs(p.getSize().inPixels - st.size) > 2) p.resize(st.size)
  }, [st.collapsed, st.size, ref])

  return (
    <Panel id={slot} panelRef={ref} defaultSize={st.collapsed ? 0 : st.size} minSize={MIN[slot]} collapsible collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(_size, _id, prev) => {
        if (!prev) return // the initial measurement is not a user change
        // Persist after the drag settles; dragging past the minimum collapses the side.
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          // The size now, not the one this event carried: a collapse from the keyboard or the
          // palette may have happened since, and a stale size would undo it.
          const size = ref.current?.getSize()
          if (!size) return
          const current = setting('layout')
          const collapsed = size.inPixels < 1
          let next = setCollapsed(current, slot, collapsed)
          if (!collapsed) next = setSize(next, slot, size.inPixels)
          if (JSON.stringify(next) !== JSON.stringify(current)) saveLayout(next)
        }, 250)
      }}>
      <div className="flex h-full min-h-0 flex-col bg-panel" data-testid={`slot-${slot}`}>
        <div className="flex h-6 shrink-0 items-center border-b border-line bg-bg/40 px-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
          {TITLES[slot]}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </Panel>
  )
}

/** Keyboard and View menu: show or hide a side. */
export function toggleSlot(slot: Slot): void {
  const layout = setting('layout')
  saveLayout(setCollapsed(layout, slot, !layout[slot].collapsed))
}
