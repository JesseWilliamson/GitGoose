/**
 * Window layout as data: which panes sit in which slot, how big each slot is, and whether it is
 * collapsed. The graph always fills the centre. Moving a pane is a pure function of this data,
 * so the rules are unit-tested without any UI, and the layout persists as a setting.
 *
 * The diff is a pane too: docked in the bottom slot it opens under the graph (both visible);
 * not docked anywhere, it opens over the graph, replacing it while open.
 */

export type PaneId = 'branches' | 'details' | 'diff'
export type Slot = 'left' | 'right' | 'bottom'
export const SLOTS: Slot[] = ['left', 'right', 'bottom']
export const PANES: PaneId[] = ['branches', 'details', 'diff']

export interface SlotState {
  panes: PaneId[]
  /** Selected tab when the slot holds several panes. */
  active: PaneId | null
  /** Width (left, right) or height (bottom) in CSS px. */
  size: number
  collapsed: boolean
}

export type PaneLayout = Record<Slot, SlotState>

export const DEFAULT_SIZES: Record<Slot, number> = { left: 224, right: 340, bottom: 280 }

export const DEFAULT_LAYOUT: PaneLayout = {
  left: { panes: ['branches'], active: 'branches', size: DEFAULT_SIZES.left, collapsed: false },
  right: { panes: ['details'], active: 'details', size: DEFAULT_SIZES.right, collapsed: false },
  bottom: { panes: [], active: null, size: DEFAULT_SIZES.bottom, collapsed: false },
}

export function slotOf(layout: PaneLayout, pane: PaneId): Slot | null {
  return SLOTS.find((s) => layout[s].panes.includes(pane)) ?? null
}

/**
 * Move a pane into a slot (as its active tab), or out of every slot with 'center' (only the diff
 * may float over the graph; the others must live somewhere). A slot the pane leaves keeps its
 * other panes; an emptied slot's size is remembered for next time.
 */
export function movePane(layout: PaneLayout, pane: PaneId, to: Slot | 'center'): PaneLayout {
  if (to === 'center' && pane !== 'diff') return layout
  const next = structuredClone(layout)
  for (const s of SLOTS) {
    const st = next[s]
    st.panes = st.panes.filter((p) => p !== pane)
    if (st.active === pane) st.active = st.panes[0] ?? null
  }
  if (to !== 'center') {
    const st = next[to]
    st.panes.push(pane)
    st.active = pane
    st.collapsed = false
  }
  return next
}

export function setActive(layout: PaneLayout, slot: Slot, pane: PaneId): PaneLayout {
  if (!layout[slot].panes.includes(pane)) return layout
  return { ...layout, [slot]: { ...layout[slot], active: pane } }
}

export function setCollapsed(layout: PaneLayout, slot: Slot, collapsed: boolean): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], collapsed } }
}

export function setSize(layout: PaneLayout, slot: Slot, size: number): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], size: Math.round(size) } }
}

/**
 * Repair a stored layout: unknown panes dropped, duplicates removed, branches and details put
 * back in their default slots if missing (they cannot float), sizes clamped.
 */
export function normalizeLayout(raw: unknown): PaneLayout {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_LAYOUT)
  const r = raw as Partial<Record<Slot, Partial<SlotState>>>
  const seen = new Set<PaneId>()
  const out = structuredClone(DEFAULT_LAYOUT)
  for (const s of SLOTS) {
    const st = r[s] ?? {}
    const panes: PaneId[] = []
    for (const p of Array.isArray(st.panes) ? st.panes : []) {
      // Checked one at a time, so a duplicate inside the same slot is caught too.
      if (PANES.includes(p as PaneId) && !seen.has(p as PaneId)) {
        seen.add(p as PaneId)
        panes.push(p as PaneId)
      }
    }
    out[s] = {
      panes,
      active: panes.includes(st.active as PaneId) ? (st.active as PaneId) : (panes[0] ?? null),
      size: typeof st.size === 'number' && st.size >= 80 && st.size <= 2000 ? st.size : DEFAULT_SIZES[s],
      collapsed: st.collapsed === true,
    }
  }
  let fixed = out
  if (!seen.has('branches')) fixed = movePane(fixed, 'branches', 'left')
  if (!seen.has('details')) fixed = movePane(fixed, 'details', 'right')
  return fixed
}

/** Named presets for the View menu and palette. */
export function presetLayout(name: 'default' | 'wide-graph' | 'diff-below', current: PaneLayout): PaneLayout {
  if (name === 'default') return structuredClone(DEFAULT_LAYOUT)
  if (name === 'wide-graph') return setCollapsed(setCollapsed(current, 'left', true), 'right', true)
  return movePane(current, 'diff', 'bottom')
}
