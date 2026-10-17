import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, normalizeLayout, setCollapsed, setSize } from './layout'

describe('pane layout', () => {
  it('changes widths and collapsed state without touching the other side', () => {
    const l = setSize(setCollapsed(DEFAULT_LAYOUT, 'left', true), 'right', 401.6)
    expect(l.left).toEqual({ size: DEFAULT_LAYOUT.left.size, collapsed: true })
    expect(l.right).toEqual({ size: 402, collapsed: false })
  })

  it('repairs broken stored layouts', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout({ left: { size: 5 }, right: { size: 'x', collapsed: 'yes' } })).toEqual(DEFAULT_LAYOUT)
  })

  it('keeps the side widths of layouts saved when panes could be moved', () => {
    const old = {
      left: { panes: ['details', 'branches'], active: 'details', size: 300, collapsed: false },
      right: { panes: [], active: null, size: 420, collapsed: true },
      bottom: { panes: ['diff'], active: 'diff', size: 280, collapsed: false },
    }
    expect(normalizeLayout(old)).toEqual({ left: { size: 300, collapsed: false }, right: { size: 420, collapsed: true } })
  })
})
