import { describe, expect, it } from 'vitest'
import { hashColor } from './format'

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
