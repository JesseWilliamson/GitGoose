/**
 * Window layout as data. The panes have fixed places (branches on the left, details on the
 * right, the graph in the centre, a file's diff over the graph while it is open); what the user
 * changes is each side's width and whether it is collapsed. Kept as plain data so it persists as
 * a setting and is repaired on read.
 */

export type Slot = 'left' | 'right'
export const SLOTS: Slot[] = ['left', 'right']

export interface SlotState {
  /** Width in CSS px. */
  size: number
  collapsed: boolean
}

export type PaneLayout = Record<Slot, SlotState>

export const DEFAULT_SIZES: Record<Slot, number> = { left: 224, right: 340 }

export const DEFAULT_LAYOUT: PaneLayout = {
  left: { size: DEFAULT_SIZES.left, collapsed: false },
  right: { size: DEFAULT_SIZES.right, collapsed: false },
}

export function setCollapsed(layout: PaneLayout, slot: Slot, collapsed: boolean): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], collapsed } }
}

export function setSize(layout: PaneLayout, slot: Slot, size: number): PaneLayout {
  return { ...layout, [slot]: { ...layout[slot], size: Math.round(size) } }
}

/**
 * Repair a stored layout: bad sizes reset, unknown fields dropped. Layouts saved when panes
 * could be moved between slots (they had `panes` lists and a bottom slot) keep their side widths.
 */
export function normalizeLayout(raw: unknown): PaneLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<Slot, Partial<SlotState>>>
  const out = structuredClone(DEFAULT_LAYOUT)
  for (const s of SLOTS) {
    const st = r[s] ?? {}
    out[s] = {
      size: typeof st.size === 'number' && st.size >= 80 && st.size <= 2000 ? st.size : DEFAULT_SIZES[s],
      collapsed: st.collapsed === true,
    }
  }
  return out
}
