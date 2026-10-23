import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT, PANES, SLOTS, activatePane, hidePane, isPaneVisible, movePane, normalizeLayout,
  setCollapsed, setSize, showPane, slotOf, wideGraph, type PaneLayout,
} from './layout'

const L = DEFAULT_LAYOUT

describe('pane layout', () => {
  it('starts with branches on the left, details and the AI pane on the right, nothing below', () => {
    expect(L.left.panes).toEqual(['branches'])
    expect(L.right).toMatchObject({ panes: ['details', 'ai'], active: 'details' })
    expect(L.bottom).toMatchObject({ panes: [], active: null })
    expect(PANES.map((p) => slotOf(L, p))).toEqual(['left', 'right', 'right'])
  })

  it('changes size and collapsed state of one slot only', () => {
    const l = setSize(setCollapsed(L, 'left', true), 'right', 401.6)
    expect(l.left).toEqual({ ...L.left, collapsed: true })
    expect(l.right).toEqual({ ...L.right, size: 402 })
    expect(l.bottom).toEqual(L.bottom)
  })

  it('moves a pane to another slot and makes it the active, open tab there', () => {
    const l = movePane(setCollapsed(L, 'bottom', true), 'ai', 'bottom')
    expect(l.bottom).toMatchObject({ panes: ['ai'], active: 'ai', collapsed: false })
    expect(l.right).toMatchObject({ panes: ['details'], active: 'details' })
  })

  it('lets the neighbour take over when the active tab leaves, and empties a slot cleanly', () => {
    const l = movePane(activatePane(L, 'ai'), 'ai', 'left')
    expect(l.right).toMatchObject({ panes: ['details'], active: 'details' })
    expect(l.left).toMatchObject({ panes: ['branches', 'ai'], active: 'ai' })
    const e = movePane(L, 'branches', 'bottom')
    expect(e.left).toMatchObject({ panes: [], active: null })
  })

  it('inserts at an index counted without the pane, and reorders inside a slot', () => {
    expect(movePane(L, 'ai', 'left', 0).left.panes).toEqual(['ai', 'branches'])
    expect(movePane(L, 'details', 'right', 1).right.panes).toEqual(['ai', 'details'])
    expect(movePane(L, 'details', 'right', 99).right.panes).toEqual(['ai', 'details'])
    expect(movePane(L, 'ai', 'right', 0).right.panes).toEqual(['ai', 'details'])
    expect(movePane(L, 'ai', 'left', -3).left.panes).toEqual(['ai', 'branches'])
  })

  it('does not change its input', () => {
    const before = structuredClone(L)
    movePane(L, 'ai', 'bottom')
    hidePane(L, 'ai')
    showPane(L, 'ai')
    expect(L).toEqual(before)
  })

  it('hides a pane: it is in no slot, and the slot keeps a valid active tab', () => {
    const l = hidePane(L, 'details')
    expect(slotOf(l, 'details')).toBeNull()
    expect(l.right).toMatchObject({ panes: ['ai'], active: 'ai' })
    expect(hidePane(hidePane(l, 'ai'), 'ai').right).toMatchObject({ panes: [], active: null })
    expect(hidePane(L, 'branches').left.active).toBeNull()
  })

  it('shows a pane where it lives, or in its default slot when hidden', () => {
    const inTab = showPane(setCollapsed(L, 'right', true), 'ai')
    expect(inTab.right).toMatchObject({ active: 'ai', collapsed: false })
    expect(isPaneVisible(inTab, 'ai')).toBe(true)
    expect(isPaneVisible(inTab, 'details')).toBe(false)

    const back = showPane(hidePane(L, 'ai'), 'ai')
    expect(back.right).toMatchObject({ panes: ['details', 'ai'], active: 'ai' })
    expect(showPane(hidePane(L, 'branches'), 'branches').left).toMatchObject({ panes: ['branches'], active: 'branches' })
  })

  it('opens the default slot of a hidden pane even when that slot is collapsed', () => {
    const l = showPane(hidePane(setCollapsed(L, 'left', true), 'branches'), 'branches')
    expect(l.left.collapsed).toBe(false)
  })

  it('activates only panes that are in a slot', () => {
    expect(activatePane(L, 'ai').right.active).toBe('ai')
    expect(activatePane(L, 'details')).toBe(L)
    const h = hidePane(L, 'ai')
    expect(activatePane(h, 'ai')).toBe(h)
  })

  it('wideGraph collapses both sides and keeps their panes', () => {
    const l = wideGraph(L)
    expect([l.left.collapsed, l.right.collapsed, l.bottom.collapsed]).toEqual([true, true, false])
    expect(l.right.panes).toEqual(['details', 'ai'])
  })
})

describe('normalizeLayout', () => {
  const invariants = (l: PaneLayout) => {
    const all = SLOTS.flatMap((s) => l[s].panes)
    expect(new Set(all).size).toBe(all.length)
    for (const s of SLOTS) {
      expect(l[s].active === null ? l[s].panes.length === 0 : l[s].panes.includes(l[s].active!)).toBe(true)
    }
  }

  it('repairs missing and broken layouts to the default', () => {
    expect(normalizeLayout(null)).toEqual(L)
    expect(normalizeLayout('x')).toEqual(L)
    expect(normalizeLayout({ left: { size: 5 }, right: { size: 'x', collapsed: 'yes' } })).toEqual(L)
  })

  it('upgrades the two-slot shape, keeping the side widths and collapsed state', () => {
    const l = normalizeLayout({ left: { size: 300, collapsed: true }, right: { size: 420, collapsed: false } })
    expect(l.left).toEqual({ panes: ['branches'], active: 'branches', size: 300, collapsed: true })
    expect(l.right).toEqual({ panes: ['details', 'ai'], active: 'details', size: 420, collapsed: false })
    expect(l.bottom).toEqual(L.bottom)
  })

  it('keeps a valid saved arrangement, including a hidden pane', () => {
    const saved = movePane(hidePane(L, 'branches'), 'ai', 'bottom')
    expect(normalizeLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
    expect(slotOf(normalizeLayout(saved), 'branches')).toBeNull()
  })

  it('drops unknown ids, repeats and a bad active tab', () => {
    const l = normalizeLayout({
      left: { panes: ['details', 'diff', 'details', 'branches'], active: 'ai', size: 300, collapsed: false },
      right: { panes: ['details', 'ai'], active: 'ai', size: 420, collapsed: false },
      bottom: { panes: ['diff', 7, null], active: 'diff', size: 280, collapsed: false },
    })
    expect(l.left).toMatchObject({ panes: ['details', 'branches'], active: 'details' })
    expect(l.right).toMatchObject({ panes: ['ai'], active: 'ai' })
    expect(l.bottom).toMatchObject({ panes: [], active: null })
    invariants(l)
  })

  it('clamps sizes to what is usable', () => {
    const l = normalizeLayout({ left: { panes: [], size: 10 }, right: { panes: [], size: 99999 }, bottom: { panes: [], size: 200 } })
    expect([l.left.size, l.right.size, l.bottom.size]).toEqual([L.left.size, L.right.size, 200])
  })
})
