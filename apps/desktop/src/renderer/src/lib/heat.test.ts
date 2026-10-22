import { describe, expect, it } from 'vitest'
import { heatByCommit } from './heat'

describe('heatByCommit', () => {
  it('ranks commits from oldest (0) to newest (1), evenly whatever the gaps between dates', () => {
    const h = heatByCommit([
      { hash: 'old', date: 1_000 },
      { hash: 'mid', date: 900_000 },
      { hash: 'new', date: 900_001 },
      { hash: 'old', date: 1_000 },
    ])
    expect([h.get('old'), h.get('mid'), h.get('new')]).toEqual([0, 0.5, 1])
  })

  it('gives commits with the same date the same heat, and a single commit full heat', () => {
    expect(heatByCommit([{ hash: 'a', date: 5 }, { hash: 'b', date: 5 }, { hash: 'c', date: 9 }])).toEqual(new Map([['a', 0], ['b', 0], ['c', 1]]))
    expect(heatByCommit([{ hash: 'a', date: 5 }]).get('a')).toBe(1)
  })
})
