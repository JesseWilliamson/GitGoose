import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT, DEFAULT_SIZES, PANES, SLOTS, activatePane, fold, hidePane, isPaneVisible, movePane, normalizeLayout,
  setCollapsed, setSize, showPane, slotOf, unfold, wideGraph, type PaneLayout,
} from './layout'

const L = DEFAULT_LAYOUT

describe('pane layout', () => {
  it('starts as the reading pane: branches, then details, then the AI pane, each in its own column', () => {
    expect(L.left.panes).toEqual(['branches'])
    expect(L.right).toMatchObject({ panes: ['details'], active: 'details' })
    expect(L.farRight).toMatchObject({ panes: ['ai'], active: 'ai' })
    expect(L.bottom).toMatchObject({ panes: [], active: null })
    expect(PANES.map((p) => slotOf(L, p))).toEqual(['left', 'right', 'farRight'])
    // Nothing used together is a tab behind something else.
    expect(PANES.every((p) => isPaneVisible(L, p))).toBe(true)
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
    expect(l.farRight).toMatchObject({ panes: [], active: null })
  })

  it('lets the neighbour take over when the active tab leaves, and empties a slot cleanly', () => {
    const tabbed = movePane(movePane(L, 'ai', 'right'), 'details', 'right', 0)
    expect(tabbed.right).toMatchObject({ panes: ['details', 'ai'], active: 'details' })
    const l = movePane(activatePane(tabbed, 'ai'), 'ai', 'left')
    expect(l.right).toMatchObject({ panes: ['details'], active: 'details' })
    expect(l.left).toMatchObject({ panes: ['branches', 'ai'], active: 'ai' })
    const e = movePane(L, 'branches', 'bottom')
    expect(e.left).toMatchObject({ panes: [], active: null })
  })

  it('inserts at an index counted without the pane, and reorders inside a slot', () => {
    const two = movePane(L, 'ai', 'right')
    expect(two.right.panes).toEqual(['details', 'ai'])
    expect(movePane(L, 'ai', 'left', 0).left.panes).toEqual(['ai', 'branches'])
    expect(movePane(two, 'details', 'right', 1).right.panes).toEqual(['ai', 'details'])
    expect(movePane(two, 'details', 'right', 99).right.panes).toEqual(['ai', 'details'])
    expect(movePane(two, 'ai', 'right', 0).right.panes).toEqual(['ai', 'details'])
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
    const two = movePane(L, 'ai', 'right')
    const l = hidePane(two, 'details')
    expect(slotOf(l, 'details')).toBeNull()
    expect(l.right).toMatchObject({ panes: ['ai'], active: 'ai' })
    expect(hidePane(hidePane(l, 'ai'), 'ai').right).toMatchObject({ panes: [], active: null })
    expect(hidePane(L, 'branches').left.active).toBeNull()
  })

  it('shows a pane where it lives, or in its default slot when hidden', () => {
    const two = movePane(movePane(L, 'ai', 'right'), 'details', 'right')
    const inTab = showPane(setCollapsed(two, 'right', true), 'ai')
    expect(inTab.right).toMatchObject({ active: 'ai', collapsed: false })
    expect(isPaneVisible(inTab, 'ai')).toBe(true)
    expect(isPaneVisible(inTab, 'details')).toBe(false)

    const back = showPane(hidePane(L, 'ai'), 'ai')
    expect(back.farRight).toMatchObject({ panes: ['ai'], active: 'ai' })
    expect(showPane(hidePane(L, 'branches'), 'branches').left).toMatchObject({ panes: ['branches'], active: 'branches' })
  })

  it('opens the default slot of a hidden pane even when that slot is collapsed', () => {
    const l = showPane(hidePane(setCollapsed(L, 'left', true), 'branches'), 'branches')
    expect(l.left.collapsed).toBe(false)
  })

  it('activates only panes that are in a slot', () => {
    const two = movePane(movePane(L, 'ai', 'right'), 'details', 'right')
    expect(activatePane(two, 'ai').right.active).toBe('ai')
    expect(activatePane(L, 'details')).toBe(L)
    const h = hidePane(L, 'ai')
    expect(activatePane(h, 'ai')).toBe(h)
  })

  it('wideGraph collapses every side column and keeps their panes', () => {
    const l = wideGraph(L)
    expect([l.left.collapsed, l.right.collapsed, l.farRight.collapsed, l.bottom.collapsed]).toEqual([true, true, true, false])
    expect(l.right.panes).toEqual(['details'])
    expect(l.farRight.panes).toEqual(['ai'])
  })
})

describe('folding the far right column in a narrow window', () => {
  it('folds it, and unfolds only what the window folded', () => {
    const folded = fold(L)
    expect(folded.farRight).toMatchObject({ collapsed: true, folded: true })
    expect(isPaneVisible(folded, 'ai')).toBe(false)
    expect(unfold(folded)).toEqual(L)
    // Collapsed by the user: the window leaves it alone both ways.
    const mine = setCollapsed(L, 'farRight', true)
    expect(fold(mine)).toBe(mine)
    expect(unfold(mine)).toBe(mine)
    // Nothing to fold in an empty column, and nothing to unfold that was never folded.
    const empty = hidePane(L, 'ai')
    expect(fold(empty)).toBe(empty)
    expect(unfold(L)).toBe(L)
  })

  it('forgets the fold once the user acts on the column', () => {
    // Showing the AI (Mod+Shift+A) opens it for good, until the window next becomes narrow.
    expect(showPane(fold(L), 'ai').farRight).toEqual(L.farRight)
    // Dragging it open is the user's too.
    expect(setCollapsed(fold(L), 'farRight', false).farRight).toEqual(L.farRight)
    // The panel reporting the fold back (collapsed, as it already is) is not.
    const folded = fold(L)
    expect(setCollapsed(folded, 'farRight', true)).toBe(folded)
  })

  it('survives a restart, so a window opened wide again unfolds', () => {
    const stored = JSON.parse(JSON.stringify(fold(L)))
    expect(normalizeLayout(stored).farRight.folded).toBe(true)
    expect(unfold(normalizeLayout(stored))).toEqual(L)
    // A fold mark on an open column means nothing and is dropped.
    expect(normalizeLayout({ ...stored, farRight: { ...stored.farRight, collapsed: false } }).farRight.folded).toBeUndefined()
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
    expect(l.right).toEqual({ panes: ['details'], active: 'details', size: 420, collapsed: false })
    expect(l.farRight).toEqual(L.farRight)
    expect(l.bottom).toEqual(L.bottom)
  })

  // The default before ADR-011, as it was stored.
  const oldDefault = {
    left: { panes: ['branches'], active: 'branches', size: 224, collapsed: false },
    right: { panes: ['details', 'ai'], active: 'ai', size: 340, collapsed: false },
    bottom: { panes: [], active: null, size: 260, collapsed: false },
  }

  it('moves the AI pane out of Details\' slot into farRight, and widens right for the diff', () => {
    const l = normalizeLayout(oldDefault)
    expect(l.right).toEqual({ panes: ['details'], active: 'details', size: DEFAULT_SIZES.right, collapsed: false })
    expect(l.farRight).toEqual({ ...L.farRight, panes: ['ai'], active: 'ai' })
    expect(normalizeLayout({ ...oldDefault, right: { ...oldDefault.right, size: 700 } }).right.size).toBe(700)
  })

  it('leaves an AI pane the user had moved elsewhere, and does not upgrade twice', () => {
    const moved = normalizeLayout({ ...oldDefault, right: { ...oldDefault.right, panes: ['details'] }, bottom: { ...oldDefault.bottom, panes: ['ai'] } })
    expect(slotOf(moved, 'ai')).toBe('bottom')
    expect(moved.farRight.panes).toEqual([])
    // Once farRight is stored, putting the AI back beside Details is a choice, not an old layout.
    const chosen = movePane(L, 'ai', 'right')
    expect(normalizeLayout(JSON.parse(JSON.stringify(chosen)))).toEqual(chosen)
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
    const l = normalizeLayout({ left: { panes: [], size: 10 }, right: { panes: [], size: 99999 }, farRight: { panes: [] }, bottom: { panes: [], size: 200 } })
    expect([l.left.size, l.right.size, l.bottom.size]).toEqual([L.left.size, L.right.size, 200])
  })
})
