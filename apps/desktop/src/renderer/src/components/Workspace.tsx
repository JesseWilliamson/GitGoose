import { FOLD_BELOW, fold, setCollapsed, setSize, unfold, type PaneLayout, type Slot } from '@gitgoose/shared'
import { Group, Panel, Separator, useGroupRef, usePanelRef, type GroupImperativeHandle } from 'react-resizable-panels'
import { useEffect, useRef, type RefObject } from 'react'
import { changeLayout, saveLayout } from '../lib/panes'
import { setting, useSetting, type RepoView } from '../lib/store'
import { ChangesScene, ReadScene, ResolveScene } from './Scenes'
import { Graph } from './Graph'
import { CommandLogView } from './CommandLogView'
import { ReflogView } from './ReflogView'
import { ReviewView } from './ReviewView'
import { WalkthroughView } from './WalkthroughView'
import { ImpactView } from './ImpactView'
import { RecomposeView } from './RecomposeView'
import { SlotView } from './Pane'
import { BranchTable } from './BranchTable'

/**
 * The repository window shows one scene at a time (ADR-012). Browse is the reading pane of ADR-011
 * with its columns fixed: branches, the graph (or a task that takes it over: a review, the reflog,
 * recompose), Details with the selection's first file, and the AI. The dividers resize a column
 * (and collapse it, dragged past the minimum); a column with no pane is not drawn.
 */

const MIN: Record<Slot, number> = { left: 160, right: 280, farRight: 240, bottom: 160 }
const SEPARATOR = 'bg-border transition-colors hover:bg-primary data-[separator-state=drag]:bg-primary'
/** The slots that are columns, in the horizontal group with the centre. */
const COLUMNS = ['left', 'right', 'farRight'] as const

export function Workspace({ view }: { view: RepoView }) {
  // The reading scenes and Resolve take the window (ADR-012); Browse is the panes around the graph.
  if (view.scene === 'read') return <ReadScene view={view} />
  if (view.scene === 'changes') return <ChangesScene view={view} />
  if (view.scene === 'resolve') return <ResolveScene view={view} />
  return <BrowseScene view={view} />
}

function BrowseScene({ view }: { view: RepoView }) {
  const layout = useSetting('layout')
  const root = useRef<HTMLDivElement>(null)
  const columns = useGroupRef()
  useFoldWhenNarrow(root)
  // A workbench in the centre (recompose, the conflict wizard) needs the width, and Details has
  // nothing for it: Details steps aside while it is open and comes back after. Only on screen:
  // the layout is not changed, so leaving the task restores exactly what was there.
  // The branch table (B) takes the room of Details and the AI while it is open.
  const workbench = view.center.kind === 'recompose' || view.branchTable
  const shown = workbench ? { ...layout, right: { ...layout.right, collapsed: true }, ...(view.branchTable ? { farRight: { ...layout.farRight, collapsed: true } } : {}) } : layout
  useColumnWidths(columns, root, shown)
  const center = view.center.kind === 'reflog' ? <ReflogView view={view} />
    : view.center.kind === 'commands' ? <CommandLogView view={view} />
    : view.center.kind === 'review' ? <ReviewView view={view} />
    : view.center.kind === 'walkthrough' ? <WalkthroughView view={view} />
    : view.center.kind === 'impact' ? <ImpactView view={view} />
    : view.center.kind === 'recompose' ? <RecomposeView view={view} />
    : <Graph view={view} />

  return (
    <div ref={root} className="relative flex min-h-0 flex-1" data-testid="workspace">
      <Group orientation="horizontal" className="min-h-0 flex-1" groupRef={columns}>
        {layout.left.panes.length > 0 && <SlotPanel slot="left" view={view} />}
        {layout.left.panes.length > 0 && <Separator id="sep-left" className={`w-px ${SEPARATOR}`} />}
        <Panel id="center" minSize={320}>
          <main className="flex h-full min-w-0">
            <div className="flex min-w-0 flex-1 flex-col">{center}</div>
            {view.branchTable && view.center.kind === 'graph' && <BranchTable view={view} />}
          </main>
        </Panel>
        {layout.right.panes.length > 0 && <Separator id="sep-right" className={`w-px ${SEPARATOR}`} />}
        {layout.right.panes.length > 0 && <SlotPanel slot="right" view={view} held={workbench} />}
        {layout.farRight.panes.length > 0 && <Separator id="sep-farRight" className={`w-px ${SEPARATOR}`} />}
        {layout.farRight.panes.length > 0 && <SlotPanel slot="farRight" view={view} held={view.branchTable} />}
      </Group>
    </div>
  )
}

/**
 * The columns' widths and collapsed flags, applied to the group in one go: each column at its
 * stored width (0 when collapsed), the centre gets the rest. Collapsing a panel on its own lets
 * the library hand the freed width to its next neighbour, which since farRight (ADR-011) is often
 * another column, even a collapsed one, instead of the graph. Applying the whole row means the
 * screen is what the layout says, whatever changed. Retried for a few frames: a group that has
 * just mounted has no measurements yet.
 */
function useColumnWidths(group: RefObject<GroupImperativeHandle | null>, root: RefObject<HTMLDivElement | null>, layout: PaneLayout) {
  const key = COLUMNS.map((s) => `${layout[s].panes.length > 0}:${layout[s].collapsed}:${layout[s].size}`).join()
  useEffect(() => {
    let frame = 0
    let tries = 0
    const apply = () => {
      const g = group.current
      const center = root.current?.querySelector<HTMLElement>('[id="center"]')
      const now = g?.getLayout()
      const centerPx = center?.getBoundingClientRect().width ?? 0
      // Switching layouts mounts and unmounts columns, and the group learns of them a frame or two
      // later: apply only once it holds exactly the panels this layout has (a layout for other
      // panels is an error, and a column that joins late keeps the size it mounted with).
      const expected = ['center', ...COLUMNS.filter((s) => layout[s].panes.length)].sort().join()
      const settled = !!now && Object.keys(now).sort().join() === expected
      if (!g || !now?.center || !centerPx || !settled) {
        if (++tries < 10) frame = requestAnimationFrame(apply)
        return
      }
      const pxPerPct = centerPx / now.center
      const next: Record<string, number> = {}
      let used = 0
      for (const s of COLUMNS) {
        if (!layout[s].panes.length) continue
        next[s] = layout[s].collapsed ? 0 : layout[s].size / pxPerPct
        used += next[s]
      }
      next.center = Math.max(0, 100 - used)
      // Within a couple of pixels everywhere: already there (after a drag, say).
      if (Object.keys(next).every((k) => Math.abs((now[k] ?? 0) - next[k]!) * pxPerPct < 2)) return
      try {
        g.setLayout(next)
      } catch {
        if (++tries < 10) frame = requestAnimationFrame(apply)
      }
    }
    apply()
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by `key`: the columns' part of the layout
  }, [key, group, root])
}

/**
 * Four columns need about FOLD_BELOW px (ADR-011). When the window becomes narrower than that,
 * the far right column folds away, so the graph and Details keep their room; when it is wide again
 * the column comes back. Only the crossing folds: a pane the user opens while the window is narrow
 * (Mod+Shift+A) stays open while they resize. The fold is part of the layout (layout.ts `fold`),
 * so a window closed narrow and opened wide unfolds too.
 */
function useFoldWhenNarrow(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    let wasWide: boolean | null = null
    const check = () => {
      const wide = el.clientWidth >= FOLD_BELOW
      if (wide) changeLayout(unfold)
      else if (wasWide !== false) changeLayout(fold)
      wasWide = wide
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [root])
}

/** A column's panel: its width persists per column. */
/** `held`: shown collapsed for a workbench, not by the user; its size changes then are not saved. */
function SlotPanel({ slot, view, held = false }: { slot: Slot; view: RepoView; held?: boolean }) {
  const st = useSetting('layout')[slot]
  const ref = usePanelRef()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <Panel id={slot} panelRef={ref} defaultSize={st.collapsed ? 0 : st.size} minSize={MIN[slot]} collapsible collapsedSize={0}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(_size, _id, prev) => {
        if (!prev || held) return // the initial measurement, or a workbench's doing: not a user change
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
