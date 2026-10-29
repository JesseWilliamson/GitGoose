import { describe, expect, it } from 'vitest'
import { cellWidth, laneX, MAX_LANES, NARROW_GEOM, NODE_R, ROW_H } from '../components/GraphCell'

describe('graph row geometry', () => {
  it('is one line per commit: a row is h-row-lg, with room for a ring and HEAD\'s outer ring', () => {
    expect(ROW_H).toBe(28)
    // HEAD's outer ring (NODE_R + 4) stays inside the row.
    expect(2 * (NODE_R + 4)).toBeLessThan(ROW_H)
  })

  it('keeps the first four lanes 24 px apart and packs the rest 16 px apart', () => {
    expect([0, 1, 2, 3].map((l) => laneX(l))).toEqual([18, 42, 66, 90])
    expect([4, 5, 6, 7].map((l) => laneX(l))).toEqual([110, 126, 142, 158])
  })

  it('starts the text no further right than 170 px, however many lanes are open', () => {
    expect(MAX_LANES).toBe(8)
    expect(cellWidth(2)).toBe(54)
    expect(cellWidth(4)).toBe(102)
    expect(cellWidth(8)).toBe(166)
    for (const lanes of [9, 12, 40, 500]) expect(cellWidth(lanes)).toBe(166)
  })
})

describe('the narrow graph (reading scenes)', () => {
  it('is the same shape at half the pitch', () => {
    expect([0, 1, 2, 3, 4].map((l) => laneX(l, NARROW_GEOM))).toEqual([10, 22, 34, 46, 56])
    expect(cellWidth(8, NARROW_GEOM)).toBe(84)
  })
})
