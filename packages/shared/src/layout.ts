/**
 * Window layout as data (ADR-010, ADR-011). The window has four slots around a fixed centre:
 * `left`, `right` and `farRight` (widths, `farRight` outside `right`) and `bottom` (a height, under
 * the graph). Each slot holds an ordered list of
 * panes, one of them active, shown as tabs. Which pane lives where is the user's choice; a pane
 * in no slot is hidden. Everything here is a pure function from layout to layout, so the
 * renderer only renders it and the tests can state every rule. Kept as plain data so it persists
 * as one setting and is repaired on read.
 */

export type Slot = 'left' | 'right' | 'farRight' | 'bottom'
export const SLOTS: Slot[] = ['left', 'right', 'farRight', 'bottom']

/** How a slot is named to the user ("Move to far right"). */
export const SLOT_TITLES: Record<Slot, string> = { left: 'left', right: 'right', farRight: 'far right', bottom: 'bottom' }

/**
 * `diff` is the file Details shows, as a pane of its own: full height in a column of its own, the
 * way an editor's main pane is. While it is in no slot (the default), Details shows the file under
 * the commit instead.
 */
export type PaneId = 'branches' | 'details' | 'ai' | 'diff'
export const PANES: PaneId[] = ['branches', 'details', 'ai', 'diff']

export const PANE_TITLES: Record<PaneId, string> = { branches: 'Branches', details: 'Details', ai: 'AI', diff: 'Diff' }

export interface SlotState {
  /** In tab order. */
  panes: PaneId[]
  /** One of `panes`, or null when there are none. */
  active: PaneId | null
  /** Width (left, right) or height (bottom) in CSS px. */
  size: number
  collapsed: boolean
  /**
   * Collapsed by the window being narrow, not by the user (see `fold`): it opens again by itself
   * when the window is wide again. Absent otherwise.
   */
  folded?: true
}

export type PaneLayout = Record<Slot, SlotState>

/** `right` holds Details with the file's diff under it (ADR-011), so it is the wide one. */
export const DEFAULT_SIZES: Record<Slot, number> = { left: 224, right: 480, farRight: 320, bottom: 260 }
/** The slot a hidden pane comes back to. */
export const DEFAULT_SLOT: Record<PaneId, Slot> = { branches: 'left', details: 'right', ai: 'farRight', diff: 'farRight' }

/**
 * The reading pane (ADR-011): branches, the graph, the commit (details over its diff), the AI. Four
 * columns, so nothing you use together is a tab behind something else.
 */
export const DEFAULT_LAYOUT: PaneLayout = {
  left: { panes: ['branches'], active: 'branches', size: DEFAULT_SIZES.left, collapsed: false },
  right: { panes: ['details'], active: 'details', size: DEFAULT_SIZES.right, collapsed: false },
  farRight: { panes: ['ai'], active: 'ai', size: DEFAULT_SIZES.farRight, collapsed: false },
  bottom: { panes: [], active: null, size: DEFAULT_SIZES.bottom, collapsed: false },
}

/**
 * Arrangements to start from (Settings → Appearance → Workspace layout, and the palette). Each is
 * only a PaneLayout with a name: choosing one replaces the layout, and from there the panes move
 * and resize as always. Reset layout goes back to the chosen one. They are the options of the
 * workspace redesign brief, to live with side by side before settling on one.
 */
export type PresetId = 'reading' | 'stacks' | 'drawer' | 'tabs' | 'review' | 'history' | 'chat' | 'graph'

export interface Preset {
  label: string
  /** One line: what is where, and what it is good for. */
  description: string
  layout: PaneLayout
}

type Arrangement = Partial<Record<Slot, { panes: PaneId[]; size?: number; collapsed?: boolean }>>

/** A layout from just what differs: every slot not named is empty at its default size. */
function arrange(a: Arrangement): PaneLayout {
  const out = {} as PaneLayout
  for (const s of SLOTS) {
    const x = a[s]
    out[s] = { panes: x?.panes ?? [], active: x?.panes[0] ?? null, size: x?.size ?? DEFAULT_SIZES[s], collapsed: x?.collapsed ?? false }
  }
  return out
}

export const PRESETS: Record<PresetId, Preset> = {
  reading: {
    label: 'Reading pane',
    description: 'Branches, graph, details over the diff, AI: four columns, nothing behind a tab (option A).',
    layout: DEFAULT_LAYOUT,
  },
  stacks: {
    label: 'Two stacks',
    description: 'The graph over the AI chat on the left, details over a wide diff on the right (option B).',
    layout: arrange({ left: { panes: ['branches'], size: 208 }, right: { panes: ['details'], size: 680 }, bottom: { panes: ['ai'], size: 320 } }),
  },
  drawer: {
    label: 'AI drawer',
    description: 'Branches, graph and details as columns; the AI in a drawer under the graph, like an editor\'s terminal.',
    layout: arrange({ left: { panes: ['branches'] }, right: { panes: ['details'], size: 520 }, bottom: { panes: ['ai'], size: 240 } }),
  },
  tabs: {
    label: 'Tabs',
    description: 'Details and the AI as tabs in one column, as before the redesign (the diff stays in Details).',
    layout: arrange({ left: { panes: ['branches'] }, right: { panes: ['details', 'ai'], size: 400 } }),
  },
  review: {
    label: 'Review',
    description: 'Like an editor: a narrow graph, the commit\'s files, and the diff tall and wide beside them; the AI under the graph.',
    layout: arrange({ right: { panes: ['details'], size: 300 }, farRight: { panes: ['diff'], size: 780 }, bottom: { panes: ['ai'], size: 240 } }),
  },
  history: {
    label: 'History',
    description: 'The graph gets the room: branches and a narrow details column; the AI hidden until asked for (option C).',
    layout: arrange({ left: { panes: ['branches'] }, right: { panes: ['details'], size: 360 } }),
  },
  chat: {
    label: 'Chat',
    description: 'A narrow graph and a wide AI chat, with details as a tab behind it (option C).',
    layout: arrange({ farRight: { panes: ['ai', 'details'], size: 640 } }),
  },
  graph: {
    label: 'Graph only',
    description: 'Every side column collapsed: the graph alone, with the panes a shortcut away.',
    layout: arrange({ left: { panes: ['branches'], collapsed: true }, right: { panes: ['details'], collapsed: true }, farRight: { panes: ['ai'], collapsed: true } }),
  },
}

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[]

/** The slot a pane is in, or null when it is hidden. */
export function slotOf(layout: PaneLayout, pane: PaneId): Slot | null {
  return SLOTS.find((s) => layout[s].panes.includes(pane)) ?? null
}

/** On screen: in a slot that is not collapsed, and the slot's active tab. */
export function isPaneVisible(layout: PaneLayout, pane: PaneId): boolean {
  const s = slotOf(layout, pane)
  return !!s && !layout[s].collapsed && layout[s].active === pane
}

/**
 * Collapse or open a slot. A real change is the user's, so it forgets that the window had folded
 * the slot; setting what is already so changes nothing (the panel reporting a fold back as a
 * resize must not make the fold look like the user's).
 */
export function setCollapsed(layout: PaneLayout, slot: Slot, collapsed: boolean): PaneLayout {
  if (layout[slot].collapsed === collapsed) return layout
  return { ...layout, [slot]: { ...unfolded(layout[slot]), collapsed } }
}

/** A slot state without the window's fold mark. */
function unfolded(st: SlotState): SlotState {
  const { folded: _, ...rest } = st
  return rest
}

/**
 * Below this window width the four columns do not fit at a usable size (ADR-011): the far right
 * column folds away, and the graph and Details keep their room.
 */
export const FOLD_BELOW = 1360

/** The window became narrow: fold the far right column, remembering that it was the window's doing. */
export function fold(layout: PaneLayout): PaneLayout {
  const st = layout.farRight
  if (!st.panes.length || st.collapsed) return layout
  return { ...layout, farRight: { ...st, collapsed: true, folded: true } }
}

/** The window is wide again: open what the window folded, and nothing the user collapsed. */
export function unfold(layout: PaneLayout): PaneLayout {
  const st = layout.farRight
  if (!st.folded) return layout
  return { ...layout, farRight: { ...unfolded(st), collapsed: false } }
}

export function setSize(layout: PaneLayout, slot: Slot, size: number): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], size: Math.round(size) } }
}

/** A slot without `pane`; its active tab moves to the neighbour when it was the one removed. */
function without(st: SlotState, pane: PaneId): SlotState {
  const i = st.panes.indexOf(pane)
  if (i < 0) return st
  const panes = st.panes.filter((p) => p !== pane)
  const active = st.active === pane ? (panes[Math.min(i, panes.length - 1)] ?? null) : st.active
  return { ...st, panes, active }
}

/**
 * Put a pane in a slot, at `index` (a position in the slot's list once the pane is out of it;
 * the end by default). The pane becomes the slot's active tab and the slot opens: moving
 * something somewhere means wanting to see it there.
 */
export function movePane(layout: PaneLayout, pane: PaneId, slot: Slot, index?: number): PaneLayout {
  const out = { ...layout }
  for (const s of SLOTS) out[s] = without(out[s], pane)
  const panes = [...out[slot].panes]
  const at = index === undefined ? panes.length : Math.max(0, Math.min(panes.length, Math.round(index)))
  panes.splice(at, 0, pane)
  out[slot] = { ...unfolded(out[slot]), panes, active: pane, collapsed: false }
  return out
}

/** Reveal a pane: where it lives (opening the slot, making it the tab), or in its default slot when hidden. */
export function showPane(layout: PaneLayout, pane: PaneId): PaneLayout {
  const slot = slotOf(layout, pane)
  if (!slot) return movePane(layout, pane, DEFAULT_SLOT[pane])
  return { ...layout, [slot]: { ...unfolded(layout[slot]), active: pane, collapsed: false } }
}

/** Remove a pane from the window. It comes back with `showPane`. */
export function hidePane(layout: PaneLayout, pane: PaneId): PaneLayout {
  const out = { ...layout }
  for (const s of SLOTS) out[s] = without(out[s], pane)
  return out
}

/** Make a pane its slot's tab (a no-op for a hidden pane). */
export function activatePane(layout: PaneLayout, pane: PaneId): PaneLayout {
  const slot = slotOf(layout, pane)
  if (!slot || layout[slot].active === pane) return layout
  return { ...layout, [slot]: { ...layout[slot], active: pane } }
}

/** The graph gets the room: the side slots collapse (their panes stay). */
export function wideGraph(layout: PaneLayout): PaneLayout {
  return setCollapsed(setCollapsed(setCollapsed(layout, 'left', true), 'right', true), 'farRight', true)
}

const isPane = (x: unknown): x is PaneId => typeof x === 'string' && (PANES as string[]).includes(x)

/**
 * Repair a stored layout: every pane at most once, unknown ids dropped, a slot's active tab one
 * of its panes, bad sizes reset. Two older shapes upgrade:
 *
 * - the two-slot layout of before panes could move (`left` and `right` with only a size and
 *   collapsed): the default arrangement, with its widths;
 * - a layout from before `farRight` (ADR-011) with the AI pane still beside Details in `right`,
 *   which was the default: the AI moves out to `farRight`, and `right` widens to fit the diff. An
 *   AI pane the user had put somewhere else stays there.
 */
export function normalizeLayout(raw: unknown): PaneLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<Slot, Partial<SlotState>>>
  const hasPanes = SLOTS.some((s) => Array.isArray(r[s]?.panes))
  const seen = new Set<PaneId>()
  const out = structuredClone(DEFAULT_LAYOUT)
  for (const s of SLOTS) {
    const st = r[s] ?? {}
    let panes = out[s].panes
    if (hasPanes) {
      panes = []
      for (const p of Array.isArray(st.panes) ? st.panes : []) {
        if (isPane(p) && !seen.has(p)) {
          seen.add(p)
          panes.push(p)
        }
      }
    }
    out[s] = {
      panes,
      // The old shape had no tabs: the default arrangement's own active pane.
      active: hasPanes ? (st.active && panes.includes(st.active) ? st.active : panes[0] ?? null) : out[s].active,
      size: typeof st.size === 'number' && st.size >= 80 && st.size <= 2000 ? st.size : DEFAULT_SIZES[s],
      collapsed: st.collapsed === true,
      ...(st.folded === true && st.collapsed === true ? { folded: true as const } : {}),
    }
  }
  if (hasPanes && !r.farRight && out.right.panes.includes('details') && out.right.panes.includes('ai')) {
    out.right = {
      ...out.right,
      panes: out.right.panes.filter((p) => p !== 'ai'),
      active: out.right.active === 'ai' ? 'details' : out.right.active,
      size: Math.max(out.right.size, DEFAULT_SIZES.right),
    }
    out.farRight = { ...out.farRight, panes: ['ai'], active: 'ai' }
  }
  return out
}
