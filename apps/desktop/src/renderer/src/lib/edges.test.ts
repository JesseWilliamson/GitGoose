import { describe, expect, it } from 'vitest'
import { edgePath } from './edges'

describe('edgePath', () => {
  it('draws lanes that stay put as straight lines', () => {
    expect(edgePath('pass', 18, 18, 32)).toBe('M18 0V32')
    expect(edgePath('top', 18, 18, 32)).toBe('M18 0V16')
    expect(edgePath('bottom', 18, 18, 32)).toBe('M18 16V32')
  })

  it('turns into another lane level with the node, with a rounded corner', () => {
    // A merge's second parent to the right: across from the node, then down.
    expect(edgePath('bottom', 18, 66, 32)).toBe('M18 16H58Q66 16 66 24V32')
    // A branch arriving from the right: down its lane, then across into the node.
    expect(edgePath('top', 66, 18, 32)).toBe('M66 0V8Q66 16 58 16H18')
  })

  it('never rounds more than the gap or half the row allows', () => {
    expect(edgePath('bottom', 0, 4, 32)).toBe('M0 16H0Q4 16 4 20V32')
    expect(edgePath('top', 0, 30, 10)).toBe('M0 0V0Q0 5 5 5H30')
  })
})
