import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, movePane, normalizeLayout, presetLayout, setActive, slotOf } from './layout'

describe('pane layout', () => {
  it('moves a pane into another slot, keeping what was there as tabs', () => {
    const l = movePane(DEFAULT_LAYOUT, 'details', 'left')
    expect(l.left.panes).toEqual(['branches', 'details'])
    expect(l.left.active).toBe('details')
    expect(l.right.panes).toEqual([])
    expect(l.right.active).toBeNull()
    expect(l.right.size).toBe(DEFAULT_LAYOUT.right.size) // remembered for when something comes back
  })

  it('only the diff may float over the graph', () => {
    expect(movePane(DEFAULT_LAYOUT, 'branches', 'center')).toBe(DEFAULT_LAYOUT)
    const docked = movePane(DEFAULT_LAYOUT, 'diff', 'bottom')
    expect(slotOf(docked, 'diff')).toBe('bottom')
    expect(slotOf(movePane(docked, 'diff', 'center'), 'diff')).toBeNull()
  })

  it('moving into a collapsed slot expands it, and tabs can be switched', () => {
    let l = presetLayout('wide-graph', DEFAULT_LAYOUT)
    expect(l.left.collapsed && l.right.collapsed).toBe(true)
    l = movePane(l, 'details', 'left')
    expect(l.left.collapsed).toBe(false)
    expect(setActive(l, 'left', 'branches').left.active).toBe('branches')
    expect(setActive(l, 'left', 'diff')).toBe(l) // not in that slot
  })

  it('repairs broken stored layouts', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
    const fixed = normalizeLayout({ left: { panes: ['details', 'details', 'nope'], size: 5 }, bottom: { panes: ['diff'], active: 'x' } })
    // Duplicates and unknown panes dropped; a bad size reset; the lost branches pane restored.
    expect(fixed.left).toEqual({ panes: ['details', 'branches'], active: 'branches', size: 224, collapsed: false })
    expect(fixed.right.panes).toEqual([])
    expect(fixed.bottom.active).toBe('diff')
  })
})
