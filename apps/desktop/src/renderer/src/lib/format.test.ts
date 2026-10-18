import { describe, expect, it } from 'vitest'
import { authorLine, hashColor, sameMonth } from './format'

describe('hashColor', () => {
  it('gives different people different colours', () => {
    // These three all got colour 3 from the old h * 31 + c hash.
    const colours = ['ada@example.com', 'grace@example.com', 'alan@example.com'].map((e) => hashColor(e))
    expect(new Set(colours).size).toBe(3)
  })

  it('spreads similar strings evenly and is stable', () => {
    const counts = new Array(8).fill(0)
    for (let i = 0; i < 4000; i++) counts[hashColor(`dev${i}@example.com`)]++
    // 500 expected per colour; allow a wide margin, but no colour may be starved or flooded.
    for (const c of counts) expect(c).toBeGreaterThan(400), expect(c).toBeLessThan(600)
    expect(hashColor('ada@example.com')).toBe(hashColor('ada@example.com'))
  })
})

describe('sameMonth', () => {
  it('compares calendar months in local time, not 30-day spans', () => {
    const mar1 = new Date(2026, 2, 1, 12).getTime() / 1000
    const mar31 = new Date(2026, 2, 31, 12).getTime() / 1000
    const apr1 = new Date(2026, 3, 1, 12).getTime() / 1000
    expect(sameMonth(mar1, mar31)).toBe(true)
    expect(sameMonth(mar31, apr1)).toBe(false)
    expect(sameMonth(mar1, new Date(2025, 2, 1).getTime() / 1000)).toBe(false)
  })
})

describe('authorLine', () => {
  const people = [{ name: 'Grace Hopper' }, { name: 'Alan Turing' }, { name: 'Bob' }]
  it('is just the author when nobody else wrote the commit', () => {
    expect(authorLine('Ada Lovelace')).toBe('Ada Lovelace')
    expect(authorLine('Ada Lovelace', [])).toBe('Ada Lovelace')
  })

  it('names one or two co-authors and counts more', () => {
    expect(authorLine('Ada Lovelace', people.slice(0, 1))).toBe('Ada Lovelace and Grace Hopper')
    expect(authorLine('Ada Lovelace', people.slice(0, 2))).toBe('Ada Lovelace, Grace Hopper and Alan Turing')
    expect(authorLine('Ada Lovelace', people)).toBe('Ada Lovelace and 3 others')
  })
})
