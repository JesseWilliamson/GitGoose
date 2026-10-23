# ADR-010: Panes: movable slots, tabs, and the AI pane docked

**Status:** accepted (PLAN-5 §5)

## Context

The window had three fixed places: branches on the left, the graph in the centre, details on the
right. PLAN-2 §7 designed movable, tabbed panes; Jesse later removed the moving (the layout
setting shrank to two widths and two collapsed flags) because nothing needed it.

The AI chat then arrived as an overlay on top of the right side. An overlay hides what the user
is looking at, it cannot be resized with the rest, and it has no good answer for the two
screens it is used on: a wide one wants the chat beside the graph, a laptop wants it below.

## Decision

Moving panes comes back, on purpose, as **one mechanism for every pane**, not a special case for
the AI chat.

- The window has three **slots** around a fixed centre: `left`, `right` (widths) and `bottom` (a
  height, under the graph). A slot holds an ordered list of **panes** (`branches`, `details`,
  `ai`), one of them active, shown as tabs. A pane in no slot is hidden. A slot with no panes is
  not drawn.
- **The centre does not move.** The graph (and the diff, review, conflict view... that opens over
  it) is what the app is for and the one thing every layout needs; making it a pane would add
  "where is the graph?" to every rule below for no gain. Panes arrange *around* it.
- **Layout is data.** `packages/shared/src/layout.ts`:

  ```ts
  type Slot = 'left' | 'right' | 'bottom'
  type PaneId = 'branches' | 'details' | 'ai'
  interface SlotState { panes: PaneId[]; active: PaneId | null; size: number; collapsed: boolean }
  type PaneLayout = Record<Slot, SlotState>
  ```

  Default: `left [branches]`, `right [details, ai]` (details in front), `bottom []`. Every change
  is a pure function from layout to layout (`movePane`, `showPane`, `hidePane`, `activatePane`,
  `setCollapsed`, `setSize`), with unit tests that state the rules; `normalizeLayout` repairs
  whatever is stored (each pane at most once, unknown ids dropped, `active` one of the slot's
  panes, sizes clamped) and upgrades the old two-slot shape, keeping its widths.
- **One setting.** The layout is the `layout` setting, so every window agrees and a restart
  restores it. The renderer only renders it and calls a reducer on user input
  (`lib/panes.ts`); it keeps no second copy.
- **Moving.** Each tab is a native drag (`application/x-gitgoose-pane`). While one is in the air,
  24 px drop zones appear at the left, right and bottom edges of the workspace, and every tab
  strip accepts a drop at the hovered position. Each tab also has a menu (*Move to left / right /
  bottom*, *Hide*), because a drag is not an accessible or discoverable way to do it.
- **Showing.** `showPane` reveals a pane where it lives (opening its slot, bringing its tab to the
  front) or in its default slot when hidden. Everything that used to open the AI overlay (the
  shortcut, an AI job's Open, a toast, Explain on the attention bar, a conflict note, New
  conversation) calls it. `Mod+Shift+A` shows and focuses the AI pane, and hides it when its
  message box already has the focus; `Mod+B` and `Mod+Alt+B` show or hide Branches and Details;
  `Mod+J` collapses or expands the bottom slot.
- **Collapsing is not hiding.** Dragging a divider past its minimum collapses a slot and keeps its
  panes; only *Hide* removes a pane.
- A pane that is behind another tab is built the first time it is in front and kept after that,
  so switching tabs does not lose a half-written commit message.

## Consequences

- The AI pane is part of the layout like any other: no `open` flag in the chat state, no overlay.
  Its inside is unchanged by this decision.
- A future pane (a terminal, a file tree, a code-graph view) is an id, a title and a body: the
  slots, tabs, drag, menu, persistence and shortcuts are already there.
- Dragging a pane into the slot where it already is just reorders it; moving a pane into a
  collapsed slot opens that slot.
- The cost is some more states to test, which the reducers make cheap: they are pure, and the
  e2e tests only need to check that the screen shows the data.
