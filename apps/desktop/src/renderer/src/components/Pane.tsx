import { PANE_TITLES, activatePane, type PaneId, type Slot, type SlotState } from '@gitgoose/shared'
import clsx from 'clsx'
import { useRef } from 'react'
import { changeLayout } from '../lib/panes'
import { useSetting, type RepoView } from '../lib/store'
import { AiChatActions, AiChatPanel } from './AiChatPanel'
import { DetailPanel } from './DetailPanel'
import { Sidebar } from './Sidebar'

/**
 * A column of the Browse scene: its pane's title over its body (a strip of tabs only when an older
 * layout put two panes in one column).
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
      <TabStrip slot={slot} state={st} view={view} />
      {st.panes.filter((p) => built.current.has(p)).map((p) => (
        <div key={p} className={clsx('min-h-0 flex-1 flex-col', p === st.active ? 'flex' : 'hidden')} data-pane={p}>
          <PaneBody pane={p} view={view} />
        </div>
      ))}
    </div>
  )
}

function TabStrip({ slot, state, view }: { slot: Slot; state: SlotState; view: RepoView }) {
  const tabbed = state.panes.length > 1
  return (
    <div className="relative flex h-strip shrink-0 items-stretch border-b border-border bg-card" data-testid={`tabs-${slot}`}>
      {state.panes.map((p) => (
        <Tab key={p} pane={p} tabbed={tabbed} active={state.active === p} />
      ))}
      {/* The `right` slot: the active pane's own actions (the AI pane's New and History). */}
      <div className="ml-auto flex shrink-0 items-center pr-1.5" data-testid={`tabs-${slot}-actions`}><PaneActions pane={state.active} view={view} /></div>
    </div>
  )
}

/**
 * A pane's title (a tab when an older layout put two panes in one column). Panes no longer move
 * (ADR-012): each has its column, and View shows or hides it.
 */
function Tab({ pane, tabbed, active }: { pane: PaneId; tabbed: boolean; active: boolean }) {
  return (
    <div data-pane-tab={pane} data-testid={`pane-tab-${pane}`} data-active={active || undefined}
      onClick={() => changeLayout((l) => activatePane(l, pane))}
      // 2 px bottom border on every tab (transparent unless active) so choosing a tab moves nothing.
      className={clsx('flex min-w-0 cursor-default items-center gap-1 border-b-2 px-3 text-xs font-medium',
        tabbed && active ? 'border-primary text-foreground' : tabbed ? 'border-transparent text-muted-foreground hover:text-foreground' : 'border-transparent text-foreground')}>
      <span className="truncate">{PANE_TITLES[pane]}</span>
    </div>
  )
}

/** What the active pane puts at the right end of its strip: its own few actions, as icon buttons. */
function PaneActions({ pane, view }: { pane: PaneId | null; view: RepoView }) {
  switch (pane) {
    case 'ai': return <AiChatActions view={view} />
    default: return null
  }
}
