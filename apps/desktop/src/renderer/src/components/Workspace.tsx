import { setCollapsed, setSize, type Slot } from '@gitgoose/shared'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useEffect, useRef } from 'react'
import { saveLayout } from '../lib/panes'
import { setting, useSetting, type RepoView } from '../lib/store'
import { ConflictWizard } from './ConflictWizard'
import { FileView } from './DiffView'
import { Graph } from './Graph'
import { CommandLogView } from './CommandLogView'
import { ReflogView } from './ReflogView'
import { ReviewView } from './ReviewView'
import { WalkthroughView } from './WalkthroughView'
import { ImpactView } from './ImpactView'
import { RecomposeView } from './RecomposeView'
import { PaneDropZones, SlotView } from './Pane'

/**
 * The repository window (ADR-010): three slots around a fixed centre. The centre is the graph
 * (or a file's diff, a review, ... that opens over it); the left, right and bottom slots hold
 * panes as tabs. Which pane is in which slot is the `layout` setting (packages/shared/src/layout.ts);
 * the dividers resize a slot (and collapse it, dragged past the minimum), and a slot with no
 * panes is not drawn at all.
 */

const MIN: Record<Slot, number> = { left: 160, right: 260, bottom: 160 }
const SEPARATOR = 'bg-border transition-colors hover:bg-primary data-[separator-state=drag]:bg-primary'

export function Workspace({ view }: { view: RepoView }) {
  const layout = useSetting('layout')
  const center = view.center.kind === 'conflicts' ? <ConflictWizard view={view} />
    : view.center.kind === 'reflog' ? <ReflogView view={view} />
    : view.center.kind === 'commands' ? <CommandLogView view={view} />
    : view.center.kind === 'review' ? <ReviewView view={view} />
    : view.center.kind === 'walkthrough' ? <WalkthroughView view={view} />
    : view.center.kind === 'impact' ? <ImpactView view={view} />
    : view.center.kind === 'recompose' ? <RecomposeView view={view} />
    : view.center.kind === 'file' ? <FileView view={view} target={view.center.target} mode={view.center.mode} />
    : <Graph view={view} />

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="workspace">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        {layout.left.panes.length > 0 && <SlotPanel slot="left" view={view} />}
        {layout.left.panes.length > 0 && <Separator id="sep-left" className={`w-px ${SEPARATOR}`} />}
        <Panel id="center" minSize={320}>
          <Group orientation="vertical" className="h-full">
            <Panel id="main" minSize={160}>
              <main className="flex h-full min-w-0 flex-col">{center}</main>
            </Panel>
            {layout.bottom.panes.length > 0 && <Separator id="sep-bottom" className={`h-px ${SEPARATOR}`} />}
            {layout.bottom.panes.length > 0 && <SlotPanel slot="bottom" view={view} />}
          </Group>
        </Panel>
        {layout.right.panes.length > 0 && <Separator id="sep-right" className={`w-px ${SEPARATOR}`} />}
        {layout.right.panes.length > 0 && <SlotPanel slot="right" view={view} />}
      </Group>
      <PaneDropZones />
    </div>
  )
}

/** A slot's panel: its size is a width (left, right) or a height (bottom) and persists per slot. */
function SlotPanel({ slot, view }: { slot: Slot; view: RepoView }) {
  const st = useSetting('layout')[slot]
  const ref = usePanelRef()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Collapse and expand when the setting changes (keyboard toggles, the palette, other windows).
  useEffect(() => {
    let frame = 0
    let tries = 0
    const apply = () => {
      const p = ref.current
      if (!p) return
      try {
        if (st.collapsed && !p.isCollapsed()) p.collapse()
        else if (!st.collapsed && p.isCollapsed()) p.expand()
        // A size set elsewhere (Reset layout) applies too; after a drag it already matches.
        if (!st.collapsed && Math.abs(p.getSize().inPixels - st.size) > 2) p.resize(st.size)
      } catch (e) {
        // A panel that has just joined a running group has no measurements for a frame or two
        // (its defaultSize is right already); try again once the group has laid it out.
        if (++tries < 10) frame = requestAnimationFrame(apply)
        else throw e
      }
    }
    apply()
    return () => cancelAnimationFrame(frame)
  }, [st.collapsed, st.size, ref])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <Panel id={slot} panelRef={ref} defaultSize={st.collapsed ? 0 : st.size} minSize={MIN[slot]} collapsible collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(_size, _id, prev) => {
        if (!prev) return // the initial measurement is not a user change
        // Persist after the drag settles; dragging past the minimum collapses the slot.
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
          saveLayout(next)
        }, 250)
      }}>
      <SlotView slot={slot} view={view} />
    </Panel>
  )
}
