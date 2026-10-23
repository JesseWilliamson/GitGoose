/**
 * Window layout as data (ADR-010). The window has three slots around a fixed centre: `left` and
 * `right` (widths) and `bottom` (a height, under the graph). Each slot holds an ordered list of
 * panes, one of them active, shown as tabs. Which pane lives where is the user's choice; a pane
 * in no slot is hidden. Everything here is a pure function from layout to layout, so the
 * renderer only renders it and the tests can state every rule. Kept as plain data so it persists
 * as one setting and is repaired on read.
 */

export type Slot = 'left' | 'right' | 'bottom'
export const SLOTS: Slot[] = ['left', 'right', 'bottom']

export type PaneId = 'branches' | 'details' | 'ai'
export const PANES: PaneId[] = ['branches', 'details', 'ai']

export const PANE_TITLES: Record<PaneId, string> = { branches: 'Branches', details: 'Details', ai: 'AI' }

export interface SlotState {
  /** In tab order. */
  panes: PaneId[]
  /** One of `panes`, or null when there are none. */
  active: PaneId | null
  /** Width (left, right) or height (bottom) in CSS px. */
  size: number
  collapsed: boolean
}

export type PaneLayout = Record<Slot, SlotState>

export const DEFAULT_SIZES: Record<Slot, number> = { left: 224, right: 340, bottom: 260 }
/** The slot a hidden pane comes back to. */
export const DEFAULT_SLOT: Record<PaneId, Slot> = { branches: 'left', details: 'right', ai: 'right' }

export const DEFAULT_LAYOUT: PaneLayout = {
  left: { panes: ['branches'], active: 'branches', size: DEFAULT_SIZES.left, collapsed: false },
  right: { panes: ['details', 'ai'], active: 'details', size: DEFAULT_SIZES.right, collapsed: false },
  bottom: { panes: [], active: null, size: DEFAULT_SIZES.bottom, collapsed: false },
}

/** The slot a pane is in, or null when it is hidden. */
export function slotOf(layout: PaneLayout, pane: PaneId): Slot | null {
  return SLOTS.find((s) => layout[s].panes.includes(pane)) ?? null
}

/** On screen: in a slot that is not collapsed, and the slot's active tab. */
export function isPaneVisible(layout: PaneLayout, pane: PaneId): boolean {
  const s = slotOf(layout, pane)
  return !!s && !layout[s].collapsed && layout[s].active === pane
}

export function setCollapsed(layout: PaneLayout, slot: Slot, collapsed: boolean): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], collapsed } }
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
  out[slot] = { ...out[slot], panes, active: pane, collapsed: false }
  return out
}

/** Reveal a pane: where it lives (opening the slot, making it the tab), or in its default slot when hidden. */
export function showPane(layout: PaneLayout, pane: PaneId): PaneLayout {
  const slot = slotOf(layout, pane)
  if (!slot) return movePane(layout, pane, DEFAULT_SLOT[pane])
  return { ...layout, [slot]: { ...layout[slot], active: pane, collapsed: false } }
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
  return setCollapsed(setCollapsed(layout, 'left', true), 'right', true)
}

const isPane = (x: unknown): x is PaneId => typeof x === 'string' && (PANES as string[]).includes(x)

/**
 * Repair a stored layout: every pane at most once, unknown ids dropped, a slot's active tab one
 * of its panes, bad sizes reset. The two-slot layout of before panes could move (`left` and
 * `right` with only a size and collapsed) upgrades to the default arrangement with its widths.
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
    }
  }
  return out
}
