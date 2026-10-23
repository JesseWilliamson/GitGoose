import { describe, expect, it } from 'vitest'
import { cellWidth, compactWidth, laneX, MAX_LANES } from '../components/GraphCell'
import { compactColumns, MESSAGE_SHARE, messageWidth, REFS_W } from './graphColumns'

describe('comfy lane spacing', () => {
  it('keeps the first four lanes where they were and packs the rest 16 px apart', () => {
    expect([0, 1, 2, 3].map((l) => laneX(l, true))).toEqual([18, 42, 66, 90])
    expect([4, 5, 6, 7].map((l) => laneX(l, true))).toEqual([110, 126, 142, 158])
    // Compact (avatar nodes) keeps 24 px for every lane.
    expect(laneX(5)).toBe(6 + 5 * 24 + 12)
  })

  it('starts the text no further right than 170 px, however many lanes are open', () => {
    expect(MAX_LANES).toBe(8)
    expect(cellWidth(2)).toBe(54)
    expect(cellWidth(4)).toBe(102)
    expect(cellWidth(8)).toBe(166)
    for (const lanes of [9, 12, 40, 500]) expect(cellWidth(lanes)).toBe(166)
    expect(cellWidth(8)).toBeLessThanOrEqual(170)
  })
})

describe('compact columns', () => {
  const PANE = 715 // a 1280 px window with Details open and the sidebar at its default width
  const GRAPH_8 = compactWidth(8)

  it('gives the message at least 40% of the row at 1280 px, even with 8 lanes', () => {
    for (const dateW of [100, 110, 200]) {
      const c = compactColumns(PANE, GRAPH_8, dateW)
      expect(messageWidth(PANE, GRAPH_8, dateW, c), `date ${dateW}`).toBeGreaterThanOrEqual(PANE * MESSAGE_SHARE)
    }
  })

  it('moves the branch pills after the message before it drops the author', () => {
    // Few lanes: the author still fits once the pills are inline.
    expect(compactColumns(PANE, compactWidth(4), 100)).toEqual({ refsW: 0, author: true, date: true, sha: false })
    // Eight lanes: the author goes too.
    expect(compactColumns(PANE, GRAPH_8, 100)).toEqual({ refsW: 0, author: false, date: true, sha: false })
  })

  it('has every column in a wide pane, and the leanest layout in a tiny one', () => {
    expect(compactColumns(1800, GRAPH_8, 100)).toEqual({ refsW: REFS_W, author: true, date: true, sha: true })
    expect(compactColumns(300, GRAPH_8, 100)).toEqual({ refsW: 0, author: false, date: false, sha: false })
  })
})
